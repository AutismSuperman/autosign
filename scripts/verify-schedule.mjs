import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import http from 'node:http'
import { electronPath } from './electron-path.mjs'

// Real application/IPC with a local fake site. No external requests or real accounts.
const root = process.cwd()
mkdirSync(join(root, '.tmp'), { recursive: true })
const userData = mkdtempSync(join(root, '.tmp', 'schedule-ui-'))
let posts = 0
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url.startsWith('/api/user/checkin') && req.method === 'POST') {
    posts++
    res.end(JSON.stringify({ success: true, data: { quota_awarded: 500000 } }))
  } else if (req.url.startsWith('/api/user/checkin')) {
    res.end(JSON.stringify({ success: true, data: { checked_in_today: posts > 0 } }))
  } else if (req.url.startsWith('/api/log/self')) {
    res.end(JSON.stringify({ success: true, data: [] }))
  } else if (req.url.startsWith('/api/user/self')) {
    res.end(JSON.stringify({ success: true, data: { quota: 500000, used_quota: 0 } }))
  } else {
    res.end(JSON.stringify({ success: true, data: {} }))
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  version: 1, credentials: [],
  settings: { proxy: { mode: 'direct', url: '' }, schedule: { enabled: false, time: '00:00', weekdaysOnly: false } },
  sites: [{
    id: 'test-site', name: 'Test', baseUrl, mode: 'BUTTON', kind: 'NEWAPI',
    provider: 'password', turnstile: false, quotaPerUnit: 500000,
    accounts: [{ id: 'test-account', siteId: 'test-site', label: 'demo-user', provider: 'password', createdAt: 0 }]
  }]
}))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
let child
let ws
let id = 0
const pending = new Map()
let port
async function launch() {
  // Let the OS select an available debugging port, then read Electron's port file.
  child = spawn(electronPath, [
    join(root, 'out/main/index.js'), `--user-data-dir=${userData}`,
    '--remote-debugging-port=0', '--no-sandbox', '--disable-gpu'
  ], { cwd: root, env, windowsHide: true, stdio: 'ignore' })
  const { readFile } = await import('node:fs/promises')
  let page
  for (let i = 0; i < 100; i++) {
    try {
      port = Number((await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
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
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }))
}
async function evaluate(expression) {
  const messageId = ++id
  const response = new Promise((resolve) => pending.set(messageId, resolve))
  ws.send(JSON.stringify({
    id: messageId, method: 'Runtime.evaluate',
    params: { expression, awaitPromise: true, returnByValue: true }
  }))
  const result = await response
  if (result.error || result.result?.exceptionDetails) throw new Error('renderer evaluation failed')
  return result.result?.result?.value
}
async function close() {
  ws?.close()
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit')
    child.kill()
    await exited
  }
}
const deadline = setTimeout(() => {
  console.error('FAIL  schedule verification timed out')
  child?.kill()
  process.exit(1)
}, 45_000)
try {
  await launch()
  await sleep(500)
  assert.equal(posts, 0, 'disabled schedule must not check in')
  await evaluate(`window.api.config.updateSettings({schedule:{enabled:true,time:'00:00',weekdaysOnly:false}})`)
  let signed = false
  for (let i = 0; i < 100; i++) {
    signed = await evaluate(`window.api.config.get().then(c => !!c.sites[0].accounts[0].lastCheckin?.ok)`)
    if (signed) break
    await sleep(100)
  }
  assert.equal(signed, true, 'enabling schedule must catch up today')
  assert.equal(posts, 1)
  console.log('PASS  enabling schedule through real IPC catches up and persists a receipt')
  await evaluate(`window.api.config.updateSettings({schedule:{enabled:false,time:'00:00',weekdaysOnly:false}})`)
  await evaluate(`window.api.config.updateSettings({schedule:{enabled:true,time:'00:00',weekdaysOnly:false}})`)
  await sleep(500)
  assert.equal(posts, 1, 'settings changes must not repeat a successful check-in')
  console.log('PASS  disabling/re-enabling schedule preserves successful check-ins')
  await close()
  await launch()
  await sleep(1000)
  assert.equal(posts, 1, 'restart must not repeat completed account')
  console.log('PASS  application restart skips today completed account')
} finally {
  clearTimeout(deadline)
  await close()
  server.close()
}
