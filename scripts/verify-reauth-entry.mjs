/**
 * 账号行「重新登录 / 重新授权」入口的验证。
 *
 * 起因：AgentRouter 的 GitHub 账号签到失败后提示「需要在应用内重新登录」，
 * 但界面上任何地方都找不到入口 —— 按钮只在错误文案被识别为会话失效时
 * 渲染，而签到这个动作当时根本不写 lastStatus。
 *
 * 修好入口后又要避免走到另一个极端：不能无脑给所有账号挂按钮。
 * 因此这里同时锁住「该出现」与「不该出现」两侧，以及文案要按登录方式区分：
 *   - 密码登录没有「授权」这一步，应显示「重新登录」
 *   - GitHub / Linux DO 走 OAuth，显示「重新授权」
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
const account = (id, label, provider, lastStatus, needsRelogin) => ({
  id,
  siteId: 'demo-site',
  label,
  provider,
  createdAt: now,
  lastStatus,
  ...(needsRelogin === undefined ? {} : { needsRelogin })
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
        // 健康账号：不该出现恢复入口
        account(
          'a1',
          'demo-user-01',
          'github',
          { at: now - 60_000, ok: true, available: 100, used: 10 },
          false
        ),
        // GitHub 会话失效：需要「重新授权」
        account(
          'a2',
          'demo-user-02',
          'github',
          { at: now - 60_000, ok: false, available: 50, used: 5, error: '会话已失效，需要重新授权' },
          true
        ),
        // 密码会话失效：需要的是「重新登录」，不是「重新授权」
        account(
          'a3',
          'demo-user-03',
          'password',
          { at: now - 60_000, ok: false, error: '会话已失效，需要重新授权' },
          true
        ),
        // 普通失败（风控）：不是会话问题，不该出现恢复入口
        account(
          'a4',
          'demo-user-04',
          'github',
          {
            at: now - 60_000,
            ok: false,
            error: '站点防护拦截（当前代理节点被风控），请更换节点后重试'
          },
          false
        ),
        // 旧数据：没有 needsRelogin 字段，但上次失败是会话失效 → 仍应出现
        account('a5', 'demo-user-05', 'github', {
          at: now - 60_000,
          ok: false,
          error: '会话已失效，需要重新授权'
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
      actions: btns,
      relogin: btns.find(b => /重新登录|重新授权/.test(b.text)) || null
    }
  }))`)
)

ck('五个演示账号都渲染出来', rows.length === 5, `${rows.length} 行`)

const byLabel = (n) => rows.find((r) => r.label.startsWith(`demo-user-0${n}`))

// ---- 不该出现的一侧：不能无脑给所有账号挂按钮 ----
ck('状态正常的账号没有恢复入口', byLabel(1)?.relogin === null, JSON.stringify(byLabel(1)?.actions))
ck('风控失败的账号没有恢复入口', byLabel(4)?.relogin === null, JSON.stringify(byLabel(4)?.actions))

// ---- 该出现的一侧 ----
ck('GitHub 会话失效有恢复入口', !!byLabel(2)?.relogin, JSON.stringify(byLabel(2)?.actions))
ck('密码会话失效有恢复入口', !!byLabel(3)?.relogin, JSON.stringify(byLabel(3)?.actions))
ck(
  '旧数据（无 needsRelogin 字段）仍能回退识别',
  !!byLabel(5)?.relogin,
  JSON.stringify(byLabel(5)?.actions)
)

// ---- 文案要按登录方式区分 ----
ck(
  'GitHub 账号显示「重新授权」',
  byLabel(2)?.relogin?.text === '重新授权',
  byLabel(2)?.relogin?.text
)
ck(
  '密码账号显示「重新登录」而不是「重新授权」',
  byLabel(3)?.relogin?.text === '重新登录',
  byLabel(3)?.relogin?.text
)

// ---- 恢复入口是主按钮，排在刷新/签到之前 ----
ck('恢复入口是主按钮', byLabel(2)?.relogin?.primary === true, String(byLabel(2)?.relogin?.primary))
ck(
  '恢复入口排在刷新额度之前',
  (() => {
    const list = byLabel(2)?.actions ?? []
    const reloginIdx = list.findIndex((a) => /重新登录|重新授权/.test(a.text))
    const refreshIdx = list.findIndex((a) => a.text.includes('刷新额度'))
    return reloginIdx >= 0 && refreshIdx > reloginIdx
  })(),
  (byLabel(2)?.actions ?? []).map((a) => a.text).join(' / ')
)

// ---- 点击入口打开的是重授权对话框，且文案跟随账号类型 ----
await ev(`(() => {
  const row = [...document.querySelectorAll('.account-row')].find(r =>
    (r.querySelector('.account-label')?.textContent || '').includes('demo-user-02'))
  const btn = [...row.querySelectorAll('.account-actions .btn')].find(b =>
    /重新登录|重新授权/.test(b.textContent || ''))
  btn.click()
})()`)
await sleep(900)
const ghTitle = (await ev(`document.querySelector('.modal h2')?.textContent || ''`)) ?? ''
ck('GitHub 账号打开「重新授权」对话框', ghTitle.includes('重新授权'), ghTitle)

await ev(`document.querySelector('.modal-actions .btn:not(.primary)')?.click()`)
await sleep(500)

await ev(`(() => {
  const row = [...document.querySelectorAll('.account-row')].find(r =>
    (r.querySelector('.account-label')?.textContent || '').includes('demo-user-03'))
  const btn = [...row.querySelectorAll('.account-actions .btn')].find(b =>
    /重新登录|重新授权/.test(b.textContent || ''))
  btn.click()
})()`)
await sleep(900)
const pwTitle = (await ev(`document.querySelector('.modal h2')?.textContent || ''`)) ?? ''
ck('密码账号打开「重新登录」对话框', pwTitle.includes('重新登录'), pwTitle)
const pwHint = (await ev(`document.querySelector('.modal .hint')?.textContent || ''`)) ?? ''
ck('密码账号对话框不出现「授权」字样', !pwHint.includes('授权'), pwHint)

const failedCount = checks.filter((x) => !x).length
console.log(`\n${failedCount === 0 ? 'ALL PASS' : `${failedCount} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failedCount === 0 ? 0 : 1)
