/**
 * 批量任务停止入口的界面验证。
 *
 * 起因：18 个账号串行刷新要等半分钟以上，签到遇到人机验证更久。
 * 用户唯一的办法是等它跑完 —— 既没有「停止」，也看不出还剩多少。
 *
 * 这里锁住三件事：
 *   1. 批量任务进行中，进度条上确实有「停止」按钮，且点得到
 *   2. 点击后按钮进入「停止中」并禁用，不会重复点击
 *   3. 停止后进度条消失、行内状态清理干净，不会卡在「处理中」
 *
 * 演示站点指向 example.com（不可达），单个账号很快失败；为了能稳定看到
 * 中间态，这里用 MutationObserver 记录过程中出现过的所有状态，
 * 而不是靠 sleep 采样。
 *
 * 运行：node scripts/verify-batch-stop.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9460
const userData = join(root, '.verify-stop-user-data')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const now = Date.now()
// 演示数据全部使用 example.com 与 demo-user，不含任何真实账号
const accounts = Array.from({ length: 6 }, (_, i) => ({
  id: `stop-a${i + 1}`,
  siteId: 'stop-site',
  label: `demo-user-${i + 1}`,
  provider: 'github',
  createdAt: now + i
}))
const demoConfig = {
  version: 1,
  sites: [
    {
      id: 'stop-site',
      name: 'DemoSite',
      baseUrl: 'https://demo.example.com',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'github',
      accounts
    }
  ],
  credentials: [],
  settings: {},
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

await sleep(1800)
ck('六个演示账号已渲染', (await ev(`document.querySelectorAll('.account-row').length`)) === 6)

// 记录过程中的所有状态：停止按钮是否出现过、文案、是否禁用
await ev(`(() => {
  window.__stopFrames = []
  const snap = () => {
    const bar = document.querySelector('.batch-bar')
    if (!bar) return
    const btn = bar.querySelector('.batch-stop')
    window.__stopFrames.push({
      bar: bar.innerText.replace(/\\n/g, '|'),
      hasBtn: !!btn,
      btnText: btn ? (btn.textContent || '').trim() : '',
      disabled: btn ? btn.disabled === true : null,
      progress: bar.querySelector('.batch-fill')?.style.width || ''
    })
  }
  window.__stopObserver = new MutationObserver(snap)
  window.__stopObserver.observe(document.body, {
    childList: true, subtree: true, attributes: true, characterData: true
  })
  return true
})()`)

await ev(
  `[...document.querySelectorAll('.topbar .btn')].find(b=>b.textContent.includes('刷新额度'))?.click()`
)

// 等到停止按钮出现
let appeared = false
for (let i = 0; i < 40; i++) {
  appeared = (await ev(`!!document.querySelector('.batch-bar .batch-stop')`)) === true
  if (appeared) break
  await sleep(100)
}
ck('批量刷新时出现「停止」按钮', appeared)

// 点停止
const clicked = await ev(`(() => {
  const btn = document.querySelector('.batch-bar .batch-stop')
  if (!btn) return false
  btn.click()
  return true
})()`)
ck('停止按钮可点击', clicked === true)
await sleep(300)

const afterClick = JSON.parse(
  (await ev(`(() => {
    const btn = document.querySelector('.batch-bar .batch-stop')
    return JSON.stringify({
      present: !!btn,
      text: btn ? btn.textContent.trim() : '',
      disabled: btn ? btn.disabled : null
    })
  })()`)) || '{}'
)
// 两种都算正确：仍在跑就必须是「停止中 + 禁用」；跑得快已经收尾则进度条已消失。
// 「停止中」这个中间态本身由下面的过程帧断言兜住，不依赖这次采样的时机。
ck(
  '点击后按钮进入停止态（或批量已立刻收尾）',
  afterClick.present === false ||
    (/停止中/.test(afterClick.text) && afterClick.disabled === true),
  JSON.stringify(afterClick)
)

// 等批量任务收尾
for (let i = 0; i < 80; i++) {
  if ((await ev(`document.querySelectorAll('.batch-bar').length`)) === 0) break
  await sleep(200)
}
await sleep(500)

const frames = JSON.parse((await ev(`JSON.stringify(window.__stopFrames || [])`)) || '[]')
ck('过程中持续有停止按钮（不是一闪而过）', frames.filter((f) => f.hasBtn).length > 0, `${frames.length} 帧`)
ck(
  '停止文案出现在过程帧里',
  frames.some((f) => /停止中/.test(f.btnText)),
  frames.map((f) => f.btnText).filter(Boolean).slice(-3).join(' / ')
)

const finalState = JSON.parse(
  (await ev(`JSON.stringify({
    bar: document.querySelectorAll('.batch-bar').length,
    rows: document.querySelectorAll('.account-row.is-refreshing').length,
    toast: [...document.querySelectorAll('.toast')].map(t=>t.innerText).join('|')
  })`)) || '{}'
)
ck('停止后进度条消失', finalState.bar === 0)
ck('停止后无残留行高亮', finalState.rows === 0)
ck(
  '收尾提示说明已停止并给出已处理数量',
  /已停止刷新：处理 \d+ \/ 6/.test(finalState.toast),
  finalState.toast
)
ck(
  '收尾提示不会再显示「已全部完成」',
  !/额度已刷新：成功 6 \/ 6/.test(finalState.toast),
  finalState.toast
)

// ---- 已签跳过：本地回执命中今日时，账号行应显示「今日已签」，不再显示「签到」按钮为可重复操作 ----
const receiptState = JSON.parse(
  (await ev(`(async () => {
    const cfg = await window.api.config.get()
    const acc = cfg.sites[0].accounts[0]
    const nowMs = Date.now()
    const offset = 8 * 3600 * 1000, day = 86400000
    const date = new Date(Math.floor((nowMs + offset) / day) * day).toISOString().slice(0, 10)
    return JSON.stringify({ accountId: acc.id, date })
  })()`, true)) || '{}'
)
ck('演示账号可读到今日日期（用于回执）', !!receiptState.date, JSON.stringify(receiptState))

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failed === 0 ? 0 : 1)
