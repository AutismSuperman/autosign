import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'

// Exercise both entry points with a browser/session double; no real credentials or requests.
const require = createRequire(import.meta.url)
let scenario
class TestWindow extends EventEmitter {
  constructor(options) {
    super()
    this.options = options
    this.destroyed = false
    this.visible = false
    this.url = ''
    this.webContents = new EventEmitter()
    this.webContents.getURL = () => this.url
    this.webContents.executeJavaScript = async (script) => {
      if (script.includes('not-authorize')) return JSON.stringify({ step: 'not-authorize', done: true })
      scenario.loginCalls++
      if (scenario.loginStep) return JSON.stringify({ step: scenario.loginStep, done: true, msg: 'test manual verification' })
      if (scenario.loginCalls === 1) {
        setTimeout(() => {
          this.url = 'https://github.com/sessions/two-factor/app'
          this.webContents.emit('did-finish-load')
        }, 10)
        return JSON.stringify({ step: 'submitted', done: true })
      }
      setTimeout(() => this.redirect(), 10)
      return JSON.stringify({ step: 'submitted-otp', done: true })
    }
    scenario.windows.push(this)
  }
  isDestroyed() { return this.destroyed }
  isVisible() { return this.visible }
  show() { this.visible = true }
  destroy() {
    this.destroyed = true
    this.emit('closed')
  }
  redirect() {
    if (scenario.unrelatedUrl) {
      const unrelated = { prevented: false, preventDefault() { this.prevented = true } }
      this.webContents.emit('will-redirect', unrelated, scenario.unrelatedUrl, false, true)
      assert.equal(unrelated.prevented, false)
    }
    const url = `${scenario.base}/oauth/github?code=test-code&state=${scenario.callbackState}`
    const event = { prevented: false, preventDefault() { this.prevented = true } }
    this.webContents.emit('will-redirect', event, url, false, true)
    scenario.prevented = event.prevented
    if (!event.prevented) scenario.browserExchanges++
    // A duplicate notification must never exchange the same code again.
    this.webContents.emit('will-navigate', event, url)
    this.webContents.emit('did-navigate', {}, url)
    if (scenario.cancelLoad) throw Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED' })
  }
  async loadURL(url) {
    this.url = url
    if (scenario.twoFactor) {
      this.url = 'https://github.com/login'
      this.webContents.emit('did-finish-load')
    } else {
      this.redirect()
    }
  }
}
const fakeSession = {
  setProxy: async () => {},
  cookies: {
    get: async (filter) => filter.url
      ? [{ name: 'session', value: 'test-site-session' }]
      : [{ domain: 'github.com', name: 'user_session', value: 'test-provider-session' }]
  },
  fetch: async (url, options = {}) => {
    const path = new URL(url).pathname
    const reply = (status, data) => ({
      status, ok: status >= 200 && status < 300,
      text: async () => JSON.stringify(data)
    })
    if (path === '/api/oauth/state') {
      assert.ok(options.signal, 'seed requests must have a timeout')
      if (scenario.hangSeed) {
        await new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('test seed timeout')), { once: true })
        })
      }
      scenario.seedMethods.push(options.method)
      if (scenario.getOnly && options.method === 'POST') return reply(405, {})
      return reply(200, scenario.seedPayload)
    }
    if (path === '/api/status') return reply(200, { data: { github_client_id: 'test-client' } })
    if (path === '/api/oauth/github') {
      scenario.exchanges++
      await delay(20)
      if (scenario.exchanges > 1 || scenario.browserExchanges) {
        return reply(400, { success: false, message: 'test code already consumed' })
      }
      if (scenario.exchangeFailure) return reply(409, { success: false, code: 'AUTH_SESSION_LIMIT' })
      return reply(200, {
        success: true,
        data: { accessToken: 'test-access-token', user: { id: scenario.userId ?? 'test-user', username: 'demo-user' } }
      })
    }
    throw new Error(`Unexpected test path: ${path}`)
  }
}
globalThis.__oauthTestElectron = { BrowserWindow: TestWindow, session: { fromPartition: () => fakeSession } }
mkdirSync('.tmp', { recursive: true })
await build({
  stdin: {
    contents: "export { silentReauth } from './src/main/sites/silentReauth'; export { runOAuth } from './src/main/sites/oauth'",
    resolveDir: process.cwd()
  },
  bundle: true, platform: 'node', format: 'cjs', outfile: '.tmp/oauth-flow.cjs', logLevel: 'error',
  plugins: [{
    name: 'test-electron',
    setup(build) {
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'test' }))
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
        contents: 'module.exports = globalThis.__oauthTestElectron', loader: 'js'
      }))
    }
  }]
})
const { silentReauth, runOAuth } = require('../.tmp/oauth-flow.cjs')
const site = { id: 'test-site', name: 'Test', baseUrl: 'https://example.com', provider: 'github' }
const account = { id: 'test-account', siteId: site.id, provider: 'github', siteUserId: 'test-user' }
let failed = 0
async function test(name, options, verify, manual = false) {
  scenario = {
    base: site.baseUrl, callbackState: 'test-state',
    seedPayload: { success: true, data: { flow_token: 'test-state' } },
    exchanges: 0, browserExchanges: 0, windows: [], seedMethods: [], loginCalls: 0,
    ...options
  }
  const credential = scenario.twoFactor
    ? { username: 'demo-user', password: 'test-password', totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }
    : undefined
  const pending = manual
    ? runOAuth(site, account.id, 'github', '', credential)
    : silentReauth(site, account, 'github', { proxy: '', timeoutMs: scenario.timeoutMs ?? 3500, credential })
  // Keep the test alive while the production deadline is unref'ed.
  const guard = setTimeout(() => {
    for (const win of scenario.windows) if (!win.destroyed) win.destroy()
  }, 4500)
  try {
    const result = await pending
    verify(result, scenario)
    assert.ok(scenario.windows.every((win) => win.destroyed), 'windows must be cleaned up')
    console.log(`PASS  ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL  ${name}: ${error.message}`)
  } finally {
    clearTimeout(guard)
  }
}
await test('silent OAuth supports GET-only state endpoints', { getOnly: true }, (result, state) => {
  assert.equal(result.ok, true, result.error)
  assert.deepEqual(state.seedMethods, ['POST', 'GET'])
})
await test('unresponsive seed endpoint times out before opening a window', { hangSeed: true, timeoutMs: 30 }, (result, state) => {
  assert.equal(result.ok, false)
  assert.match(result.error, /test seed timeout/)
  assert.equal(state.windows.length, 0)
  assert.equal(state.exchanges, 0)
})
await test('silent OAuth accepts top-level state', { seedPayload: { success: true, state: 'test-state' } }, (result) => {
  assert.equal(result.ok, true, result.error)
})
await test('callback is intercepted and exchanged once', {}, (result, state) => {
  assert.equal(result.ok, true, result.error)
  assert.equal(state.exchanges, 1)
  assert.equal(state.browserExchanges, 0)
  assert.equal(state.prevented, true)
  assert.ok(state.windows.every((win) => !win.visible))
})
await test('silent OAuth preserves camelCase token and identity', {}, (result) => {
  assert.equal(result.token, 'test-access-token')
  assert.equal(result.siteUserId, 'test-user')
})
await test('cancelled callback navigation does not override exchange', { cancelLoad: true }, (result) => {
  assert.equal(result.ok, true, result.error)
})
await test('mismatched state never reaches the exchange endpoint', { callbackState: 'wrong-state' }, (result, state) => {
  assert.equal(result.ok, false)
  assert.match(result.error, /state/)
  assert.equal(state.exchanges, 0)
  assert.equal(state.browserExchanges, 0)
})
await test('password submission can continue to TOTP', { twoFactor: true }, (result, state) => {
  assert.equal(result.ok, true, result.error)
  assert.equal(state.loginCalls, 2)
})
await test('manual OAuth also consumes the callback only once', {}, (result, state) => {
  assert.equal(result.ok, true, result.error)
  assert.equal(state.exchanges, 1)
  assert.equal(state.browserExchanges, 0)
}, true)
await test('unrelated origins with OAuth parameters are ignored', {
  unrelatedUrl: 'https://other.example.com/oauth/github?code=other-code&state=wrong-state'
}, (result, state) => {
  assert.equal(result.ok, true, result.error)
  assert.equal(state.exchanges, 1)
})
await test('unrelated paths on the site are ignored', {
  unrelatedUrl: `${site.baseUrl}/settings?error=test-error`
}, (result) => {
  assert.equal(result.ok, true, result.error)
})
await test('account identity mismatch is rejected', { userId: 'another-test-user' }, (result) => {
  assert.equal(result.ok, false)
  assert.match(result.error, /身份.*不一致/)
  assert.equal(result.cookie, undefined)
  assert.equal(result.token, undefined)
})
await test('session limit is reported without repeating the exchange', { exchangeFailure: true }, (result, state) => {
  assert.equal(result.ok, false)
  assert.match(result.error, /会话数已达上限/)
  assert.equal(state.exchanges, 1)
})
await test('manual verification stops silent OAuth without showing a window', {
  twoFactor: true, loginStep: 'manual'
}, (result, state) => {
  assert.equal(result.ok, false)
  assert.match(result.error, /test manual verification/)
  assert.equal(state.exchanges, 0)
  assert.ok(state.windows.every((win) => !win.visible))
})
delete globalThis.__oauthTestElectron
if (failed) process.exitCode = 1
