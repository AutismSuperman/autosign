/**
 * 会话重建路由测试（rebuildSession）。
 *
 * 核心问题：**GitHub 账号签到/刷新时，会话重建到底走不走静默重授权？**
 *
 * 必须走。账号的第三方登录态就落在它自己的分区里，只要那份 Cookie 还在，
 * 重走一遍 OAuth 不需要任何用户操作。如果不走而直接报「请手动重新授权」，
 * 表现就是每天都要点一次 —— 这正是用户报的问题。
 *
 * 同时锁住一条对称约束：reloginCapability 说「能登回」的场景，
 * rebuildSession 必须真的能做到。两者判定不一致时会出现
 * 「检查放行 → 真登出 → 重建失败 → 账号掉线」，比不签到更糟。
 *
 * 纯逻辑测试：silentReauth / 密码登录都用假实现，不依赖 Electron、不触网。
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/reloginSession.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/rebuild-session.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { rebuildSession, reloginCapability } = require('../.tmp/rebuild-session.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const site = { id: 'agentrouter', name: 'AgentRouter', baseUrl: 'https://agentrouter.org' }

/** 构造账号与依赖；silentCalls 记录静默重授权是否被调用。 */
function setup({ account, credential, silent, password }) {
  const calls = { silent: [], password: 0 }
  const deps = {
    proxy: '',
    findCredential: (id) => (credential && credential.id === id ? credential : undefined),
    silentReauth: async (provider) => {
      calls.silent.push(provider)
      return silent ?? { ok: true, cookie: 'session=new', token: 'tok' }
    }
  }
  return { deps, calls }
}

// ---- 核心：GitHub 账号必须走静默重授权 ----

{
  // 绑定了 GitHub 凭据（无密码），分区登录态还在
  const account = {
    id: 'a1',
    siteId: 'agentrouter',
    label: 'demo-user',
    provider: 'github',
    credentialId: 'cred-gh',
    createdAt: 0
  }
  const credential = { id: 'cred-gh', provider: 'github', username: 'demo-user' }
  const { deps, calls } = setup({ account, credential })
  const r = await rebuildSession(site, account, deps)
  check('GitHub 账号重建会话走静默重授权', calls.silent.length === 1 && calls.silent[0] === 'github')
  check('静默重授权成功后返回新会话', r.ok === true && r.cookie === 'session=new')
}

{
  // 关键回归：没有绑定凭据，但分区里还有 GitHub 登录态
  // 旧实现这里直接失败，而 reloginCapability 却判定「能登回」→ 登出后掉线
  const account = {
    id: 'a2',
    siteId: 'agentrouter',
    label: 'demo-user-2',
    provider: 'github',
    createdAt: 0
  }
  const { deps, calls } = setup({ account, credential: undefined })
  const r = await rebuildSession(site, account, deps)

  check('无凭据的 GitHub 账号也走静默重授权', calls.silent.length === 1, `calls=${calls.silent.length}`)
  check('无凭据但登录态可用时重建成功', r.ok === true, r.error ?? '')

  // 与能力判定必须一致：能登回 ⇒ 真的能登回
  const capability = reloginCapability(undefined, true, 'github')
  check(
    '能力判定与重建实现一致（放行即真的能登回）',
    capability.ok === true && r.ok === true,
    `capability=${capability.ok} rebuild=${r.ok}`
  )
}

{
  // 凭据被删除：不该直接放弃，仍应按账号自身登录方式试静默重授权
  const account = {
    id: 'a3',
    siteId: 'agentrouter',
    label: 'demo-user-3',
    provider: 'github',
    credentialId: 'gone',
    createdAt: 0
  }
  const { deps, calls } = setup({ account, credential: undefined })
  const r = await rebuildSession(site, account, deps)
  check('凭据被删除时仍尝试静默重授权', calls.silent.length === 1, `calls=${calls.silent.length}`)
  check('凭据被删除但登录态可用则重建成功', r.ok === true, r.error ?? '')
}

{
  // Linux DO 走对应 provider，不能错送 GitHub
  const account = {
    id: 'a4',
    siteId: 'agentrouter',
    label: 'demo-user-4',
    provider: 'linuxdo',
    credentialId: 'cred-ld',
    createdAt: 0
  }
  const credential = { id: 'cred-ld', provider: 'linuxdo', username: 'demo-user-4' }
  const { deps, calls } = setup({ account, credential })
  await rebuildSession(site, account, deps)
  check('Linux DO 账号走 linuxdo 授权', calls.silent[0] === 'linuxdo', String(calls.silent[0]))
}

{
  // 静默重授权失败：如实上报，并指向「重新登录」而不是含糊其辞
  const account = {
    id: 'a5',
    siteId: 'agentrouter',
    label: 'demo-user-5',
    provider: 'github',
    credentialId: 'cred-gh',
    createdAt: 0
  }
  const credential = { id: 'cred-gh', provider: 'github', username: 'demo-user-5' }
  const { deps } = setup({
    account,
    credential,
    silent: { ok: false, error: '分区内没有 GitHub 登录态' }
  })
  const r = await rebuildSession(site, account, deps)
  check('静默重授权失败时如实返回', r.ok === false)
  check('失败原因保留真实信息', /GitHub 登录态/.test(r.error ?? ''), r.error ?? '')
  check('失败时告诉用户去重新登录', /重新登录/.test(r.error ?? ''), r.error ?? '')
}

// ---- 密码账号：不该走 OAuth ----

{
  const account = {
    id: 'a6',
    siteId: 'agentrouter',
    label: 'demo-user-6',
    provider: 'password',
    credentialId: 'cred-pw',
    createdAt: 0
  }
  const credential = { id: 'cred-pw', provider: 'password', username: 'demo-user-6', password: 'pw' }
  const { deps, calls } = setup({ account, credential })
  // 这里只验证路由：密码分支会真的去发网络请求，因此直接断言没走 OAuth
  await rebuildSession(site, account, deps).catch(() => {})
  check('密码账号不走静默重授权', calls.silent.length === 0, `calls=${calls.silent.length}`)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${results.length} checks)`)
process.exit(failed.length === 0 ? 0 : 1)
