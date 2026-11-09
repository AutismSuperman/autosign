const assert = require('node:assert/strict')
const http = require('node:http')
const { join } = require('node:path')
const { app, BrowserWindow, session } = require('electron')

app.setPath('userData', join(process.cwd(), '.tmp', `oauth-electron-data-${process.pid}`))
app.on('window-all-closed', () => {})
app.disableHardwareAcceleration()
const { silentReauth } = require('../../.tmp/oauth-electron.cjs')

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
  for (const path of ['/oauth/github', '/api/oauth/github']) {
    scenario = { path, exchanges: 0, pageLoads: 0 }
    const result = await silentReauth(site, account, 'github', { proxy: '', timeoutMs: 5000 })
    assert.equal(result.ok, true, result.error)
    assert.equal(result.token, 'test-access-token')
    assert.equal(result.siteUserId, 'test-user')
    assert.match(result.cookie, /session=test-site-session/)
    assert.equal(scenario.exchanges, 1)
    assert.equal(scenario.pageLoads, 0)
    assert.equal(BrowserWindow.getAllWindows().length, 0)
    console.log(`PASS  real Electron ${path}: one exchange, shared cookies, hidden window cleaned up`)
  }
  assert.equal(providerRequests, 2)
}
main().then(
  () => { server.close(); app.exit(0) },
  (error) => { console.error(`FAIL  ${error.stack}`); server.close(); app.exit(1) }
)
