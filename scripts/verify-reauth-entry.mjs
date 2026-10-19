/**
 * 账号行「重新授权」入口的验证。
 *
 * 起因：AgentRouter 的 GitHub 账号签到失败后提示「需要在应用内重新登录」，
 * 但界面上任何地方都找不到重新登录的入口 —— 重授权按钮只在
 * 「lastStatus 失败且错误文案被识别为会话失效」时才渲染，签到这个动作
 * 本身并没有写 lastStatus，于是按钮不出现。
 *
 * 这里锁住两条不变量：
 *   1. 每个账号行始终有「重新授权」入口，不依赖当前状态
 *   2. 会话失效的账号把该按钮升级为主按钮，优先于「刷新额度」
 *
 * 演示数据全部使用 example.com 与 demo-user，不含真实账号。
 *
 * 运行：node scripts/verify-reauth-entry.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9458
const userData = join(root, '.verify-reauth-user-data')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const now = Date.now()
const account = (id, label, lastStatus) => ({
  id,
  siteId: 'demo-site',
  label,
  provider: 'github',
  createdAt: now,
  lastStatus
})

const demoConfig = {
  version: 1,
  sites: [
    {
      id: 'demo-site',
      name: 'DemoSite',
      baseUrl: 'https://demo.example.com',
      mode: 'RELOGIN',
      kind: 'NEWAPI',
      provider: 'github',
      accounts: [
        // 健康账号：状态正常，仍然要有重授权入口
        account('a1', 'demo-user-01', { at: now - 60_000, ok: true, available: 100, used: 10 }),
        // 会话失效账号：按钮应升级为主按钮
        account('a2', 'demo-user-02', {
          at: now - 60_000,
          ok: false,
          available: 50,
          used: 5,
          error: '需要重新授权：分区内没有 GitHub 登录态，且凭据未保存密码（本次未登出，账号仍保持原状）'
        }),
        // 普通失败（网络/风控）：按钮照旧存在，但不应升级成主按钮
        account('a3', 'demo-user-03', {
          at: now - 60_000,
          ok: false,
          error: '站点防护拦截（当前代理节点被风控），请更换节点后重试'
        })
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
const ev = (expr) =>
  send('Runtime.evaluate', { expression: expr, returnByValue: true }).then(
    (r) => r.result?.result?.value
  )

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

await sleep(1800)

const rows = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.account-row')].map(row => {
    const btns = [...row.querySelectorAll('.account-actions .btn')].map(b => ({
      text: (b.textContent || '').trim(),
      primary: b.classList.contains('primary')
    }))
    return {
      label: row.querySelector('.account-label')?.firstChild?.textContent?.trim() || '',
      reauth: btns.find(b => b.text.includes('重新授权')) || null,
      tags: [...row.querySelectorAll('.tag')].map(t => (t.textContent || '').trim())
    }
  }))`)
)

ck('三个演示账号都渲染出来', rows.length === 3, `${rows.length} 行`)

const healthy = rows.find((r) => r.label.startsWith('demo-user-01'))
const expired = rows.find((r) => r.label.startsWith('demo-user-02'))
const otherFail = rows.find((r) => r.label.startsWith('demo-user-03'))

ck('状态正常的账号也有重新授权入口', !!healthy?.reauth, healthy ? String(!!healthy.reauth) : '账号缺失')
ck('会话失效的账号有重新授权入口', !!expired?.reauth, expired ? String(!!expired.reauth) : '账号缺失')
ck('普通失败的账号也有重新授权入口', !!otherFail?.reauth, otherFail ? String(!!otherFail.reauth) : '账号缺失')

ck(
  '会话失效时重新授权是主按钮（比刷新额度更显眼）',
  expired?.reauth?.primary === true,
  expired ? `primary=${expired.reauth?.primary}` : '账号缺失'
)
ck(
  '普通失败时重新授权不抢主按钮（签到仍是主动作）',
  otherFail?.reauth?.primary === false,
  otherFail ? `primary=${otherFail.reauth?.primary}` : '账号缺失'
)
ck(
  '健康账号的重新授权是次要样式',
  healthy?.reauth?.primary === false,
  healthy ? `primary=${healthy.reauth?.primary}` : '账号缺失'
)
ck(
  '会话失效的账号标出「需重新授权」',
  (expired?.tags ?? []).some((t) => t.includes('重新授权')),
  (expired?.tags ?? []).join(' / ')
)

// 点击入口应打开重授权对话框，而不是「添加账号」
await ev(`(() => {
  const row = [...document.querySelectorAll('.account-row')].find(r =>
    (r.querySelector('.account-label')?.textContent || '').includes('demo-user-02'))
  const btn = [...row.querySelectorAll('.account-actions .btn')].find(b =>
    (b.textContent || '').includes('重新授权'))
  btn.click()
})()`)
await sleep(900)
const dialogTitle = (await ev(`document.querySelector('.modal h2')?.textContent || ''`)) ?? ''
ck('点击后打开重授权对话框（不是新增账号）', dialogTitle.includes('重新授权'), dialogTitle)
ck(
  '对话框说明账号与历史记录会保留',
  (await ev(`document.querySelector('.modal .hint')?.textContent || ''`)).includes('历史记录'),
  await ev(`document.querySelector('.modal .hint')?.textContent || ''`)
)

const failedCount = checks.filter((x) => !x).length
console.log(`\n${failedCount === 0 ? 'ALL PASS' : `${failedCount} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failedCount === 0 ? 0 : 1)
