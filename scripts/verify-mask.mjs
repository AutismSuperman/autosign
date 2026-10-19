/**
 * 账号打码的界面验证。
 *
 * 断言四件事：
 *   1. 顶栏有打码开关，点击后进入开启态
 *   2. 开启后账号名、登录账号都变成掩码，原始值不再出现在 DOM 里
 *   3. 凭据页的用户名同样被打码
 *   4. 关掉后恢复原文（打码只影响显示，不改数据）
 *
 * 演示数据全部使用 example.com / demo-user 形式，不含真实账号。
 *
 * 运行：node scripts/verify-mask.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9456
const userData = join(root, '.verify-mask-user-data')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const now = Date.now()
const RAW_ACCOUNT = 'demo-user@example.com'
const RAW_LABEL = 'github_123456'
const RAW_DISPLAY = '演示凭据'
const demoConfig = {
  version: 1,
  sites: [
    {
      id: 'demo-site',
      name: 'DemoSite',
      baseUrl: 'https://demo.example.com',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'password',
      accounts: [
        {
          id: 'demo-a1',
          siteId: 'demo-site',
          label: RAW_LABEL,
          provider: 'password',
          credentialId: 'cred-1',
          createdAt: now
        }
      ]
    }
  ],
  credentials: [
    {
      id: 'cred-1',
      provider: 'password',
      username: RAW_ACCOUNT,
      displayName: RAW_DISPLAY,
      createdAt: now
    }
  ],
  settings: {},
  logs: []
}
writeFileSync(join(userData, 'config.json'), JSON.stringify(demoConfig, null, 2))
writeFileSync(
  join(userData, 'logs.json'),
  JSON.stringify([
    {
      id: 'log-1',
      at: now,
      level: 'ok',
      scope: '签到',
      message: `DemoSite / ${RAW_LABEL}：签到成功 +$25`,
      siteId: 'demo-site',
      accountId: 'demo-a1'
    }
  ])
)

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
const ev = (expr) =>
  send('Runtime.evaluate', { expression: expr, returnByValue: true }).then(
    (r) => r.result?.result?.value
  )

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const nav = async (label) => {
  await ev(
    `[...document.querySelectorAll('.nav-item')].find(n=>n.querySelector('.nav-label')?.textContent==='${label}')?.click()`
  )
  await sleep(700)
}

await sleep(1800)

// 初始（未打码）：原始账号可见
const before = await ev(`document.querySelector('.account-label')?.innerText || ''`)
ck('默认显示真实账号名', before.includes(RAW_LABEL), before)
ck('默认显示登录凭据名称', before.includes(RAW_DISPLAY), before)

// 顶栏打码开关
const toggleSel = `.topbar .btn[aria-pressed]`
ck('顶栏有打码开关', (await ev(`!!document.querySelector('${toggleSel}')`)) === true)
ck('打码开关默认关闭', (await ev(`document.querySelector('${toggleSel}')?.getAttribute('aria-pressed')`)) === 'false')
await ev(`document.querySelector('${toggleSel}')?.click()`)
await sleep(700)

const after = await ev(`JSON.stringify({
  text: document.querySelector('.account-label')?.innerText || '',
  blocks: document.querySelectorAll('.account-label .masked-text').length,
  blockWidth: document.querySelector('.account-label .masked-text')?.getBoundingClientRect().width ?? 0,
  loginBlocks: document.querySelectorAll('.account-label .tag.login-id .masked-text').length
})`)
const afterState = JSON.parse(after)
ck('开启后账号名换成遮罩块', afterState.blocks >= 1, `${afterState.blocks} 块`)
ck('遮罩块不再包含任何原文', !afterState.text.includes(RAW_LABEL), afterState.text)
ck('登录账号也换成遮罩块', afterState.loginBlocks >= 1, `${afterState.loginBlocks} 块`)
ck('遮罩块有实际宽度（不是塌陷的）', afterState.blockWidth > 10, `${Math.round(afterState.blockWidth)}px`)
ck('开关进入开启态', (await ev(`document.querySelector('${toggleSel}')?.getAttribute('aria-pressed')`)) === 'true')
ck(
  '页面 DOM 中不再出现原始账号',
  (await ev(`document.querySelector('.content')?.innerText || ''`)).includes(RAW_LABEL) === false
)
ck(
  '页面 HTML 里也没有原始账号（不是靠 CSS 遮挡）',
  (await ev(`document.querySelector('.content')?.innerHTML || ''`)).includes(RAW_LABEL) === false
)

// 凭据页：显示名称与用户名都换成遮罩块
await nav('账号')
const credState = JSON.parse(
  await ev(`JSON.stringify({
    text: document.querySelector('.cred-list, .panel')?.innerText || '',
    html: document.querySelector('.cred-list, .panel')?.innerHTML || '',
    blocks: document.querySelectorAll('.cred-row .masked-text').length
  })`)
)
ck('凭据页用户名换成遮罩块', credState.blocks >= 1, `${credState.blocks} 块`)
ck('凭据页文本里没有原文', !credState.text.includes(RAW_ACCOUNT) && !credState.text.includes(RAW_DISPLAY), credState.text.split('\n').slice(0, 3).join(' | '))
ck('凭据页 HTML 里没有原文', !credState.html.includes(RAW_ACCOUNT), 'checked')

// 日志页
await nav('运行日志')
await sleep(500)
const logState = JSON.parse(
  await ev(`JSON.stringify({
    text: document.querySelector('.content')?.innerText || '',
    html: document.querySelector('.content')?.innerHTML || '',
    blocks: document.querySelectorAll('.log-msg .masked-text').length
  })`)
)
ck('日志正文里的账号换成遮罩块', logState.blocks >= 1, `${logState.blocks} 块`)
ck('日志文本里没有账号原文', !logState.text.includes(RAW_LABEL), logState.text.split('\n').slice(0, 2).join(' | '))
ck('日志 HTML 里没有账号原文', !logState.html.includes(RAW_LABEL), 'checked')
ck('日志里的站点名仍可见', logState.text.includes('DemoSite'))

// 设置页有同一开关
await nav('设置')
ck(
  '设置页也有账号打码开关',
  (await ev(`[...document.querySelectorAll('.field-label')].some(n=>n.textContent.includes('账号打码'))`)) === true
)
ck(
  '设置页开关与顶栏同步为开启',
  (await ev(`(() => {
    const row = [...document.querySelectorAll('.field')].find(f => f.querySelector('.field-label')?.textContent.includes('账号打码'))
    return row?.querySelector('input[type=checkbox]')?.checked
  })()`)) === true
)
// 从设置页关闭
await ev(`(() => {
  const row = [...document.querySelectorAll('.field')].find(f => f.querySelector('.field-label')?.textContent.includes('账号打码'))
  row?.querySelector('input[type=checkbox]')?.click()
})()`)
await sleep(700)

await nav('全部站点')
const restored = await ev(`document.querySelector('.account-label')?.innerText || ''`)
ck('关闭后恢复真实账号名', restored.includes(RAW_LABEL), restored)

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failed === 0 ? 0 : 1)
