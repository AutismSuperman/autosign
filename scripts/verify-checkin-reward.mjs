/**
 * 签到状态与奖励展示的界面验证。
 *
 * 起因（用户现场）：
 *   1. 一批 GitHub 账号的签到奖励显示成 +$20.90、+$21.71、+$21.37……，
 *      和站点固定的 $25/天完全对不上；
 *   2. 签到会重复处理今天已经签过的账号。
 *
 * 这里锁住界面侧的规则：
 *   - 今日已签的账号显示「已签」「今日已签」
 *   - 回执里存的是「余额增量」（rewardSource=delta）时不渲染 +$ 金额
 *   - 站点给的金额（rewardSource=site）正常渲染 +$25
 *   - 离谱金额（$1036.99）不渲染
 *   - 跨天后不再显示「今日已签」，但悬停提示里保留上次记录
 *   - 批量签到遇到已签账号时给出「自动跳过」的说明
 *
 * 演示数据全部使用 example.com 与 demo-user，不含真实账号。
 * 运行：node scripts/verify-checkin-reward.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9462
const userData = join(root, '.verify-reward-user-data')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const now = Date.now()
const offset = 8 * 3_600_000
const day = 86_400_000
const today = new Date(Math.floor((now + offset) / day) * day).toISOString().slice(0, 10)
const yesterday = new Date(Math.floor((now + offset) / day) * day - day).toISOString().slice(0, 10)

const account = (id, label, lastCheckin) => ({
  id,
  siteId: 'reward-site',
  label,
  provider: 'github',
  createdAt: now,
  ...(lastCheckin ? { lastCheckin } : {})
})

const demoConfig = {
  version: 1,
  sites: [
    {
      id: 'reward-site',
      name: 'DemoSite',
      baseUrl: 'https://demo.example.com',
      mode: 'RELOGIN',
      kind: 'NEWAPI',
      provider: 'github',
      accounts: [
        // 1) 历史回执：余额增量，必须不显示金额
        account('r1', 'demo-delta-account', {
          at: now - 3_600_000,
          date: today,
          ok: true,
          already: false,
          reward: 20.9,
          rewardSource: 'delta',
          message: '重登成功，已检测到额度增加'
        }),
        // 2) 站点给的金额：正常显示 +$25
        account('r2', 'demo-site-reward', {
          at: now - 3_600_000,
          date: today,
          ok: true,
          already: true,
          reward: 25,
          rewardSource: 'site',
          message: '今日已签到'
        }),
        // 3) 离谱金额（单位取错的典型值）：不显示
        account('r3', 'demo-bad-amount', {
          at: now - 3_600_000,
          date: today,
          ok: true,
          already: false,
          reward: 1036.99,
          rewardSource: 'site',
          message: '签到成功'
        }),
        // 4) 昨天的回执：跨天后不算今日已签
        account('r4', 'demo-stale-account', {
          at: now - day - 3_600_000,
          date: yesterday,
          ok: true,
          already: false,
          reward: 25,
          rewardSource: 'site'
        }),
        // 5) 今天还没签
        account('r5', 'demo-pending-account')
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

const rows = JSON.parse(
  (await ev(`JSON.stringify([...document.querySelectorAll('.account-row')].map(row => {
    const label = row.querySelector('.account-label')?.firstChild?.textContent?.trim() || ''
    const stats = [...row.querySelectorAll('.account-meta .stat')].map(s => s.innerText.replace(/\\n/g, ' ').trim())
    // 签到那一段：标签 + 紧随其后的奖励金额
    const stat = [...row.querySelectorAll('.account-meta .stat')].find(s => (s.innerText || '').includes('签到'))
    return {
      label,
      checkin: stat ? stat.innerText.replace(/\\n/g, ' ').replace(/\\s+/g, ' ').trim() : '',
      title: stat ? (stat.getAttribute('title') || '') : '',
      amounts: [...row.querySelectorAll('.account-meta .stat .amount.ok')].map(b => (b.textContent || '').trim())
    }
  }))`)) || '[]'
)

const byLabel = (prefix) => rows.find((r) => r.label.startsWith(prefix))

ck('五个演示账号都渲染出来', rows.length === 5, `${rows.length} 行`)

// 1) 余额增量不是奖励
const deltaRow = byLabel('demo-delta-account')
ck('余额增量的账号仍显示已签', /已签/.test(deltaRow?.checkin ?? ''), deltaRow?.checkin)
ck(
  '余额增量不渲染成 +$ 奖励',
  !/\+\$/.test(deltaRow?.checkin ?? '') && !(deltaRow?.amounts ?? []).some((a) => /\+\$/.test(a)),
  JSON.stringify({ checkin: deltaRow?.checkin, amounts: deltaRow?.amounts })
)

// 2) 站点给的金额正常显示
const siteRow = byLabel('demo-site-reward')
ck('站点奖励显示「今日已签」', /今日已签/.test(siteRow?.checkin ?? ''), siteRow?.checkin)
ck('站点奖励渲染 +$25.00', /\+\$25\.00/.test(siteRow?.checkin ?? ''), siteRow?.checkin)

// 3) 离谱金额不渲染
const badRow = byLabel('demo-bad-amount')
ck(
  '离谱金额（$1036.99）不渲染',
  !(badRow?.checkin ?? '').includes('1036') && !(badRow?.amounts ?? []).some((a) => a.includes('1036')),
  JSON.stringify({ checkin: badRow?.checkin, amounts: badRow?.amounts })
)
ck('离谱金额的账号仍显示已签', /已签/.test(badRow?.checkin ?? ''), badRow?.checkin)

// 4) 跨天
const staleRow = byLabel('demo-stale-account')
ck('昨天的回执不再显示已签', /未签/.test(staleRow?.checkin ?? ''), staleRow?.checkin)
ck(
  '跨天后不把上次金额算作今日收入',
  !/\+\$/.test(staleRow?.checkin ?? ''),
  staleRow?.checkin
)
ck(
  '悬停提示保留上次签到记录',
  /上次签到/.test(staleRow?.title ?? '') && staleRow.title.includes(yesterday),
  staleRow?.title
)

// 5) 未签
const pendingRow = byLabel('demo-pending-account')
ck('无回执的账号显示未签', /未签/.test(pendingRow?.checkin ?? ''), pendingRow?.checkin)

// ---- 批量签到：已签账号应被跳过，收尾提示要说明 ----
// toast 只活 3.4 秒，且批量耗时随网络而变；用 MutationObserver 记录所有出现过的文案，
// 不靠「跑完之后再采样」，否则在负载高的机器上会稳定漏掉。
await ev(`(() => {
  window.__toasts = []
  const snap = () => {
    for (const t of document.querySelectorAll('.toast')) {
      const txt = (t.textContent || '').trim()
      if (txt && !window.__toasts.includes(txt)) window.__toasts.push(txt)
    }
  }
  window.__toastObserver = new MutationObserver(snap)
  window.__toastObserver.observe(document.body, { childList: true, subtree: true, characterData: true })
  return true
})()`)

await ev(`[...document.querySelectorAll('.topbar .btn')].find(b=>b.textContent.includes('全部签到'))?.click()`)

// 等到批量结束：先看到进度条，再等它消失（网络慢时可能确实要等一会儿）
for (let i = 0; i < 400; i++) {
  const bar = await ev(`document.querySelectorAll('.batch-bar').length`)
  if (bar === 0) {
    const seen = await ev(`(window.__toasts || []).some(t => /签到完成|已停止签到/.test(t))`)
    if (seen) break
  }
  await sleep(250)
}
await sleep(400)

const toasts = JSON.parse((await ev(`JSON.stringify(window.__toasts || [])`)) || '[]')
const toast = toasts.join(' | ')
ck('批量签到给出收尾提示', /成功 \d+ \/ 5/.test(toast), toast)
ck('收尾提示说明已签账号被自动跳过', /自动跳过/.test(toast), toast)
ck('已签的账号不会被报成失败', !/成功 0 \/ 5/.test(toast), toast)

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failed === 0 ? 0 : 1)
