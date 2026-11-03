/**
 * 会话重建后「第三方登录态备份」刷新时机测试。
 *
 * 起因（自查发现，非用户报告）：tryRebuildSession 里写着
 * 「失败路径同样要刷新备份」，但代码在拿到快照之前就 `return` 了 ——
 * 注释承诺的行为从未生效。这类「注释与代码不符」比没有注释更危险：
 * 后来的人会以为已经处理好了。
 *
 * 为什么必须刷新：
 *   - 静默重授权成功会轮换 GitHub 的 user_session，不刷新则备份是一份废票，
 *     下次分区丢失恢复回去必然失败 → 表现就是「每天都要手动授权」
 *   - 失败也可能是站点侧原因（WAF 拦了 state 接口），此时分区登录态仍有效，
 *     同样应该存下来
 *   - 采到空值（登录态确实没了）时必须跳过，不能把已有备份抹掉
 *
 * tryRebuildSession 依赖 Electron session，无法纯逻辑单测，
 * 因此这里对源码结构做断言，锁住「快照在前、两个分支都写回」这个顺序。
 * 运行：npm test
 */
import { readFileSync } from 'node:fs'

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const src = readFileSync('src/main/index.ts', 'utf8').replace(/\r\n/g, '\n')

// 截出 tryRebuildSession 函数体
const start = src.indexOf('async function tryRebuildSession')
const end = src.indexOf('\n}\n', start)
const fn = start >= 0 && end > start ? src.slice(start, end) : ''
check('定位到 tryRebuildSession', fn.length > 0)

if (fn) {
  const snapshotAt = fn.indexOf('snapshotProviderSession')
  const failReturnAt = fn.indexOf('if (!attempt.ok)')

  check('函数内有取快照', snapshotAt >= 0, snapshotAt >= 0 ? '' : '未找到 snapshotProviderSession')
  check('函数内有失败分支', failReturnAt >= 0)

  // 核心不变量：先取快照，再判断成败
  check(
    '快照在失败分支之前取（否则失败路径永远不刷新备份）',
    snapshotAt >= 0 && failReturnAt >= 0 && snapshotAt < failReturnAt,
    `snapshot@${snapshotAt} failReturn@${failReturnAt}`
  )

  // 失败分支必须真的写回，且要防空值覆盖
  const failBlock = fn.slice(failReturnAt, failReturnAt + 260)
  check(
    '失败分支会把快照写回账号',
    /if \(providerCookies\)\s*await patchAccount\([\s\S]{0,80}?providerCookies/.test(failBlock),
    failBlock.replace(/\s+/g, ' ').slice(0, 130)
  )

  // 成功分支同样写回（原有行为，不能改坏）
  const okBlock = fn.slice(failReturnAt)
  check(
    '成功分支仍会写回快照',
    /providerCookies \? \{ providerCookies \}/.test(okBlock)
  )

  // 两个分支都不允许无条件覆盖空值：每次写回都必须被 `if (providerCookies)`
  // 或三元展开保护，不能出现裸的 `patchAccount(..., { providerCookies })`
  const guardedFail = /if \(providerCookies\)\s*await patchAccount\([\s\S]{0,80}?providerCookies/.test(fn)
  const guardedOk = /\.\.\.\(?providerCookies \? \{ providerCookies \}/.test(fn)
  check('失败分支的写回有 if 守卫', guardedFail)
  check('成功分支的写回走三元展开', guardedOk)
  check(
    '没有未受保护的裸写回',
    !/(?<!if \(providerCookies\) )await patchAccount\(account\.id, \{ providerCookies \}\)/.test(
      fn.replace(/if \(providerCookies\) await patchAccount\(account\.id, \{ providerCookies \}\)/, 'GUARDED')
    )
  )
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
