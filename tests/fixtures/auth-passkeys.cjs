const assert = require('node:assert/strict')
const { BrowserWindow, session } = require('electron')
const { createAuthWindow } = require('../../.tmp/oauth-electron.cjs')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

exports.verifyAuthPasskeys = async function verifyAuthPasskeys() {
  const ses = session.fromPartition('test-auth-passkeys')
  const windows = []
  const html = `<!doctype html><html><body>
    <button id="create" style="width:160px;height:40px">Create test passkey</button>
    <button id="get" style="width:160px;height:40px">Use test passkey</button>
    <script>
      let credentialId;
      window.passkey = async (method, mediation) => {
        if (typeof PublicKeyCredential === 'undefined') return 'unavailable';
        const publicKey = method === 'create' ? {
          challenge: new Uint8Array([1, 2, 3, 4]),
          rp: { name: 'Test', id: 'github.com' },
          user: { id: new Uint8Array([1]), name: 'test-user', displayName: 'Test user' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
          authenticatorSelection: {
            authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required'
          },
          timeout: 1000
        } : {
          challenge: new Uint8Array([5, 6, 7, 8]), rpId: 'github.com',
          allowCredentials: credentialId ? [{ type: 'public-key', id: credentialId }] : [],
          userVerification: 'required', timeout: 1000
        };
        try {
          const result = await navigator.credentials[method]({ publicKey, mediation });
          if (!result) return 'empty';
          credentialId = result.rawId;
          return 'allowed';
        } catch (error) {
          window.passkeyError = error.message;
          return error.name;
        }
      };
      window.initialAttempts = Promise.all([
        passkey('get'), passkey('create'), passkey('get', 'conditional')
      ]);
      for (const method of ['create', 'get']) {
        document.querySelector('#' + method).addEventListener('click', event => {
          window.lastClick = {
            trusted: event.isTrusted, active: navigator.userActivation.isActive,
            focused: document.hasFocus()
          };
          window.manualResult = passkey(method);
        });
      }
    </script></body></html>`
  ses.protocol.handle('https', () => new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  }))
  async function virtualAuthenticator(web) {
    web.debugger.attach('1.3')
    await web.debugger.sendCommand('WebAuthn.enable', { enableUI: false })
    await web.debugger.sendCommand('WebAuthn.addVirtualAuthenticator', {
      options: {
        protocol: 'ctap2', transport: 'internal',
        hasResidentKey: true, hasUserVerification: true,
        isUserVerified: true, automaticPresenceSimulation: true
      }
    })
  }
  async function load(win, web) {
    const errors = []
    web.on('preload-error', (_event, _path, error) => errors.push(error.message))
    await virtualAuthenticator(web)
    await web.loadURL('https://github.com/login')
    assert.deepEqual(errors, [], 'authorization preload must load before page scripts')
    assert.equal(win.isVisible(), false)
  }
  async function click(web, id) {
    await web.executeJavaScript('window.manualResult = undefined')
    const point = await web.executeJavaScript(`(() => {
      const r = document.querySelector('#${id}').getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`)
    web.focus()
    web.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    web.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    for (let i = 0; i < 50; i++) {
      if (await web.executeJavaScript('window.manualResult !== undefined')) {
        return web.executeJavaScript('window.manualResult')
      }
      await sleep(20)
    }
    throw new Error('trusted click did not reach the authorization page')
  }
  try {
    const hidden = createAuthWindow(ses, 'Test silent authorization', true)
    windows.push(hidden.win)
    await load(hidden.win, hidden.web)
    assert.deepEqual(await hidden.web.executeJavaScript('window.initialAttempts'), [
      'unavailable', 'unavailable', 'unavailable'
    ])
    hidden.win.destroy()
    console.log('PASS  passkeys: silent authorization disables native WebAuthn before page scripts')

    const interactive = createAuthWindow(ses, 'Test manual authorization', false)
    windows.push(interactive.win)
    const { win, web } = interactive
    const modeSignals = []
    const send = web.send.bind(web)
    web.send = (channel, ...args) => {
      if (channel === 'auth-window:interactive') modeSignals.push(args[0])
      send(channel, ...args)
    }
    await load(win, web)
    assert.deepEqual(await web.executeJavaScript('window.initialAttempts'), [
      'NotAllowedError', 'NotAllowedError', 'NotAllowedError'
    ])
    assert.equal(await web.executeJavaScript('typeof window.api'), 'undefined')
    assert.equal(await web.executeJavaScript('typeof window.windowControls'), 'undefined')
    assert.equal(await web.executeJavaScript("passkey('get')", true), 'NotAllowedError')
    console.log('PASS  passkeys: hidden autofill rejects eager and conditional requests without a privileged bridge')

    win.show()
    await sleep(150)
    assert.equal(await web.executeJavaScript("passkey('create')", true), 'NotAllowedError')
    assert.equal(await web.executeJavaScript(`(() => {
      document.querySelector('#create').click();
      return window.manualResult;
    })()`, true), 'NotAllowedError')
    console.log('PASS  passkeys: showing a window or injecting a synthetic click does not authorize a native prompt')

    assert.equal(await click(web, 'create'), 'allowed', await web.executeJavaScript(
      'JSON.stringify({ error: window.passkeyError, click: window.lastClick })'
    ) + ` mode signals: ${JSON.stringify(modeSignals)}; visible: ${win.isVisible()}`)
    assert.equal(await click(web, 'get'), 'allowed')
    console.log('PASS  passkeys: real user clicks can create and use a passkey after handover')
    assert.equal(await web.executeJavaScript("passkey('get')", true), 'NotAllowedError')
    console.log('PASS  passkeys: completed authentication cannot prompt again without a new real user interaction')

    win.hide()
    await sleep(100)
    assert.equal(await web.executeJavaScript("passkey('get')", true), 'NotAllowedError')
    await web.loadURL('https://github.com/sessions/two-factor')
    assert.deepEqual(await web.executeJavaScript('window.initialAttempts'), [
      'NotAllowedError', 'NotAllowedError', 'NotAllowedError'
    ])
    console.log('PASS  passkeys: hiding and navigating reset the guard even after successful manual authentication')
    if (process.platform === 'win32') {
      win.show()
      await sleep(100)
      assert.equal(await click(web, 'create'), 'allowed')
      win.minimize()
      await sleep(100)
      assert.equal(await web.executeJavaScript("passkey('get')", true), 'NotAllowedError')
      win.restore()
      await sleep(100)
      assert.equal(await click(web, 'get'), 'allowed')
      console.log('PASS  passkeys: minimizing revokes permission and restoring requires another real click')
    }
  } finally {
    for (const win of windows) if (!win.isDestroyed()) win.destroy()
    ses.protocol.unhandle('https')
    assert.equal(BrowserWindow.getAllWindows().length, 0)
  }
}
