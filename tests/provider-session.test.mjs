/**
 * 第三方登录态（GitHub / Linux DO）识别与备份测试。
 *
 * 起因（用户现场）：GitHub 账号每隔一段时间就要手动点一次「重新授权」。
 *
 * 根因有两层：
 *   1. GitHub 现在下发的是 `__Host-user_session_same_site`，而判定逻辑只认
 *      旧名字 `user_session`。于是分区里明明有登录态，也被判成「没有」，
 *      自动流程直接放弃，每天都要人工点一次。
 *   2. 分区是 Chromium 的磁盘状态，换机器 / 重装 / 清缓存就没了，
 *      即使判定正确也恢复不出来。
 *
 * 这里锁住：认哪些 Cookie、备份怎么序列化、恢复时不覆盖分区里更新的值，
 * 以及 `__Host-` 前缀必须按 host-only + Secure + Path=/ 写入。
 *
 * 纯函数测试（写回部分用假 Session），不依赖 Electron。运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/providerSession.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/provider-session.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const {
  isProviderDomain,
  parseProviderCookies,
  cookieHost
} = require('../.tmp/provider-session.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// ---- 域名白名单：只备份第三方登录域名 ----
check('github.com 算第三方登录域名', isProviderDomain('.github.com') === true)
check('linux.do 算第三方登录域名', isProviderDomain('.linux.do') === true)
check('站点自身域名不算', isProviderDomain('.agentrouter.org') === false)
check(
  '仿冒域名不算',
  isProviderDomain('.github.com.evil.test') === false
)
check('空域名不算', isProviderDomain('') === false)
check('前导点会被去掉', cookieHost('.github.com') === 'github.com')

// ---- 序列化解析 ----
const good = JSON.stringify([
  {
    name: '__Host-user_session_same_site',
    value: 'tok',
    domain: 'github.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax'
  },
  {
    name: '_t',
    value: 'forum',
    domain: '.linux.do',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax'
  }
])
check('正常备份能解析出两条', parseProviderCookies(good).length === 2, String(parseProviderCookies(good).length))

// 混入站点自身 Cookie 时必须在解析阶段丢掉，绝不能写回
const mixed = JSON.stringify([
  { name: 'session', value: 'site', domain: '.agentrouter.org', path: '/', secure: true, httpOnly: true, sameSite: 'lax' },
  { name: '__Host-user_session_same_site', value: 'tok', domain: 'github.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax' }
])
check(
  '解析时剔除站点自身 Cookie',
  parseProviderCookies(mixed).length === 1 &&
    parseProviderCookies(mixed)[0].name === '__Host-user_session_same_site',
  JSON.stringify(parseProviderCookies(mixed).map((c) => c.name))
)

check('空备份返回空数组', parseProviderCookies(undefined).length === 0)
check('空串返回空数组', parseProviderCookies('').length === 0)
check('结构损坏返回空数组', parseProviderCookies('{not json').length === 0)
check('非数组返回空数组', parseProviderCookies('{"a":1}').length === 0)
check('条目不完整时跳过', parseProviderCookies(JSON.stringify([{ name: 1 }, { value: 2 }])).length === 0)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
