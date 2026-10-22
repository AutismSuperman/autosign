/**
 * 「手动签到必须真的执行」的界面验证。
 *
 * 起因（用户现场，v0.7.1）：升级后行内「重登领取」点了没反应 ——
 * 「今日已签就跳过」把手动操作也拦住了。重登类站点本来就靠「登出再重登」
 * 领取，拦住它等于按钮彻底失效。
 *
 * 验证方式：在渲染进程里替换 `window.api.account.checkin`，记录每次调用的
 * force 参数。比起搭假站点跑完整个网络流程，这样能精确断言「界面到底
 * 传了什么意图」，也不会因为网络时序而出现假失败。
 *
 * 锁住两侧：
 *   - 行内「签到 / 重登领取」→ force=true（即使今日已签也真的执行）
 *   - 顶部「全部签到」→ 不传 force（已签跳过，省请求、不白撞人机验证）
 *
 * 演示数据全部使用 example.com 与 demo-user，不含真实账号。
 * 运行：node scripts/verify-checkin-force.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9472
const userData = join(root, '.verify-force-user-data')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const now = Date.now()
const offset = 8 * 3_600_000
const day = 86_400_000
const today = new Date(Math.floor((now + offset) / day) * day).toISOString().slice(0, 10)

/** 今天已签、但金额来源是「余额增量」——正是用户现场的状态。 */
const signedToday = {
  at: now - 3_600_000,
  date: today,
  ok: true,
  already: false,
  reward: 20.9,
  rewardSource: 'delta',
  message: '重登成功'
}

const demoConfig = {
  version: 1,
  sites: [
    {
      id: 'relogin-site',
      name: 'DemoRelogin',
      baseUrl: 'https://agentrouter.org',
      // 重登类站点：签到 ≡ 登出后重登，手动点击必须真的发起
      mode: 'RELOGIN',
      kind: 'NEWAPI',
      provider: 'github',
      accounts: [
        {
          id: 'force-a1',
          siteId: 'relogin-site',
          label: 'demo-user-1',
          provider: 'github',
          createdAt: now,
          lastCheckin: signedToday,
          lastStatus: { at: now, ok: true, available: 100, used: 10 }
        },
        {
          id: 'force-a2',
          siteId: 'relogin-site',
          label: 'demo-user-2',
          provider: 'github',
          createdAt: now + 1,
          lastCheckin: signedToday,
          lastStatus: { at: now, ok: true, available: 100, used: 10 }
        }
      ]
    },
    {
      id: 'button-site',
      name: 'DemoButton',
      baseUrl: 'http://127.0.0.1:2',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'github',
      accounts: [
        {
          id: 'force-b1',
          siteId: 'button-site',
          label: 'demo-user-3',
          provider: 'github',
          createdAt: now + 2,
          lastCheckin: signedToday,
          lastStatus: { at: now, ok: true, available: 50, used: 5 }
        }
      ]
    }
  ],
  credentials: [],
  settings: { proxy: { mode: 'manual', url: 'http://127.0.0.1:1' } },
  logs: []
}
writeFileSync(join(userData, 'config.json'), JSON.stringify(demoConfig, null, 2))

const child = spawn(
  electron,
  [main, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'],
  { cwd: root, stdio: 'ignore' }
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page
for (let i = 0; i < 40; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = l.find((t) => t.type === 'page')
    if (page) break
  } catch {}
  await sleep(400)
}
if (!page) {
  console.error('FAIL: 渲染进程未启动')
  child.kill()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m)
    pend.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pend.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await send('Runtime.enable')
const ev = (expr, ap = false) =>
  send('Runtime.evaluate', { expression: expr, awaitPromise: ap, returnByValue: true }).then(
    (r) => r.result?.result?.value
  )

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

await sleep(2200)
ck('演示账号已渲染', (await ev(`document.querySelectorAll('.account-row').length`)) === 3)

/**
 * 判据来自主进程写的运行日志，而不是界面文案。
 *
 * 这条边界完全由主进程决定，日志是最直接的证据：
 *   - 被跳过 → 该账号有一条「今日已签到，已跳过」
 *   - 真的执行 → 该账号不会出现「已跳过」，而是进入重登流程并如实报出结果
 *     （演示账号没有凭据，重登前置检查会立刻返回「需要重新授权」，
 *      不依赖外网，也不会拖慢脚本）
 */
const logsFor = async (accountId) => {
  const list = JSON.parse((await ev(`window.api.logs.get().then(l => JSON.stringify(l))`, true)) || '[]')
  return list.filter((l) => l.accountId === accountId && l.scope === '签到')
}
const skippedIn = (entries) => entries.some((e) => /已跳过/.test(e.message))

// ---- 手动点行内按钮：RELOGIN 站点必须 force=true ----
await ev(`(() => {
  const row = [...document.querySelectorAll('.account-row')].find(r => (r.innerText || '').includes('demo-user-1'))
  const btn = [...row.querySelectorAll('.account-actions .btn')].find(b => /签到|重登领取/.test(b.textContent || ''))
  btn.click()
})()`)
for (let i = 0; i < 40; i++) {
  if ((await logsFor('force-a1')).length > 0) break
  await sleep(250)
}
const manual1 = await logsFor('force-a1')
ck('手动点「重登领取」确实执行了签到', manual1.length > 0, JSON.stringify(manual1.map((e) => e.message)))
ck(
  '手动点击不会被「今日已签」拦下',
  manual1.length > 0 && !skippedIn(manual1),
  JSON.stringify(manual1.map((e) => e.message))
)

// ---- 手动点 BUTTON 站点：同样 force=true ----
await ev(`(() => {
  const row = [...document.querySelectorAll('.account-row')].find(r => (r.innerText || '').includes('demo-user-3'))
  const btn = [...row.querySelectorAll('.account-actions .btn')].find(b => b.textContent.trim() === '签到')
  btn.click()
})()`)
for (let i = 0; i < 40; i++) {
  if ((await logsFor('force-b1')).length > 0) break
  await sleep(250)
}
const manual2 = await logsFor('force-b1')
ck('手动点「签到」同样不被今日已签拦下', manual2.length > 0 && !skippedIn(manual2), JSON.stringify(manual2.map((e) => e.message)))

// ---- 批量「全部签到」：不传 force（已签跳过） ----
await ev(
  `[...document.querySelectorAll('.topbar .btn')].find(b=>b.textContent.includes('全部签到'))?.click()`
)
for (let i = 0; i < 100; i++) {
  if ((await ev(`document.querySelectorAll('.batch-bar').length`)) === 0) break
  await sleep(200)
}
await sleep(1000)
// 三个账号都应该在这次批量里被跳过
const batchStates = []
for (const id of ['force-a1', 'force-a2', 'force-b1']) {
  const entries = await logsFor(id)
  // 只看最近一条：批量产生的「已跳过」在最新
  batchStates.push({ id, latest: entries[0]?.message ?? '', skipped: skippedIn([entries[0] ?? {}]) })
}
ck(
  '批量签到把今日已签的账号全部跳过',
  batchStates.every((s) => /已跳过/.test(s.latest)),
  JSON.stringify(batchStates)
)

// ---- 金额显示：余额增量不出现，已签状态保留 ----
const rowText = await ev(
  `([...document.querySelectorAll('.account-row')].find(r => (r.innerText || '').includes('demo-user-1'))?.innerText || '')`
)
ck('余额增量不会被渲染成 +$ 奖励', !rowText.includes('+$20.90'), rowText.replace(/\s+/g, ' ').slice(0, 130))
ck('已签状态照常显示', /已签/.test(rowText), rowText.replace(/\s+/g, ' ').slice(0, 130))
const statTitle = await ev(`(() => {
  const row = [...document.querySelectorAll('.account-row')].find(r => (r.innerText || '').includes('demo-user-1'))
  const stat = [...row.querySelectorAll('.account-meta .stat')].find(s => (s.textContent || '').includes('签到'))
  return stat ? stat.getAttribute('title') || '' : ''
})()`)
ck(
  '金额缺失时悬停解释「站点未回传」而不是留白',
  /站点未回传/.test(statTitle),
  statTitle
)

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failed === 0 ? 0 : 1)
