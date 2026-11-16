const assert = require('node:assert/strict')
const http = require('node:http')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app, BrowserWindow, ipcMain, safeStorage, session } = require('electron')
const { recoverOnce } = require('../../.tmp/oauth-electron.cjs')

const root = process.cwd()
const data = join(root, '.tmp', `reauth-success-data-${process.pid}`)
app.setPath('userData', data)
app.setAppPath(root)
app.disableHardwareAcceleration()
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

const handlers = new Map()
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => {
  handlers.set(channel, listener)
  return handle(channel, listener)
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let passwordLogins = 0
let oauthExchanges = 0
let holdSelf = false
let heldResponse
let expireSelf = false
const quotaFailure = { success: false, message: 'test quota lookup temporarily unavailable' }
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  const json = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  if (path === '/api/oauth/state') return json(200, { success: true, data: 'test-state' }, {
    'Set-Cookie': 'oauth_state=test-state; Path=/; HttpOnly; SameSite=Lax'
  })
  if (path === '/api/status') return json(200, { data: { github_client_id: 'test-client' } })
  if (path === '/provider') {
    res.writeHead(302, { Location: '/oauth/github?code=test-code&state=test-state' })
    return res.end()
  }
  if (path === '/api/oauth/github') {
    oauthExchanges++
    return json(200, { success: true, data: { id: 'test-oauth-user', username: 'demo-oauth-user' } }, {
      'Set-Cookie': 'session=test-oauth-session; Path=/; HttpOnly; SameSite=Lax'
    })
  }
  if (path === '/api/user/login') {
    passwordLogins++
    return json(200, { success: true, data: { id: 'test-password-user', username: 'demo-password-user' } }, {
      'Set-Cookie': 'session=test-password-session; Path=/; HttpOnly; SameSite=Lax'
    })
  }
  if (path === '/api/user/self') {
    if (expireSelf) return json(401, { success: false, message: 'unauthorized' })
    if (holdSelf) {
      holdSelf = false
      heldResponse = res
      return
    }
    return json(200, quotaFailure)
  }
  res.writeHead(404)
  res.end()
})

async function config() {
  return handlers.get('config:get')({})
}

async function main() {
  await app.whenReady()
  assert.ok(safeStorage.isEncryptionAvailable(), 'test credentials require OS encryption')
  if (process.platform === 'linux') {
    assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text', 'test credentials require a system keyring')
  }
  const seal = value => 'enc:v1:' + safeStorage.encryptString(value).toString('base64')
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const now = Date.now()
  const receipt = { at: now - 1000, date: '2000-01-01', ok: true, message: 'test receipt', rewardSource: 'site' }
  const account = (id, provider, credentialId) => ({
    id, siteId: 'test-site', label: `demo-${provider}-user`, provider, credentialId,
    cookie: seal('session=test-expired-session'), createdAt: now - 2000,
    needsRelogin: true, autoRecoveryBlocked: true, lastCheckin: receipt,
    lastStatus: {
      at: now - 1000, ok: false, error: 'test prior authentication failure', available: 10, used: 1
    }
  })
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'config.json'), JSON.stringify({
    version: 1,
    sites: [{
      id: 'test-site', name: 'Test', baseUrl, kind: 'NEWAPI', mode: 'BUTTON',
      quotaPerUnit: 500000, turnstile: false, provider: 'github',
      accounts: [
        account('test-oauth-account', 'github'),
        account('test-password-account', 'password', 'test-credential'),
        { ...account('test-manual-account', 'github', 'test-github-credential'), autoRecoveryBlocked: false }
      ]
    }],
    credentials: [{
      id: 'test-credential', provider: 'password', username: 'demo-user',
      password: seal('test-password'), createdAt: now
    }, {
      id: 'test-github-credential', provider: 'github', username: 'demo-github-user', createdAt: now
    }],
    settings: { proxy: { mode: 'direct', url: '' }, schedule: { enabled: false }, theme: 'dark' }
  }))
  const ses = session.fromPartition('persist:account-test-site_test-oauth-account')
  await ses.setProxy({ mode: 'direct' })
  await ses.cookies.set({
    url: 'https://github.com/', name: 'user_session', value: 'test-provider-session', secure: true
  })
  ses.webRequest.onBeforeRequest({ urls: ['https://github.com/*'] }, (_details, callback) => {
    callback({ redirectURL: `${baseUrl}/provider` })
  })
  require(join(root, 'out/main/index.js'))
  for (let i = 0; i < 100; i++) {
    if (handlers.has('account:login') && BrowserWindow.getAllWindows().length > 0) break
    await sleep(20)
  }
  assert.ok(handlers.has('account:login'), 'real main-process IPC must initialize')
  const login = handlers.get('account:login')
  const oauth = await login({}, 'test-site', 'github', undefined, 'test-oauth-account')
  assert.equal(oauth.ok, true, oauth.error)
  assert.equal(oauth.account.lastStatus.ok, false, 'quota failure must not be reported as quota success')
  assert.equal(oauthExchanges, 1)
  let stored = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
  assert.equal(stored.sites[0].accounts[0].needsRelogin, false)
  assert.equal(stored.sites[0].accounts[0].autoRecoveryBlocked, false)
  assert.equal(stored.sites[0].accounts[0].cookie.startsWith('enc:v1:'), true)
  assert.deepEqual(stored.sites[0].accounts[0].lastCheckin, receipt)
  assert.equal(stored.sites[0].accounts[0].lastStatus.error, oauth.account.lastStatus.error)
  assert.equal(stored.sites[0].accounts[0].lastStatus.available, 10)
  console.log('PASS  reauthorization: successful OAuth clears the old retry flag even when quota lookup fails')

  holdSelf = true
  const status = handlers.get('account:status')({}, 'test-password-account')
  for (let i = 0; i < 100 && !heldResponse; i++) await sleep(20)
  assert.ok(heldResponse, 'in-flight old-session quota request must reach the test server')
  const password = login({}, 'test-site', 'password', 'test-credential', 'test-password-account')
  await sleep(100)
  assert.equal(passwordLogins, 0, 'manual login must wait for the existing account operation')
  heldResponse.writeHead(200, { 'Content-Type': 'application/json' })
  heldResponse.end(JSON.stringify(quotaFailure))
  await status
  const result = await password
  assert.equal(result.ok, true, result.error)
  assert.equal(result.account.lastStatus.ok, false)
  assert.equal(passwordLogins, 1)
  stored = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
  assert.equal(stored.sites[0].accounts[1].needsRelogin, false)
  assert.equal(stored.sites[0].accounts[1].autoRecoveryBlocked, false)
  assert.deepEqual(stored.sites[0].accounts[1].lastCheckin, receipt)
  assert.equal(stored.sites[0].accounts[1].lastStatus.error, result.account.lastStatus.error)
  assert.equal(stored.sites[0].accounts[1].lastStatus.available, 10)
  console.log('PASS  reauthorization: password login is serialized with old requests and clears the flag before quota succeeds')

  const manualSes = session.fromPartition('persist:account-test-site_test-manual-account')
  await manualSes.setProxy({ mode: 'direct' })
  await manualSes.cookies.set({
    url: 'https://github.com/', name: 'user_session', value: 'test-provider-session', secure: true
  })
  let providerPages = 0
  manualSes.protocol.handle('https', () => {
    providerPages++
    return new Response('<!doctype html><html><body>Test device verification</body></html>', {
      headers: { 'Content-Type': 'text/html' }
    })
  })
  manualSes.webRequest.onBeforeRequest({
    urls: ['https://github.com/login/oauth/authorize*']
  }, (_details, callback) => {
    callback({ redirectURL: 'https://github.com/sessions/verified-device' })
  })
  expireSelf = true
  await handlers.get('account:status')({}, 'test-manual-account')
  stored = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
  assert.equal(stored.sites[0].accounts[2].autoRecoveryBlocked, true)
  const before = providerPages
  assert.ok(before > 0, 'the initial recovery must reach device verification')
  await handlers.get('account:status')({}, 'test-manual-account')
  assert.equal(providerPages, before, 'manual verification must not repeat an automatic password attempt')
  console.log('PASS  reauthorization: real device-verification failure persists a block and stops repeated OAuth')

  const current = await config()
  let retries = 0
  const recovery = await recoverOnce({
    sites: () => current.sites,
    recover: async () => { retries++; return { ok: false } }
  })
  assert.equal(retries, 0)
  assert.equal(recovery.total, 0)
  console.log('PASS  reauthorization: both successful accounts stay out of the next recovery scan')

  await handlers.get('credential:save')({}, {
    id: 'test-github-credential', provider: 'github', username: 'demo-github-user', note: 'test note'
  })
  stored = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
  assert.equal(stored.sites[0].accounts[2].autoRecoveryBlocked, true)
  await handlers.get('credential:save')({}, {
    id: 'test-github-credential', provider: 'github', username: 'demo-github-user',
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  })
  stored = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
  assert.equal(stored.sites[0].accounts[2].autoRecoveryBlocked, false)
  await handlers.get('account:status')({}, 'test-manual-account')
  stored = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
  assert.equal(stored.sites[0].accounts[2].autoRecoveryBlocked, true)
  console.log('PASS  reauthorization: changing notes preserves the block; adding TOTP permits one new attempt')

  expireSelf = false
  manualSes.protocol.unhandle('https')
  manualSes.webRequest.onBeforeRequest({ urls: ['https://github.com/*'] }, (_details, callback) => {
    callback({ redirectURL: `${baseUrl}/provider` })
  })
  const manual = await login({}, 'test-site', 'github', undefined, 'test-manual-account')
  assert.equal(manual.ok, true, manual.error)
  stored = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
  assert.equal(stored.sites[0].accounts[2].autoRecoveryBlocked, false)
  assert.equal(stored.sites[0].accounts[2].needsRelogin, false)
  console.log('PASS  reauthorization: a user-initiated successful login clears the manual block')
}
main().then(
  () => { server.close(); app.exit(0) },
  error => { console.error(`FAIL  ${error.stack}`); server.close(); app.exit(1) }
)
