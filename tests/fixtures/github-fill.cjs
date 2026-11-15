const assert = require('node:assert/strict')
const { BrowserWindow, session } = require('electron')
const { githubLoginScript, githubAuthorizeScript } = require('../../.tmp/oauth-electron.cjs')

exports.verifyGitHubFill = async function verifyGitHubFill() {
  const ses = session.fromPartition('test-github-fill')
  let html = ''
  ses.protocol.handle('https', () => new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  }))
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  const web = win.webContents
  const payload = { username: 'demo-user', password: 'test-password', otp: '123456' }
  let failed = 0
  const passwordForm = `
    <form id="password-form" action="/session" method="post">
      <input id="login_field" name="login">
      <input id="password" name="password" type="password">
      <input id="sign-in" type="submit" name="commit" value="Sign in">
    </form>`
  const otpForm = `
    <form id="otp-form" action="/sessions/two-factor" method="post">
      <input id="app_otp" name="app_otp" autocomplete="one-time-code">
      <button id="verify" type="submit">Verify</button>
    </form>`
  const passkeyForm = `
    <form id="passkey-form" action="/sessions/webauthn" method="post">
      <button id="passkey" type="submit">Sign in with a passkey</button>
    </form>`
  async function load(path, body, setup = '') {
    html = `<!doctype html><html><body>${body}<script>
      window.submits = [];
      window.clicks = [];
      document.addEventListener('submit', event => {
        event.preventDefault();
        window.submits.push(event.target.id);
      });
      document.addEventListener('click', event => {
        const target = event.target.closest('a,button,input[type=submit],summary');
        if (target) window.clicks.push(target.id);
        if (target && target.tagName === 'A') event.preventDefault();
      });
      ${setup}
    </script></body></html>`
    await web.loadURL(`https://github.com${path}`)
  }
  const fill = async (overrides = {}) =>
    JSON.parse(await web.executeJavaScript(githubLoginScript({ ...payload, ...overrides }), true))
  const read = expression => web.executeJavaScript(expression)
  async function test(name, run) {
    try {
      await run()
      console.log(`PASS  GitHub fill: ${name}`)
    } catch (error) {
      failed++
      console.error(`FAIL  GitHub fill: ${name}: ${error.message}`)
    }
  }
  try {
    await test('password submits its own form, not a preceding passkey form', async () => {
      await load('/login', passkeyForm + passwordForm)
      assert.equal((await fill()).step, 'submitted')
      assert.deepEqual(await read('window.submits'), ['password-form'])
      assert.deepEqual(await read('window.clicks'), ['sign-in'])
    })
    await test('TOTP submits its own form, not a preceding passkey form', async () => {
      await load('/sessions/two-factor/app', passkeyForm + otpForm)
      assert.equal((await fill()).step, 'submitted-otp')
      assert.deepEqual(await read('window.submits'), ['otp-form'])
    })
    await test('input-triggered TOTP submission is not clicked a second time', async () => {
      await load('/sessions/two-factor/app', otpForm, `
        document.querySelector('#app_otp').addEventListener('input', event => {
          if (event.target.value.length === 6) event.target.form.requestSubmit();
        });`)
      assert.equal((await fill()).step, 'submitted-otp')
      assert.deepEqual(await read('window.submits'), ['otp-form'])
      assert.deepEqual(await read('window.clicks'), [])
    })
    await test('same-document reinjection does not submit a form twice', async () => {
      await load('/login', passwordForm)
      await fill()
      assert.equal((await fill()).step, 'already-submitted')
      assert.deepEqual(await read('window.submits'), ['password-form'])
    })
    await test('passkey and cancel controls within the password form are excluded', async () => {
      await load('/login', passwordForm.replace('<input id="sign-in"', `
        <button id="key" type="submit" data-action="webauthn#signIn">Use security key</button>
        <button id="cancel" type="submit" name="cancel">Cancel</button>
        <input id="sign-in"`))
      assert.equal((await fill()).step, 'submitted')
      assert.deepEqual(await read('window.clicks'), ['sign-in'])
    })
    await test('missing submit button never falls back to a raw form submission', async () => {
      await load('/login', passwordForm.replace(/<input id="sign-in"[^>]+>/, ''))
      assert.equal((await fill()).step, 'manual')
      assert.deepEqual(await read('window.submits'), [])
    })
    await test('a temporarily disabled submit waits until the form is ready', async () => {
      await load('/login', passwordForm.replace('id="sign-in"', 'id="sign-in" disabled'), `
        setTimeout(() => { document.querySelector('#sign-in').disabled = false; }, 350);`)
      assert.equal((await fill()).step, 'submitted')
      assert.deepEqual(await read('window.submits'), ['password-form'])
    })
    await test('fields belonging to different forms are not filled', async () => {
      await load('/login', `
        <form id="one"><input id="login_field" name="login"></form>
        <form id="two"><input id="password" name="password" type="password">
          <button type="submit">Sign in</button></form>`)
      assert.equal((await fill()).step, 'manual')
      assert.equal(await read("document.querySelector('#password').value"), '')
      assert.deepEqual(await read('window.submits'), [])
    })
    await test('SMS verification never receives a saved TOTP code', async () => {
      await load('/sessions/two-factor/sms', `
        <form id="sms-form"><input id="otp" name="otp" autocomplete="one-time-code">
          <button type="submit">Verify</button></form>`)
      assert.equal((await fill()).step, 'manual')
      assert.equal(await read("document.querySelector('#otp').value"), '')
      assert.deepEqual(await read('window.submits'), [])
    })
    await test('authenticator link is selected by its same-origin app route', async () => {
      await load('/sessions/two-factor', passkeyForm + `
        <a id="app" href="/sessions/two-factor/app">Use an authentication app</a>`)
      assert.equal((await fill()).step, 'switched-2fa')
      assert.deepEqual(await read('window.clicks'), ['app'])
    })
    await test('an external link with an authenticator label is not clicked', async () => {
      await load('/sessions/two-factor', `
        <a id="external" href="https://example.com/sessions/two-factor/app">Authenticator app</a>`)
      assert.equal((await fill()).step, 'manual')
      assert.deepEqual(await read('window.clicks'), [])
    })
    await test('other verification methods expands only once', async () => {
      await load('/sessions/two-factor', `
        <details><summary id="more">Other verification methods</summary>
          <span>Choose a method</span></details>`)
      assert.equal((await fill()).step, 'expanded-2fa')
      assert.equal((await fill()).step, 'manual')
      assert.equal(await read("document.querySelector('details').open"), true)
      assert.deepEqual(await read('window.clicks'), ['more'])
    })
    await test('security-key-only verification without TOTP is handed to the user', async () => {
      await load('/sessions/two-factor', passkeyForm)
      assert.equal((await fill({ otp: undefined })).step, 'need-otp')
      assert.deepEqual(await read('window.clicks'), [])
    })
    await test('GitHub unexpected-browser page is reported without submitting', async () => {
      await load('/login/oauth/authorize', `
        <h1>What?</h1><p>Your browser did something unexpected. Please try again.</p>`)
      const state = JSON.parse(await web.executeJavaScript(githubAuthorizeScript(), true))
      assert.equal(state.step, 'browser-error')
      assert.deepEqual(await read('window.submits'), [])
    })
    assert.equal(failed, 0, `${failed} GitHub form regression(s)`)
  } finally {
    win.destroy()
    ses.protocol.unhandle('https')
  }
}
