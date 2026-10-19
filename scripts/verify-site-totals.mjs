/**
 * 站点卡片合计金额的验证。
 *
 * 合计只统计刷新成功的账号，且必须把多个账号的数值真的加起来；
 * 全部账号都失败时不显示合计（避免一个没有意义的 $0.00 误导人）。
 *
 * 演示数据全部使用 example.com 与 demo-user，不含真实账号。
 *
 * 运行：node scripts/verify-site-totals.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9457
const userData = join(root, '.verify-totals-user-data')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const now = Date.now()
const account = (id, label, available, used, ok = true) => ({
  id,
  siteId: 'demo-site',
  label,
  provider: 'github',
  createdAt: now,
  lastStatus: ok
    ? { at: now - 600_000, ok: true, available, used }
    : { at: now - 600_000, ok: false, error: '401 会话过期' }
})

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
        account('a1', 'demo-user-01', 100.5, 10.25),
        account('a2', 'demo-user-02', 200.25, 20.5),
        account('a3', 'demo-user-03', 300, 30)
      ]
    },
    {
      id: 'failed-site',
      name: 'FailedSite',
      baseUrl: 'https://failed.example.com',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'github',
      accounts: [account('b1', 'demo-user-04', 0, 0, false)]
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

const cards = JSON.parse(
  await ev(`JSON.stringify([...document.querySelectorAll('.site-card')].map(card => ({
    site: card.querySelector('.site-name')?.textContent || '',
    totals: card.querySelector('.site-totals')?.innerText.replace(/\\n/g, ' ') || '',
    hasTotals: !!card.querySelector('.site-totals')
  })))`)
)

const normal = cards.find((c) => c.site === 'DemoSite')
const failed = cards.find((c) => c.site === 'FailedSite')

ck('有数据的站点显示合计', normal?.hasTotals === true, normal?.totals || '缺失')
ck('合计可用是三个账号之和', normal?.totals.includes('$600.75'), normal?.totals)
ck('合计累计是三个账号之和', normal?.totals.includes('$60.75'), normal?.totals)
ck('合计金额带语义色（可用为绿）', (await ev(`!!document.querySelector('.site-totals .amount.ok')`)) === true)
ck(
  '失败账号不参与合计（该站点不显示合计）',
  failed?.hasTotals === false,
  failed ? `${failed.site}: ${failed.totals || '无'}` : '站点缺失'
)
ck(
  '每个站点卡片最多一个合计',
  (await ev(`[...document.querySelectorAll('.site-card')].every(c => c.querySelectorAll('.site-totals').length <= 1)`)) === true
)

const failedCount = checks.filter((x) => !x).length
console.log(`\n${failedCount === 0 ? 'ALL PASS' : `${failedCount} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failedCount === 0 ? 0 : 1)
