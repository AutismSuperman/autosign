/**
 * 重登签到流程测试（reloginCheckin 编排）。
 *
 * 起因：AgentRouter 的 GitHub 账号签到报「分区内会话已失效，需要重新授权」，
 * 而账号已经被登出了 —— 用户既领不到奖，还得手动重新授权，等于每天都要登录。
 *
 * 根因是流程本身：先真登出，再指望隐藏窗口靠残留 Cookie 自己登回来。
 * 但「登出」这个动作恰恰把那份 Cookie 清掉了，所以隐藏重登必然失败。
 *
 * 这里锁住三条不变量：
 *   1. 登不回来就不能登出（宁可今天不领，也不能让账号掉线）
 *   2. 登出后必须用保存的凭据重建，失败时给出可操作的「重新授权」
 *   3. 到账判据只认余额增量，不认任何 success 响应
 *
 * 纯逻辑测试：deps 全部用假实现，不依赖 Electron、不触网。
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/relogin.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/relogin-flow.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { judgeCredit, reloginCheckin } = require('../.tmp/relogin-flow.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const site = { id: 'agentrouter', name: 'AgentRouter', baseUrl: 'https://agentrouter.org', mode: 'RELOGIN' }
const account = { id: 'acc-1', siteId: 'agentrouter', label: 'demo-user', provider: 'github', createdAt: 0 }

/** 造一份可控的 deps，并记下每一步是否真的发生。 */
function makeDeps(overrides = {}) {
  const calls = { logout: 0, rebuild: 0, canRelogin: 0 }
  const balances = overrides.balances ?? [100, 125]
  let readIndex = 0
  const deps = {
    proxy: '',
    session: { readAccount: () => account, onRenewed: async () => {}, log: () => {} },
    canRelogin: async () => {
      calls.canRelogin++
      return overrides.capability ?? { ok: true }
    },
    readBalance: async () => {
      const v = balances[Math.min(readIndex, balances.length - 1)]
      readIndex++
      return v
    },
    logout: async () => {
      calls.logout++
      return overrides.logoutOk ?? true
    },
    rebuild: async () => {
      calls.rebuild++
      return overrides.rebuild ?? { ok: true }
    },
    log: () => {}
  }
  return { deps, calls }
}

// 1) 正常路径：能登回 → 登出 → 重建 → 余额达标
{
  const { deps, calls } = makeDeps()
  const r = await reloginCheckin(site, account, deps)
  check('正常路径判为到账', r.ok === true && r.reward === 25, r.message)
  check('正常路径确实登出并重建', calls.logout === 1 && calls.rebuild === 1)
}

// 2) 登不回来：绝不能登出
{
  const { deps, calls } = makeDeps({
    capability: { ok: false, error: '凭据未保存密码' }
  })
  const r = await reloginCheckin(site, account, deps)
  check('登不回来时不登出', calls.logout === 0, `logout=${calls.logout}`)
  check('登不回来时不重建', calls.rebuild === 0, `rebuild=${calls.rebuild}`)
  check('登不回来时要求人工授权', r.needVisible === true, r.message)
  check('失败原因带上「需要重新授权」', /需要重新授权/.test(r.message) && /密码/.test(r.message), r.message)
  check('失败时绝不报成功', r.ok === false)
}

// 3) 登出后重建失败：如实失败并要求重新授权
{
  const { deps, calls } = makeDeps({
    rebuild: { ok: false, error: '分区内没有 GitHub 登录态' }
  })
  const r = await reloginCheckin(site, account, deps)
  check('重建失败时确实尝试过重建', calls.rebuild === 1)
  check('重建失败判为失败', r.ok === false)
  check('重建失败要求人工授权', r.needVisible === true)
  check('重建失败原因被保留', /GitHub 登录态/.test(r.message), r.message)
}

// 4) 重建成功但余额没涨：不算到账（登录成功 ≠ 领到奖）
{
  const { deps } = makeDeps({ balances: [100, 100] })
  const r = await reloginCheckin(site, account, deps)
  check('余额未增不算到账', r.ok === false && r.reward === undefined, r.message)
  check('余额未增不要求人工授权（重登是成功的）', !r.needVisible, r.message)
}

// 5) 登出未确认也继续走重建（absent 情形），但事件要如实记录
{
  const { deps, calls } = makeDeps({ logoutOk: false })
  const r = await reloginCheckin(site, account, deps)
  check('登出未确认仍尝试重建', calls.rebuild === 1)
  check('登出未确认但到账则判成功', r.ok === true, r.message)
}

// 6) 到账判据本身：响应成功不作为依据
{
  const notCredited = judgeCredit(100, 100)
  check('余额未变判失败（不看响应 success）', notCredited.credited === false)
}

// 7) 非重登站点直接拒绝
{
  const { deps, calls } = makeDeps()
  const r = await reloginCheckin({ ...site, baseUrl: 'https://seekai.cc' }, account, deps)
  check('非 RELOGIN 站点不支持重登', r.ok === false && calls.logout === 0, r.message)
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${results.length} checks)`)
process.exit(failed.length === 0 ? 0 : 1)
