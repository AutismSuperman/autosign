const assert = require('node:assert/strict')
const http = require('node:http')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { app, BrowserWindow, session, nativeTheme } = require('electron')

app.setPath('userData', join(process.cwd(), '.tmp', `oauth-electron-data-${process.pid}`))
app.setAppPath(process.cwd())
app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()
const { silentReauth, runOAuth, createAuthWindow } = require('../../.tmp/oauth-electron.cjs')

let scenario
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const json = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  if (url.pathname === '/api/oauth/state') {
    if (req.method === 'POST') return json(405, {})
    return json(200, { success: true, data: 'test-state' }, {
      'Set-Cookie': 'oauth_state=test-state; Path=/; HttpOnly; SameSite=Lax'
    })
  }
  if (url.pathname === '/api/status') {
    return json(200, { data: { github_client_id: 'test-client' } })
  }
  if (url.pathname === '/provider') {
    res.writeHead(302, { Location: `${scenario.path}?code=test-code&state=test-state` })
    return res.end()
  }
  if (url.pathname === '/login-demo') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end('<html><body><h1>Demo authorization</h1></body></html>')
  }
  if (url.pathname === '/api/oauth/github') {
    scenario.exchanges++
    if (!(req.headers.cookie || '').includes('oauth_state=test-state')) {
      return json(400, { success: false, message: 'test state cookie missing' })
    }
    if (scenario.exchanges !== 1) {
      return json(400, { success: false, message: 'test code already consumed' })
    }
    return json(200, {
      success: true, data: { accessToken: 'test-access-token', user: { id: 'test-user' } }
    }, { 'Set-Cookie': 'session=test-site-session; Path=/; HttpOnly; SameSite=Lax' })
  }
  if (url.pathname === '/oauth/github') {
    scenario.pageLoads++
    return json(400, { success: false, message: 'callback page must be intercepted' })
  }
  res.writeHead(404)
  res.end()
})

async function main() {
  await app.whenReady()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const site = { id: 'test-site', name: 'Test', baseUrl, provider: 'github' }
  const account = { id: 'test-account', siteId: site.id, provider: 'github', siteUserId: 'test-user' }
  const ses = session.fromPartition(`persist:account-${site.id}_${account.id}`)
  await ses.setProxy({ mode: 'direct' })
  let providerRequests = 0
  ses.webRequest.onBeforeRequest({ urls: ['https://github.com/*'] }, (details, callback) => {
    providerRequests++
    assert.equal(new URL(details.url).searchParams.get('state'), 'test-state')
    callback({ redirectURL: `${baseUrl}/provider` })
  })
  await ses.cookies.set({
    url: 'https://github.com/', name: 'user_session', value: 'test-provider-session', secure: true
  })
  for (const { path, silent } of [
    { path: '/oauth/github', silent: true }, { path: '/api/oauth/github', silent: true },
    { path: '/oauth/github', silent: false }, { path: '/api/oauth/github', silent: false }
  ]) {
    scenario = { path, exchanges: 0, pageLoads: 0 }
    const result = silent
      ? await silentReauth(site, account, 'github', { proxy: '', timeoutMs: 5000 })
      : await runOAuth(site, account.id, 'github', '', undefined, { timeoutMs: 5000 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.token, 'test-access-token')
    assert.equal(result.siteUserId, 'test-user')
    assert.match(result.cookie, /session=test-site-session/)
    assert.equal(scenario.exchanges, 1)
    assert.equal(scenario.pageLoads, 0)
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    console.log(`PASS  real Electron ${path} (${silent ? 'silent' : 'custom window'}): single exchange and cleanup`)
  }
  assert.equal(providerRequests, 4)

  const { win, web } = createAuthWindow(ses, 'Demo authorization', false)
  await web.loadURL(`${baseUrl}/login-demo`)
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript("!!document.querySelector('.window-controls')").catch(() => false)) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(await win.webContents.executeJavaScript("document.querySelectorAll('.window-control').length"), 3)
  assert.equal(await win.webContents.executeJavaScript('typeof window.api'), 'undefined')
  assert.equal(await web.executeJavaScript('typeof window.windowControls'), 'undefined')
  assert.equal(await web.executeJavaScript('typeof window.api'), 'undefined')
  const view = win.contentView.children.find(child => child.webContents === web)
  assert.equal(view.getBounds().y, 44)
  nativeTheme.themeSource = 'light'
  for (let i = 0; i < 50; i++) {
    if (await win.webContents.executeJavaScript("document.documentElement.dataset.theme") === 'light') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.equal(await win.webContents.executeJavaScript("document.documentElement.dataset.theme"), 'light')
  win.show()
  await new Promise(resolve => setTimeout(resolve, 400))
  writeFileSync(join(process.cwd(), '.tmp/auth-window-light.png'), (await win.capturePage()).toPNG())
  writeFileSync(join(process.cwd(), '.tmp/auth-page.png'), (await web.capturePage()).toPNG())
  const destroyed = new Promise(resolve => web.once('destroyed', resolve))
  win.close()
  await destroyed
  assert.equal(BrowserWindow.getAllWindows().length, 0)
  console.log('PASS  authorization shell: themed controls, isolated page, view cleanup on close')
}
main().then(
  () => { server.close(); app.exit(0) },
  (error) => { console.error(`FAIL  ${error.stack}`); server.close(); app.exit(1) }
)
