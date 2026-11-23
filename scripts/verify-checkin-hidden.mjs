import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import http from 'node:http'
import { electronPath } from './electron-path.mjs'

// Real UI and IPC, isolated data, and a local fake site. No real accounts.
const root = process.cwd()
mkdirSync(join(root, '.tmp'), { recursive: true })
const userData = mkdtempSync(join(root, '.tmp', 'checkin-hidden-'))
const posts = { alpha: 0, beta: 0, hidden: 0 }
const actions = { alpha: 0, beta: 0, hidden: 0 }
let holdAlpha = false
let releaseAlpha
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  const [, site, , , endpoint] = new URL(req.url, 'http://localhost').pathname.split('/')
  let data = {}
  if (endpoint === 'checkin') {
    actions[site]++
    if (req.method === 'POST') {
      posts[site]++
      data = { quota_awarded: 500000 }
    } else {
      data = { checked_in_today: false }
    }
  } else if (endpoint === 'self') {
    data = { quota: 500000, used_quota: 0 }
  }
  const reply = () => res.end(JSON.stringify({ success: true, data }))
  if (site === 'alpha' && endpoint === 'checkin' && req.method === 'POST') {
    if (holdAlpha) {
      holdAlpha = false
      releaseAlpha = reply
    } else {
      setTimeout(reply, 120)
    }
  } else {
    reply()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  version: 1,
  credentials: [],
  settings: {
    proxy: { mode: 'direct', url: '' },
    schedule: { enabled: false, time: '00:00', weekdaysOnly: false }
  },
  sites: [
    ['alpha', 'AlphaSite', 2, false],
    ['beta', 'BetaSite', 1, false],
    ['hidden', 'HiddenSite', 1, true]
  ].map(([id, name, count, hidden]) => ({
    id, name, hidden, baseUrl: `${baseUrl}/${id}`,
    mode: 'BUTTON', kind: 'NEWAPI', provider: 'password',
    turnstile: false, quotaPerUnit: 500000,
    accounts: Array.from({ length: count }, (_, i) => ({
      id: `${id}-${i}`, siteId: id, label: `test-user-${id}-${i}`,
      provider: 'password', createdAt: i
    }))
  }))
}))

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [
  join(root, 'out/main/index.js'), `--user-data-dir=${userData}`,
  '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu'
], { cwd: root, env, windowsHide: true, stdio: 'ignore' })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let ws
let id = 0
const pending = new Map()
async function evaluate(expression) {
  const messageId = ++id
  const response = new Promise((resolve) => pending.set(messageId, resolve))
  ws.send(JSON.stringify({
    id: messageId, method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true }
  }))
  const result = await response
  assert.ok(!result.error && !result.result?.exceptionDetails, 'renderer evaluation failed')
  return result.result?.result?.value
}
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return
    await sleep(50)
  }
  assert.fail(`timed out: ${expression}`)
}
async function clickBatch() {
  await evaluate(`(() => {
    window.__batchFrames = []
    window.__batchObserver?.disconnect()
    window.__batchObserver = new MutationObserver(() => {
      const bar = document.querySelector('.batch-bar')
      if (bar) window.__batchFrames.push(bar.innerText)
    })
    window.__batchObserver.observe(document.body, {
      childList: true, subtree: true, attributes: true, characterData: true
    })
    const button = [...document.querySelectorAll('.topbar .btn')]
      .find(b => b.textContent.includes('全部签到'))
    if (!button || button.disabled) throw new Error('batch button unavailable')
    button.click()
  })()`)
  await waitFor(`window.__batchFrames.length > 0 && !document.querySelector('.batch-bar')`)
}
const deadline = setTimeout(() => {
  console.error('FAIL  hidden check-in verification timed out')
  child.kill()
  process.exit(1)
}, 45_000)
try {
  let page
  for (let i = 0; i < 100; i++) {
    try {
      const port = Number((await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = list.find((item) => item.type === 'page')
      if (page) break
    } catch {}
    await sleep(100)
  }
  assert.ok(page, 'application renderer did not start')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('message', (event) => {
    const response = JSON.parse(event.data)
    if (pending.has(response.id)) {
      pending.get(response.id)(response)
      pending.delete(response.id)
    }
  })
  await once(ws, 'open')
  await waitFor(`document.querySelectorAll('.account-row').length === 3`)

  await clickBatch()
  assert.deepEqual(posts, { alpha: 2, beta: 1, hidden: 0 })
  assert.equal(actions.hidden, 0, 'hidden site must not even read check-in status')
  let frames = await evaluate('window.__batchFrames')
  assert.ok(frames.some((text) => /\/ 3/.test(text)), 'progress must count visible accounts only')
  assert.ok(frames.every((text) => !/HiddenSite|\/ 4/.test(text)))
  console.log('PASS  UI batch and progress exclude hidden accounts')

  await evaluate(`[...document.querySelectorAll('.topbar .btn')]
    .find(b => b.textContent.includes('已收起')).click()`)
  await waitFor(`document.querySelectorAll('.account-row').length === 4`)
  await clickBatch()
  frames = await evaluate('window.__batchFrames')
  assert.ok(frames.some((text) => /\/ 3/.test(text)))
  assert.ok(frames.every((text) => !/HiddenSite|\/ 4/.test(text)))
  assert.equal(actions.hidden, 0)
  console.log('PASS  displaying collapsed sites does not enable their batch check-in')

  const results = await evaluate('window.api.checkinAll()')
  assert.deepEqual(results.map((result) => result.accountId), ['alpha-0', 'alpha-1', 'beta-0'])
  const skipped = await evaluate(`window.api.account.checkin('hidden-0')`)
  assert.equal(skipped.ok, true)
  assert.match(skipped.message, /已隐藏/)
  assert.equal(actions.hidden, 0)
  assert.equal(await evaluate(`window.api.config.get().then(c =>
    c.sites.find(s => s.id === 'hidden').accounts[0].lastCheckin === undefined)`), true)
  console.log('PASS  tray/shared IPC and non-forced account calls exclude hidden sites')

  await evaluate(`document.querySelector('.nav-site-row .nav-item[title="BetaSite"]').click()`)
  await waitFor(`document.querySelectorAll('.account-row').length === 1`)
  await clickBatch()
  frames = await evaluate('window.__batchFrames')
  assert.ok(frames.some((text) => /\/ 1/.test(text)))
  assert.ok(frames.every((text) => !/AlphaSite|HiddenSite/.test(text)))
  assert.deepEqual(posts, { alpha: 2, beta: 1, hidden: 0 })
  await evaluate(`[...document.querySelectorAll('.sidebar .nav-item')]
    .find(b => b.textContent.includes('全部站点')).click()`)
  await waitFor(`document.querySelectorAll('.account-row').length === 4`)
  console.log('PASS  selected-site batches preserve their scope')

  // A batch joins an active account; hiding its sites must stop later accounts.
  holdAlpha = true
  await evaluate(`window.__activeCheckin = window.api.account.checkin('alpha-0', true); void 0`)
  for (let i = 0; i < 100 && !releaseAlpha; i++) await sleep(50)
  assert.ok(releaseAlpha, 'active request was not held')
  await evaluate(`window.__queuedBatch = window.api.checkinAll(); void 0`)
  await evaluate(`window.api.config.updateSite('alpha', {hidden: true})`)
  await evaluate(`window.api.config.updateSite('beta', {hidden: true})`)
  const beforeRelease = { ...posts }
  releaseAlpha()
  releaseAlpha = undefined
  const [, queuedResults] = await evaluate('Promise.all([window.__activeCheckin, window.__queuedBatch])')
  assert.deepEqual(queuedResults.map((result) => result.accountId), ['alpha-0'])
  assert.deepEqual(posts, beforeRelease, 'queued hidden accounts must send no new POST')
  assert.equal(actions.hidden, 0)
  console.log('PASS  sites hidden during an active batch send no subsequent check-in')

  await waitFor(`document.querySelectorAll('.account-row').length === 4`)
  await evaluate(`[...document.querySelectorAll('.topbar .btn')]
    .find(b => b.textContent.includes('全部签到')).click()`)
  await sleep(200)
  assert.equal(await evaluate(`!!document.querySelector('.batch-bar')`), false)
  assert.deepEqual(await evaluate('window.api.checkinAll()'), [])
  assert.deepEqual(posts, beforeRelease)
  console.log('PASS  all-hidden UI and IPC batches are no-ops')

  await evaluate(`window.api.config.updateSite('beta', {hidden: false})`)
  await waitFor(`document.querySelectorAll('.nav-site-row').length === 1`)
  await clickBatch()
  frames = await evaluate('window.__batchFrames')
  assert.ok(frames.some((text) => /\/ 1/.test(text)))
  assert.ok(frames.every((text) => !/AlphaSite|HiddenSite/.test(text)))
  assert.deepEqual(posts, beforeRelease)
  console.log('PASS  restoring a site includes it again and preserves today receipts')
} finally {
  clearTimeout(deadline)
  releaseAlpha?.()
  ws?.close()
  if (child.exitCode === null) {
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }
  server.close()
}
