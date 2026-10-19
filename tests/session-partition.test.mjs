/**
 * 会话复用测试。
 *
 * 目标：「登录一次之后就不用再管」。
 *
 * 关键前提是所有环节共用一个「站点 × 账号」分区：
 *   - OAuth 授权把 GitHub / 站点会话写进分区
 *   - 额度读取、签到、Turnstile 读同一份 Cookie
 *   - 重登复用同一份会话
 *
 * 早期 OAuth 用 auth-<site>-<account>、签到用 checkin-<site>_<account>，
 * 两套分区互不相通，授权拿到的会话签到时根本看不到，于是每次都要重新授权。
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/partition.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/partition.cjs',
  logLevel: 'error'
})

const { accountPartition } = require('../.tmp/partition.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const a = accountPartition('agentrouter', '1837ad82-307b-47a2-8526-2366cf1086d5')
const b = accountPartition('seekai', '1837ad82-307b-47a2-8526-2366cf1086d5')

check('分区名带 persist: 前缀（可持久化）', a.startsWith('persist:'), a)
check('同一站点同一账号分区稳定', a === accountPartition('agentrouter', '1837ad82-307b-47a2-8526-2366cf1086d5'))
check('不同站点分区不同', a !== b, `${a.slice(0, 40)}… vs ${b.slice(0, 40)}…`)
check(
  '不同账号（同站点）分区不同',
  accountPartition('agentrouter', 'id-1') !== accountPartition('agentrouter', 'id-2')
)
check('分区名不含非法字符', /^persist:[A-Za-z0-9_-]+$/.test(a), a)
check(
  '特殊字符被规范化（避免不同账号撞名）',
  accountPartition('site/a', 'acc b') === 'persist:account-site_a_acc_b',
  accountPartition('site/a', 'acc b')
)
check(
  '分隔符固定为下划线（历史上 - 与 _ 混用导致分区不通用）',
  !/^persist:account-[^_]+-[^_]+$/.test(accountPartition('a', 'b')),
  accountPartition('a', 'b')
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
