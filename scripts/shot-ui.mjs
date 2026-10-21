/**
 * 临时截图脚本（验收用，不提交）：
 * 预置演示数据启动应用，通过 CDP 截取各视图 / 双主题 / 弹窗。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9453
const userData = join(root, '.shot-ui-data')
const outDir = join(root, '.shot-ui')
rmSync(userData, { recursive: true, force: true })
rmSync(outDir, { recursive: true, force: true })
mkdirSync(userData)
mkdirSync(outDir)

const now = Date.now()
const H = 3_600_000
const D = 86_400_000

const config = {
  version: 1,
  sites: [
    {
      id: 'seekai',
      name: 'SeekAI',
      baseUrl: 'https://seekai.cc',
      affUrl: 'https://seekai.cc/sign-up?aff=sxto',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'github',
      note: 'New API 系，签到需 Turnstile',
      accounts: [
        {
          id: 'a1',
          siteId: 'seekai',
          label: 'octocat',
          provider: 'github',
          createdAt: now - 30 * D,
          lastStatus: { at: now - H, ok: true, available: 52.3, used: 147.7 },
          lastCheckin: { at: now - 2 * H, date: '2026-10-18', ok: true, already: false, reward: 1, message: '签到成功' }
        },
        {
          id: 'a2',
          siteId: 'seekai',
          label: 'dev@example.com',
          provider: 'password',
          createdAt: now - 12 * D,
          lastStatus: { at: now - D, ok: false, error: '401 会话过期' },
          lastCheckin: { at: now - 2 * D, date: '2026-10-16', ok: true, already: true, message: '今日已签到' }
        }
      ]
    },
    {
      id: 'kktoken',
      name: 'KKtoken AI',
      baseUrl: 'https://kktoken.cc',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'linuxdo',
      note: 'Claude Opus 4.8 / Claude Opus 5；有签到按钮',
      accounts: [
        {
          id: 'a3',
          siteId: 'kktoken',
          label: 'kk-user',
          provider: 'linuxdo',
          createdAt: now - 6 * D,
          lastStatus: { at: now - 600_000, ok: true, available: 75, used: 0 },
          lastCheckin: { at: now - 600_000, date: '2026-10-18', ok: true, already: false, reward: 25, message: '签到成功 +$25' }
        }
      ]
    },
    {
      id: 'welfare-1',
      name: '公益小站',
      baseUrl: 'https://welfare.example.org',
      mode: 'RELOGIN',
      kind: 'WELFARE',
      provider: 'github',
      note: '重登领取每日额度',
      hidden: true,
      accounts: []
    }
  ],
  credentials: [
    { id: 'c1', provider: 'github', username: 'octocat', note: '主力账号', lastUsedAt: now - H, createdAt: now - 30 * D },
    { id: 'c2', provider: 'linuxdo', username: 'kk-user', createdAt: now - 6 * D },
    { id: 'c3', provider: 'password', username: 'dev@example.com', note: '小号', lastUsedAt: now - 2 * D, createdAt: now - 12 * D }
  ],
  settings: {
    proxy: { mode: 'system', url: '' },
    schedule: { enabled: true, time: '08:05', weekdaysOnly: false },
    sidebarCollapsed: false,
    hideHiddenSites: false,
    theme: 'dark'
  }
}

const logs = [
  { id: 'l1', at: now - 5 * 60_000, level: 'info', scope: '调度', message: '下次自动签到：22:05:00' },
  { id: 'l2', at: now - 10 * 60_000, level: 'ok', scope: '签到', message: 'KKtoken AI / kk-user：签到成功 +$25', siteId: 'kktoken', accountId: 'a3' },
  { id: 'l3', at: now - 12 * 60_000, level: 'ok', scope: '签到', message: 'SeekAI / octocat：签到成功 +$1', siteId: 'seekai', accountId: 'a1' },
  { id: 'l4', at: now - H, level: 'err', scope: '额度', message: 'SeekAI / dev@example.com：刷新失败', detail: '401 会话过期，请重新登录', siteId: 'seekai', accountId: 'a2' },
  { id: 'l5', at: now - 2 * H, level: 'warn', scope: '会话续期', message: 'SeekAI / dev@example.com：refresh cookie 失效，续期中止', siteId: 'seekai', accountId: 'a2' },
  { id: 'l6', at: now - 3 * H, level: 'info', scope: '登录', message: 'SeekAI：GitHub OAuth 登录成功（octocat）', siteId: 'seekai', accountId: 'a1' },
  { id: 'l7', at: now - 4 * H, level: 'info', scope: '探测', message: 'https://kktoken.cc：New API 系，签到按钮可用，Turnstile 已启用', siteId: 'kktoken' },
  { id: 'l8', at: now - 5 * H, level: 'ok', scope: '人机验证', message: 'SeekAI：已取得验证令牌', siteId: 'seekai' }
]

writeFileSync(join(userData, 'config.json'), JSON.stringify(config, null, 2))
writeFileSync(join(userData, 'logs.json'), JSON.stringify(logs))

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
await send('Page.enable')

const ev = (expr) =>
  send('Runtime.evaluate', { expression: expr, awaitPromise: false, returnByValue: true }).then(
    (r) => r.result?.result?.value
  )

let n = 0
const shot = async (label) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const name = `${String(++n).padStart(2, '0')}-${label}.png`
  writeFileSync(join(outDir, name), Buffer.from(r.result.data, 'base64'))
  console.log('shot:', name)
}

const nav = async (label) => {
  await ev(`[...document.querySelectorAll('.nav-item')].find(n=>n.querySelector('.nav-label')?.textContent==='${label}')?.click()`)
  await sleep(650)
}

await sleep(2000)

// ---- 暗色 ----
await shot('sites-dark')
// 打码态：一键遮住账号身份，便于截图分享（对应 docs/images/masked.png）
await ev(`document.querySelector('.topbar .btn[aria-pressed]')?.click()`)
await sleep(400)
await shot('sites-masked-dark')
await ev(`document.querySelector('.topbar .btn[aria-pressed]')?.click()`)
await sleep(400)
await nav('账号')
await shot('credentials-dark')
await nav('运行日志')
await shot('logs-dark')
await nav('设置')
await shot('settings-dark')
// 自绘下拉展开态（暗色）
await ev(`document.querySelector('.content .zselect')?.click()`)
await sleep(400)
await shot('select-open-dark')
await ev(`document.querySelector('.content .zselect')?.click()`)
await sleep(300)
await nav('全部站点')
// 站点卡片内的账号排序下拉（小号）
await ev(`document.querySelector('.account-sort-row .zselect')?.click()`)
await sleep(400)
await shot('select-sm-open-dark')
await ev(`document.querySelector('.account-sort-row .zselect')?.click()`)
await sleep(300)

await nav('全部站点')
await ev(`[...document.querySelectorAll('.topbar .btn')].find(b=>b.textContent.includes('添加站点'))?.click()`)
await sleep(700)
await shot('addsite-dialog-dark')
await ev(`document.querySelector('.modal-backdrop')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
await sleep(400)

await ev(`document.querySelector('[title="编辑站点"]')?.click()`)
await sleep(500)
await shot('editsite-dialog-dark')
await ev(`document.querySelector('.modal-x')?.click()`)
await sleep(400)

await ev(`document.querySelector('[title="移除站点及其账号"]')?.click()`)
await sleep(500)
await shot('confirm-dialog-dark')
await ev(`[...document.querySelectorAll('.modal-actions .btn')].find(b=>b.textContent.trim()==='取消')?.click()`)
await sleep(400)

await ev(`[...document.querySelectorAll('.site-card .btn')].find(b=>b.textContent.includes('添加账号'))?.click()`)
await sleep(700)
await shot('addaccount-dialog-dark')
await ev(`document.querySelector('.modal-x')?.click()`)
await sleep(400)

// toast（复制地址）
await ev(`document.querySelector('[title="复制地址"]')?.click()`)
await sleep(500)
await shot('toast-dark')

// ---- 亮色 ----
await nav('设置')
await ev(`[...document.querySelectorAll('.seg-item')].find(b=>b.textContent.includes('亮色'))?.click()`)
await sleep(600)
await shot('settings-light')
await ev(`document.querySelector('.content .zselect')?.click()`)
await sleep(400)
await shot('select-open-light')
await ev(`document.querySelector('.content .zselect')?.click()`)
await sleep(300)
await nav('全部站点')
await shot('sites-light')
await nav('账号')
await shot('credentials-light')
await nav('运行日志')
await shot('logs-light')

// 折叠侧栏
await ev(`document.querySelector('[title="折叠侧栏"]')?.click()`)
await sleep(500)
await nav('全部站点')
await shot('sites-light-collapsed')

ws.close()
child.kill()
console.log('DONE', outDir)
