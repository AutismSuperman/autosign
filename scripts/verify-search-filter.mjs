/**
 * 检索按账号级别收窄的验证。
 *
 * 起因：早期版本只要有任意账号命中，就保留整张站点卡片，
 * 于是搜邮箱时同站十几个账号照样全部列出，看起来像筛选没生效。
 *
 * 现在的规则：
 *   - 站点名 / 域名命中 → 展示该站点全部账号（用户找的是站点）
 *   - 仅账号名或凭据命中 → 只展示命中的账号
 *
 * 演示数据全部使用 example.com / test.org / sample.net 等保留域名，
 * 不含任何真实账号。
 *
 * 运行：node scripts/verify-search-filter.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9455
const userData = join(root, '.verify-search-user-data')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const now = Date.now()
const account = (id, siteId, label) => ({
  id,
  siteId,
  label,
  provider: 'password',
  credentialId: 'cred-1',
  createdAt: now
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
      provider: 'password',
      accounts: [
        account('a1', 'demo-site', 'alpha'),
        account('a2', 'demo-site', 'beta'),
        account('a3', 'demo-site', 'gamma')
      ]
    },
    {
      id: 'other-site',
      name: 'OtherSite',
      baseUrl: 'https://other.sample.net',
      mode: 'BUTTON',
      kind: 'NEWAPI',
      provider: 'password',
      accounts: [account('b1', 'other-site', 'delta')]
    }
  ],
  credentials: [
    {
      id: 'cred-1',
      provider: 'password',
      username: 'demo-owner@example.com',
      displayName: '演示凭据',
      createdAt: now
    }
  ],
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

/** 通过原生 setter 改写输入框，确保 React 收到 input 事件。 */
const search = async (text) => {
  await ev(`(() => {
    const input = document.querySelector('.topbar .search-box input')
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
    desc.set.call(input, ${JSON.stringify(text)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(500)
}
const snapshot = async () =>
  JSON.parse(
    await ev(`JSON.stringify({
      cards: document.querySelectorAll('.site-card').length,
      rows: document.querySelectorAll('.account-row').length,
      labels: [...document.querySelectorAll('.account-label')].map(n => n.textContent.trim()),
      sub: document.querySelector('.topbar .sub')?.textContent || ''
    })`)
  )

await sleep(1800)

const all = await snapshot()
ck('初始显示两个站点', all.cards === 2, `${all.cards} 张卡片`)
ck('初始显示四个账号', all.rows === 4, `${all.rows} 行`)

// 1. 账号名命中：只保留命中的账号，同站其它账号不再列出
await search('beta')
const byAccount = await snapshot()
ck('按账号名检索只出一个账号', byAccount.rows === 1, `${byAccount.rows} 行`)
ck(
  '命中的正是该账号',
  byAccount.labels.some((t) => t.includes('beta')) &&
    !byAccount.labels.some((t) => t.includes('alpha') || t.includes('gamma')),
  byAccount.labels.join(' | ')
)
ck('同站卡片仍在', byAccount.cards === 1, `${byAccount.cards} 张`)
ck('统计条给出收窄后的账号数', byAccount.sub.includes('1 个账号'), byAccount.sub)

// 2. 站点名命中：展示该站点全部账号
await search('DemoSite')
const bySite = await snapshot()
ck('按站点名检索显示该站点', bySite.cards === 1, `${bySite.cards} 张`)
ck('站点命中时列出全部账号', bySite.rows === 3, `${bySite.rows} 行`)

// 3. 域名命中：同样按站点处理
await search('sample.net')
const byDomain = await snapshot()
ck('按域名检索命中另一站点', byDomain.cards === 1, `${byDomain.cards} 张`)
ck('域名命中只含该站点账号', byDomain.rows === 1 && byDomain.labels.join().includes('delta'), byDomain.labels.join(' | '))

// 4. 凭据名命中：两个站点的账号都关联了同一凭据，应全部保留
await search('演示凭据')
const byCredential = await snapshot()
ck('按凭据检索保留关联账号', byCredential.rows === 4, `${byCredential.rows} 行`)

// 5. 凭据用户名命中（邮箱）
await search('demo-owner@example.com')
const byCredentialUser = await snapshot()
ck('按凭据用户名检索保留关联账号', byCredentialUser.rows === 4, `${byCredentialUser.rows} 行`)

// 6. 无结果
await search('no-such-thing')
const empty = await snapshot()
ck('无结果时展示空态', empty.cards === 0 && empty.sub.includes('0 / 2'), empty.sub)

// 7. 清空后恢复
await search('')
const restored = await snapshot()
ck('清空检索后恢复全部', restored.cards === 2 && restored.rows === 4, `${restored.cards} 张 / ${restored.rows} 行`)

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failed === 0 ? 0 : 1)
