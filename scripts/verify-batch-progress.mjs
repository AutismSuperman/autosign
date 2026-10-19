/**
 * 批量刷新额度的进度显示验证。
 *
 * 起因：刷新额度原先只是一串静默的串行请求，界面只有一个转圈的总按钮，
 * 18 个账号要等半分钟，看不出进度也不知道卡在哪个账号。
 *
 * 演示站点指向 example.com（不可达），单个账号会很快失败，
 * 中间态可能只存在几十毫秒。因此这里不靠 sleep 采样，而是在点击前
 * 装一个 MutationObserver，把过程中出现过的进度条文案、行高亮、
 * 「刷新中…」标签全部记录下来，结束后统一断言。
 *
 * 运行：node scripts/verify-batch-progress.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9454
const userData = join(root, '.verify-batch-user-data')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const now = Date.now()
// 演示数据全部使用 example.com 与 demo-user，不含任何真实账号
const demoConfig = {
  version: 1,
  sites: [
    {
      id: 'demo-site',
      name: 'DemoSite',
      baseUrl: 'https://demo.example.com',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'github',
      accounts: [
        { id: 'demo-a1', siteId: 'demo-site', label: 'demo-user-a', provider: 'github', createdAt: now },
        { id: 'demo-a2', siteId: 'demo-site', label: 'demo-user-b', provider: 'github', createdAt: now }
      ]
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
const rows = await ev(`document.querySelectorAll('.account-row').length`)
ck('演示账号已渲染', rows === 2, `${rows} 行`)

// 点击前开始记录：把每次 DOM 变化时的进度状态存进 window.__frames
await ev(`(() => {
  window.__frames = []
  window.__sawBar = false
  const snap = () => {
    const bar = document.querySelector('.batch-bar')
    if (!bar) return
    window.__sawBar = true
    const row = document.querySelector('.account-row.is-refreshing')
    window.__frames.push({
      text: bar.innerText.replace(/\\n/g, '|'),
      // 直接读行内 style 的百分比：getBoundingClientRect 依赖布局完成，
      // 而 Linux 上单个账号失败极快，帧可能来不及布局就被移除了
      fillPercent: bar.querySelector('.batch-fill')?.style.width || '',
      refreshedRows: document.querySelectorAll('.account-row.is-refreshing').length,
      tag: row?.querySelector('.tag.checking')?.innerText || ''
    })
  }
  window.__observer = new MutationObserver(snap)
  window.__observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true })
  return true
})()`)

await ev(`[...document.querySelectorAll('.topbar .btn')].find(b=>b.textContent.includes('刷新额度'))?.click()`)

// 等进度条出现再消失；example.com 不可达，通常很快失败
for (let i = 0; i < 60; i++) {
  if (await ev(`window.__sawBar && document.querySelectorAll('.batch-bar').length === 0`)) break
  await sleep(200)
}
await sleep(2000)

const frames = JSON.parse((await ev(`JSON.stringify(window.__frames || [])`)) || '[]')
const allText = frames.map((f) => f.text).join(' || ')
const fillPercents = frames.map((f) => f.fillPercent).filter(Boolean)
const sawFirst = frames.some((f) => f.text.includes('正在刷新 1 / 2'))
const sawSecond = frames.some((f) => f.text.includes('正在刷新 2 / 2'))
const sawCurrent = frames.some((f) => f.text.includes('DemoSite / demo-user-a'))
const sawRowTag = frames.some((f) => f.tag.includes('刷新中'))
const sawRowHighlight = frames.some((f) => f.refreshedRows === 1)

ck('刷新额度会显示批量进度条', frames.length > 0, `${frames.length} 帧`)
ck('进度从 1 / 2 开始', sawFirst, allText.slice(0, 160))
ck('进度推进到 2 / 2', sawSecond, allText.slice(-160))
ck('进度条标出当前账号', sawCurrent)
ck('正在刷新的账号行被高亮', sawRowHighlight)
ck('账号行显示「刷新中…」', sawRowTag)
// 进度条按「已完成 / 总数」推进：最后一帧应到 100%
ck(
  '进度条按完成比例推进',
  fillPercents.length > 0 && fillPercents[fillPercents.length - 1] === '100%',
  fillPercents.join(' → ')
)

const end = await ev(`JSON.stringify({
  bar: document.querySelectorAll('.batch-bar').length,
  rows: document.querySelectorAll('.account-row.is-refreshing').length,
  toast: [...document.querySelectorAll('.toast')].map(t=>t.innerText).join('|')
})`)
const endState = JSON.parse(end)
ck('结束后进度条消失', endState.bar === 0)
ck('结束后无残留行高亮', endState.rows === 0)
ck(
  '收尾提示给出成功数与总数',
  /额度已刷新：成功 \d+ \/ 2/.test(endState.toast),
  endState.toast
)

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failed === 0 ? 0 : 1)
