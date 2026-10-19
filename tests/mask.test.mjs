/**
 * 账号打码的文本切分测试。
 *
 * 打码现在的语义是「整块遮住」：原始账号字符不出现在渲染结果里，
 * 只用一个按长度估算宽度的遮罩块替代。这里验证切分逻辑的边界：
 *
 *   1. 命中账号时只把账号片段标成 mask，其余文字原样保留
 *   2. 长串优先，短串不会把长串切碎后漏出后半段
 *   3. 同一句里多个账号都能遮住
 *   4. 没有命中、空文本、空清单时不做无意义切分
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/renderer/src/lib/mask.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/mask.cjs',
  logLevel: 'error'
})
const { splitByIdentifiers, containsIdentifier } = require('../.tmp/mask.cjs')

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const ids = ['github_679839', 'demo-user@example.com']
const join = (segs) => segs.map((s) => (s.kind === 'mask' ? `«${s.value}»` : s.value)).join('')

// 1. 账号命中，站点名与结果描述保持为普通文字
{
  const segs = splitByIdentifiers('AgentRouter / github_679839：签到成功 +$25', ids)
  const text = join(segs)
  ck('账号被标为遮罩段', segs.some((s) => s.kind === 'mask' && s.value === 'github_679839'), text)
  ck('站点名保持不变', text.startsWith('AgentRouter / '), text)
  ck('结果描述保持不变', text.endsWith('：签到成功 +$25'), text)
  ck(
    '普通文字段里不含账号原文',
    segs.filter((s) => s.kind === 'text').every((s) => !s.value.includes('github_679839')),
    text
  )
}

// 2. 邮箱形式的账号
{
  const segs = splitByIdentifiers('已登录 demo-user@example.com', ids)
  ck('邮箱账号被遮罩', segs.some((s) => s.kind === 'mask' && s.value === 'demo-user@example.com'), join(segs))
}

// 3. 长串优先：user 是 user_123 的前缀
{
  const segs = splitByIdentifiers('x user_123 y', ['user', 'user_123'])
  const masks = segs.filter((s) => s.kind === 'mask').map((s) => s.value)
  ck('重叠标识取最长匹配', masks.length === 1 && masks[0] === 'user_123', join(segs))
  ck('未残留 _123 尾巴', !segs.some((s) => s.kind === 'text' && s.value.includes('_123')), join(segs))
}

// 4. 同一句里出现多个账号
{
  const segs = splitByIdentifiers(
    'github_679839 与 demo-user@example.com 都已签到',
    ids
  )
  const masks = segs.filter((s) => s.kind === 'mask').map((s) => s.value)
  ck('多个账号都被遮罩', masks.length === 2, masks.join(','))
  ck('中间的连接词保留', segs.some((s) => s.kind === 'text' && s.value.includes('与')), join(segs))
}

// 5. 不命中时不切分
{
  const segs = splitByIdentifiers('DemoSite：刷新失败', ids)
  ck('无命中时原样返回单段', segs.length === 1 && segs[0].kind === 'text', join(segs))
}

// 6. 边界
ck('空文本返回空数组', splitByIdentifiers('', ids).length === 0)
ck('空标识清单返回原文', join(splitByIdentifiers('abc', [])) === 'abc')
ck('空白标识被忽略', join(splitByIdentifiers('abc', ['', '  '])) === 'abc')

// 7. containsIdentifier 用于快速判断是否需要切分
ck('能判断出包含账号', containsIdentifier('a github_679839 b', ids) === true)
ck('能判断出不包含账号', containsIdentifier('nothing here', ids) === false)
ck('空清单时不命中', containsIdentifier('abc', []) === false)

// 8. 账号出现在句首 / 句尾
{
  const head = join(splitByIdentifiers('github_679839：签到成功', ids))
  ck('句首账号也能遮', head === '«github_679839»：签到成功', head)
  const tail = join(splitByIdentifiers('签到成功 github_679839', ids))
  ck('句尾账号也能遮', tail === '签到成功 «github_679839»', tail)
}

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
process.exit(failed === 0 ? 0 : 1)
