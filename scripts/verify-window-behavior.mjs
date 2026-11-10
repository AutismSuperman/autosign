import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
mkdirSync('.tmp', { recursive: true })
const userData = mkdtempSync(join(root, '.tmp', 'window-behavior-'))
// Old configuration has no closeAction; upgrades must preserve background behavior.
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  version: 1, sites: [], credentials: [], settings: { theme: 'dark' }
}))
writeFileSync(join(userData, 'window-state.json'), JSON.stringify({
  x: 40, y: 40, width: 1040, height: 640, maximized: false
}))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const args = [join(root, 'tests/fixtures/window-behavior.cjs'), `--user-data-dir=${userData}`, '--no-sandbox', '--disable-gpu']
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let child
let ws
let port
let id = 0
const pending = new Map()
async function launch() {
  child = spawn(electronPath, [...args, '--remote-debugging-port=0'], {
    cwd: root, env, windowsHide: true, stdio: 'ignore'
  })
  let page
  for (let i = 0; i < 100; i++) {
    try {
      port = Number((await readFile(join(userData, 'DevToolsActivePort'), 'utf8')).split('\n')[0])
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = pages.find(item => item.type === 'page')
      if (page) break
    } catch {}
    await sleep(100)
  }
  assert.ok(page, 'renderer must start')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.addEventListener('message', event => {
    const response = JSON.parse(event.data)
    if (pending.has(response.id)) {
      pending.get(response.id)(response)
      pending.delete(response.id)
    }
  })
  await new Promise(resolve => ws.addEventListener('open', resolve, { once: true }))
  await waitFor("!!document.querySelector('.shell')")
}
function send(method, params = {}) {
  const messageId = ++id
  const response = new Promise(resolve => pending.set(messageId, resolve))
  ws.send(JSON.stringify({ id: messageId, method, params }))
  return response
}
async function ev(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  assert.ok(!response.error && !response.result?.exceptionDetails, 'renderer evaluation failed')
  return response.result.result.value
}
async function waitFor(expression) {
  for (let i = 0; i < 100; i++) {
    if (await ev(expression)) return
    await sleep(50)
  }
  assert.fail(`timed out: ${expression}`)
}
async function capture(name) {
  await sleep(250)
  const response = await send('Page.captureScreenshot')
  writeFileSync(join(root, '.tmp', name), Buffer.from(response.result.data, 'base64'))
}
async function stopped(process) {
  if (process.exitCode !== null) return
  let timeout
  try {
    await Promise.race([
      once(process, 'exit'),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('window did not quit')), 7000) })
    ])
  } finally { clearTimeout(timeout) }
}
const deadline = setTimeout(() => { child?.kill(); process.exit(1) }, 60_000)
try {
  await launch()
  assert.equal(await ev('window.api.config.get().then(c => c.settings.closeAction)'), 'background')
  assert.equal(await ev("document.querySelectorAll('.window-control').length"), 3)
  if (process.platform !== 'linux') {
    await ev("document.querySelector('[aria-label=\"最大化\"]').click()")
    await waitFor('window.windowControls.state().then(s => s.maximized)')
    await ev("document.querySelector('[aria-label=\"还原窗口\"]').click()")
    await waitFor('window.windowControls.state().then(s => !s.maximized)')
    console.log('PASS custom maximize/restore controls')
  } else {
    console.log('SKIP maximize/restore on Linux without a window manager')
  }
  console.log('PASS custom controls render; legacy configuration defaults to background')

  await ev("document.querySelector('[title=\"设置\"]').click()")
  await waitFor("!!document.querySelector('[aria-label=\"关闭窗口时\"]')")
  await ev(`(() => {
    const input = document.querySelector('[aria-label="执行时间"]')
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '09:17')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await ev(`(() => {
    document.querySelector('[aria-label="执行时间"]').blur()
    const label = [...document.querySelectorAll('.check-label')].find(e => e.textContent.includes('仅工作日'))
    label.querySelector('input').click()
  })()`)
  await waitFor("window.api.config.get().then(c => c.settings.schedule.time === '09:17' && c.settings.schedule.weekdaysOnly)")
  await ev(`(() => {
    const input = document.querySelector('[aria-label="执行时间"]')
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '25:99')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await ev("document.querySelector('[aria-label=\"执行时间\"]').blur()")
  await waitFor("document.querySelector('[aria-label=\"执行时间\"]').value === '09:17'")
  assert.equal(await ev('window.api.config.get().then(c => c.settings.schedule.time)'), '09:17')
  console.log('PASS time edit survives an immediate weekday toggle; invalid input preserves the saved time')
  await ev("document.querySelector('[aria-label=\"关闭窗口时\"]').scrollIntoView({block:'center',behavior:'instant'})")
  await sleep(250)
  await capture('window-settings-dark.png')
  await ev("window.api.config.updateSettings({theme:'light'})")
  await waitFor("document.documentElement.dataset.theme === 'light'")
  await capture('window-settings-light.png')
  assert.equal(await ev("document.querySelectorAll('input[type=time]').length"), 0)
  await sleep(200)
  assert.equal(await ev("document.documentElement.scrollWidth <= innerWidth"), true)
  assert.equal(await ev(`(() => {
    const row = document.querySelector('[aria-label="关闭窗口时"]')
    const r = row.getBoundingClientRect()
    return r.right <= innerWidth && row.scrollWidth <= row.clientWidth
  })()`), true)
  assert.equal(await ev(`[...document.querySelectorAll('.settings-panel .field')].every(row => {
    const text = row.querySelector('.field-text'), body = row.querySelector('.field-body')
    return !text || !body || text.getBoundingClientRect().right <= body.getBoundingClientRect().left
  })`), true, 'setting descriptions must not overlap their controls')
  await capture('window-settings-compact.png')

  await ev(`[...document.querySelectorAll('.settings-panel button')].find(b => b.textContent.includes('重启安装')).click()`)
  await waitFor("!!document.querySelector('.modal')")
  assert.equal(await ev("window.api.update.current().then(s => s.testInstalls)"), 0)
  assert.equal(await ev("document.querySelector('.modal').textContent.includes('正在进行的任务会中断')"), true)
  await capture('window-update-confirm.png')
  await ev("document.querySelector('.modal-x').click()")
  assert.equal(await ev("window.api.update.current().then(s => s.testInstalls)"), 0)
  await ev(`[...document.querySelectorAll('.settings-panel button')].find(b => b.textContent.includes('重启安装')).click()`)
  await waitFor("!!document.querySelector('.modal')")
  await ev("document.querySelector('.modal-actions .primary').click()")
  await waitFor("window.api.update.current().then(s => s.testInstalls === 1)")
  console.log('PASS update uses an application modal; cancel never installs and confirm installs once')

  await ev("document.querySelector('[aria-label=\"关闭窗口\"]').click()")
  await waitFor("document.visibilityState === 'hidden'")
  assert.equal(child.exitCode, null)
  const reopened = spawn(electronPath, args, { cwd: root, env, windowsHide: true, stdio: 'ignore' })
  await stopped(reopened)
  await waitFor("document.visibilityState === 'visible'")
  console.log('PASS close hides without exiting; second launch restores the window')

  await ev(`[...document.querySelectorAll('[aria-label="关闭窗口时"] button')].find(b => b.textContent.includes('直接退出')).click()`)
  await waitFor("window.api.config.get().then(c => c.settings.closeAction === 'quit')")
  void ev("document.querySelector('[aria-label=\"关闭窗口\"]').click()").catch(() => {})
  await stopped(child)
  assert.equal(JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8')).settings.closeAction, 'quit')
  ws.close()
  console.log('PASS selecting quit persists the setting and close terminates the process')

  await launch()
  assert.equal(await ev('window.api.config.get().then(c => c.settings.closeAction)'), 'quit')
  void ev("window.windowControls.command('close')").catch(() => {})
  await stopped(child)
  console.log('PASS quit preference survives restart')
} finally {
  clearTimeout(deadline)
  ws?.close()
  if (child?.exitCode === null) { child.kill(); await stopped(child) }
}
