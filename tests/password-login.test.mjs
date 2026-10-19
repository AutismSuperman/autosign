/**
 * 密码登录验证。
 *
 * 用假凭据请求真实站点，确认站点返回的是「认证失败」而不是
 * 「端点不存在」或「参数无效」——后者说明请求体结构错了。
 * 这是不需要真实账号也能验证协议正确性的方法。
 *
 * 需要网络与可用代理，代理地址取自环境变量 AUTOSIGN_TEST_PROXY，
 * 未设置时走直连。网络不通时跳过联网用例而不是报失败。
 *
 * 运行：npm run test:net
 */
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/auth/passwordLogin.ts'],
  bundle: true, platform: 'node', format: 'cjs',
  outfile: '.tmp/pwlogin.cjs', external: ['electron'], logLevel: 'error'
})
const require = createRequire(import.meta.url)
const { passwordLogin, isAuthRejection, needsVerification } = require('../.tmp/pwlogin.cjs')

const PROXY = process.env.AUTOSIGN_TEST_PROXY ?? ''

const site = { id: 'agentrouter', name: 'AgentRouter', baseUrl: 'https://agentrouter.org',
  mode: 'RELOGIN', kind: 'NEWAPI', provider: 'github', accounts: [] }

const results = []
const check = (n, ok, d) => { results.push(ok); console.log(`${ok?'PASS':'FAIL'}  ${n}${d?'  ['+d+']':''}`) }

// 1) 假凭据 → 必须是明确的认证失败（网络不通时跳过）
const r1 = await passwordLogin(site, { id:'c1', provider:'password', username:'nobody_autosign_test', password:'definitely-wrong-pw', createdAt:0 }, PROXY)
const networkDown = /ECONN|ENOTFOUND|ETIMEDOUT|socket hang up|请求超时|reset/i.test(r1.error || '')
if (networkDown) {
  console.log(`SKIP  假凭据用例（网络不可达：${r1.error}）`)
} else {
  check('假凭据返回认证失败', r1.ok === false && isAuthRejection(r1.error || ''), r1.error)
  check('错误信息不含"无效的参数"', !/无效的参数/.test(r1.error || ''), r1.error)
}

// 2) 空密码 → 本地就拒绝，不发请求
const r2 = await passwordLogin(site, { id:'c2', provider:'password', username:'x', password:'', createdAt:0 }, PROXY)
check('空密码本地拒绝', r2.ok === false && /没有保存密码/.test(r2.error || ''), r2.error)

// 3) 空用户名
const r3 = await passwordLogin(site, { id:'c3', provider:'password', username:'  ', password:'x', createdAt:0 }, PROXY)
check('空用户名本地拒绝', r3.ok === false && /用户名为空/.test(r3.error || ''), r3.error)

// 4) 邮箱形式作为 username 也应被接受（返回认证失败而不是参数错误）
const r4 = await passwordLogin(site, { id:'c4', provider:'password', username:'nobody@example.com', password:'wrong', createdAt:0 }, PROXY)
if (!networkDown) {
  check('邮箱形式被接受为合法参数', !/无效的参数/.test(r4.error || ''), r4.error)
} else {
  console.log('SKIP  邮箱形式用例（网络不可达）')
}

// 5) 分类函数
check('识别中文认证失败', isAuthRejection('用户名或密码错误，或用户已被封禁') === true)
check('识别英文认证失败', isAuthRejection('Incorrect password') === true)
check('不误判网络错误', isAuthRejection('ECONNREFUSED') === false)
check('识别人机验证要求', needsVerification('turnstile token 为空') === true)
check('不误判普通错误', needsVerification('用户名或密码错误') === false)

const failed = results.filter(x => !x).length
console.log(`\n${failed===0?'ALL PASS':failed+' FAILED'} (${results.length} checks)`)
process.exit(failed === 0 ? 0 : 1)
