/**
 * 侧栏站点可见性验证：确认「收起 / 恢复」这套交互真的可用。
 *
 * 设计意图（v0.7.3 起）：
 *   站点行本身就是开关 —— 悬停出现眼睛图标，点一下从侧栏收起，再点恢复。
 *   收起**只影响侧栏入口**，账号、额度、签到、定时任务全部不变。
 *   因此没有「已隐藏」灰化、没有独立的「显示全部」按钮，
 *   也不存在「藏了就找不回」的死角。
 *
 * 这里锁住四件事：
 *   1. 每个站点行都有可见性开关
 *   2. 点开关后该站点从侧栏消失（且只剩它在变，其它站点不受影响）
 *   3. 它仍出现在「全部站点」里，可原地恢复
 *   4. 收起态不再灰化主视图卡片、不再显示「已隐藏」警告标签
 *
 * 运行：npm run verify:ui（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9461
const userData = join(root, '.verify-sidebar-user-data')
const shotDir = join(root, '.verify-sidebar-shots')
rmSync(userData, { recursive: true, force: true })
rmSync(shotDir, { recursive: true, force: true })
mkdirSync(shotDir, { recursive: true })

// 预置三个站点，其中一个处于「已收起」状态
const seed = {
  version: 1,
  sites: [
    {
      id: 'site-alpha',
      name: 'AlphaSite',
      baseUrl: 'https://alpha.example.com',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'github',
      accounts: [
        {
          id: 'acc-a1',
          siteId: 'site-alpha',
          label: 'user-a1',
          provider: 'github',
          createdAt: 1,
          lastStatus: { at: Date.now(), ok: true, available: 12.5, used: 3.25 }
        }
      ]
    },
    {
      id: 'site-beta',
      name: 'BetaSite',
      baseUrl: 'https://beta.example.com',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'github',
      accounts: [
        {
          id: 'acc-b1',
          siteId: 'site-beta',
          label: 'user-b1',
          provider: 'github',
          createdAt: 2,
          lastStatus: { at: Date.now(), ok: true, available: 20, used: 1 }
        }
      ]
    },
    {
      id: 'site-gamma',
      name: 'GammaSite',
      baseUrl: 'https://gamma.example.com',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'github',
      // 已从侧栏收起：应不出现在侧栏，但必须出现在「全部站点」里
      hidden: true,
      accounts: [
        {
          id: 'acc-g1',
          siteId: 'site-gamma',
          label: 'user-g1',
          provider: 'github',
          createdAt: 3,
          lastStatus: { at: Date.now(), ok: true, available: 33, used: 2 }
        }
      ]
    }
  ],
  credentials: [],
  settings: {
    proxy: { mode: 'direct', url: '' },
    schedule: { enabled: false, time: '08:05', weekdaysOnly: false },
    sidebarCollapsed: false,
    hideHiddenSites: true,
    theme: 'dark',
    siteSort: 'custom',
    siteSortDir: 'asc',
    accountSort: 'custom',
    accountSortDir: 'desc',
    maskAccounts: false
  }
}
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify(seed, null, 2))

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
  } catch {
    /* 还没起来 */
  }
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
const ev = (expr, ap = false) =>
  send('Runtime.evaluate', { expression: expr, awaitPromise: ap, returnByValue: true }).then(
    (r) => r.result?.result?.value
  )

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

/** 截图，用于人眼验收。 */
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r.result?.data) writeFileSync(join(shotDir, `${name}.png`), Buffer.from(r.result.data, 'base64'))
}

/** 侧栏里列出的站点名。 */
const sidebarNames = () =>
  ev(`[...document.querySelectorAll('.nav-site-row .nav-label')].map(n=>n.textContent)`)
/** 主视图里的站点名。 */
const mainNames = () =>
  ev(`[...document.querySelectorAll('.site-card .site-name')].map(n=>n.textContent)`)

await sleep(2000)

// ---- 初始状态 ----
const initial = await sidebarNames()
ck('侧栏列出未收起的站点', JSON.stringify(initial) === JSON.stringify(['AlphaSite', 'BetaSite']), JSON.stringify(initial))
ck('已收起的站点不在侧栏', !initial.includes('GammaSite'))

const initialMain = await mainNames()
ck(
  '「全部站点」视图包含已收起的站点（藏了也能找回）',
  JSON.stringify(initialMain) === JSON.stringify(['AlphaSite', 'BetaSite', 'GammaSite']),
  JSON.stringify(initialMain)
)

// ---- 开关存在性 ----
const toggles = await ev(`document.querySelectorAll('.nav-site-row .nav-hide-toggle').length`)
ck('每个侧栏站点行都有可见性开关', toggles === 2, `${toggles} 个开关 / 2 个站点`)
ck(
  '开关默认不可见（悬停才出现，平时不干扰）',
  (await ev(`getComputedStyle(document.querySelector('.nav-hide-toggle')).opacity`)) === '0'
)
ck(
  '开关有明确的提示文案（说明只影响侧栏）',
  (await ev(`document.querySelector('.nav-hide-toggle').title`)).includes('侧栏'),
  await ev(`document.querySelector('.nav-hide-toggle').title`)
)

// ---- 不再有「显示全部」按钮 ----
ck(
  '侧栏没有独立的「显示全部」入口',
  (await ev(`[...document.querySelectorAll('.nav-item')].some(n=>(n.innerText||'').includes('显示全部'))`)) === false
)
ck(
  '主视图卡片不再显示「已隐藏」警告标签',
  (await ev(`[...document.querySelectorAll('.site-tags .tag')].some(t=>t.textContent.includes('已隐藏'))`)) === false
)
ck(
  '收起态不灰化卡片（收起≠不可用）',
  (await ev(`getComputedStyle(document.querySelector('.site-card.is-sidebar-collapsed')).opacity`)) === '1',
  await ev(`getComputedStyle(document.querySelector('.site-card.is-sidebar-collapsed')).opacity`)
)
ck(
  '收起态有中性「侧栏已收起」标记',
  (await ev(`[...document.querySelectorAll('.site-tags .tag')].some(t=>t.textContent==='侧栏已收起')`)) === true
)
// 图标语义：睁眼=显示中，闭眼=已收起。方向反了会让人反复点错。
ck(
  '卡片图标表示当前状态（收起站点用弱化的闭眼图标）',
  (await ev(`(() => {
    const card = [...document.querySelectorAll('.site-card')].find(c =>
      c.querySelector('.site-name')?.textContent === 'GammaSite')
    const btn = card && [...card.querySelectorAll('.site-actions .icon-btn')].find(b =>
      (b.title || '').includes('侧栏'))
    return !!btn && btn.classList.contains('muted')
  })()`)) === true
)
ck(
  '「全部站点」计数与侧栏条目数一致（不再出现 3 vs 2）',
  (await ev(`(() => {
    const badge = [...document.querySelectorAll('.nav-item')]
      .find(n => (n.innerText || '').includes('全部站点'))
      ?.querySelector('.nav-count')?.textContent
    return Number(badge) === document.querySelectorAll('.nav-site-row').length
  })()`)) === true,
  `徽章=${await ev(`[...document.querySelectorAll('.nav-item')].find(n=>(n.innerText||'').includes('全部站点'))?.querySelector('.nav-count')?.textContent`)} 行数=${await ev(`document.querySelectorAll('.nav-site-row').length`)}`
)
ck(
  '开关是 BUTTON（可键盘聚焦，不是纯 hover 交互）',
  (await ev(`document.querySelector('.nav-hide-toggle').tagName`)) === 'BUTTON'
)

await shot('01-initial')

// ---- 点开关收起 ----
await ev(`document.querySelectorAll('.nav-hide-toggle')[0]?.click()`)
await sleep(900)
const afterHide = await sidebarNames()
ck(
  '点开关后该站点从侧栏消失',
  JSON.stringify(afterHide) === JSON.stringify(['BetaSite']),
  JSON.stringify(afterHide)
)
const afterHideMain = await mainNames()
ck(
  '收起后主视图仍能看到它（未丢数据）',
  afterHideMain.includes('AlphaSite'),
  JSON.stringify(afterHideMain)
)
ck('收起后侧栏条目数等于剩余站点数', afterHide.length === 1)
await shot('02-after-hide')

// ---- 在「全部站点」里恢复 ----
// 主视图对应卡片的眼睛按钮是同一开关
const restored = await ev(`(() => {
  const card = [...document.querySelectorAll('.site-card')].find(c =>
    c.querySelector('.site-name')?.textContent === 'AlphaSite')
  if (!card) return 'no-card'
  const btn = [...card.querySelectorAll('.site-actions .icon-btn')].find(b =>
    (b.title || '').includes('侧栏'))
  if (!btn) return 'no-button'
  btn.click()
  return 'clicked'
})()`)
ck('主视图卡片上能找到恢复按钮', restored === 'clicked', String(restored))
await sleep(900)
const afterRestore = await sidebarNames()
ck(
  '恢复后站点重新出现在侧栏',
  afterRestore.includes('AlphaSite'),
  JSON.stringify(afterRestore)
)
await shot('03-after-restore')

// ---- 收起最后一个站点时的空态引导 ----
await ev(`(() => {
  const rows = [...document.querySelectorAll('.nav-site-row .nav-hide-toggle')]
  rows.forEach(b => b.click())
})()`)
await sleep(1000)
const emptySidebar = await sidebarNames()
ck('可以收起全部站点', emptySidebar.length === 0, JSON.stringify(emptySidebar))
const hint = await ev(`document.querySelector('.sidebar-hint')?.textContent || ''`)
ck(
  '全部收起时给出如何找回的引导（不是死胡同）',
  hint.includes('全部站点'),
  hint.replace(/\s+/g, ' ').trim()
)
await shot('04-all-collapsed')

// ---- 汇总 ----
await ev(`document.querySelector('.nav-item')?.click()`)
console.log(`\n截图：${shotDir}`)
const failed = checks.filter((c) => !c).length
console.log(`${checks.length - failed}/${checks.length} passed`)
ws.close()
child.kill()
if (failed) process.exit(1)
