import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const updater = new EventEmitter()
let installs = 0
let opened = 0
updater.checkForUpdates = async () => { updater.emit('update-not-available') }
updater.quitAndInstall = () => { installs++ }
globalThis.__quietUpdater = updater
globalThis.__quietElectron = {
  app: { isPackaged: true, getVersion: () => '0.0.0-test' },
  shell: { openExternal: async () => { opened++ } },
  dialog: { showMessageBox: () => { throw new Error('native dialog must not be used') } },
  Notification: class { constructor() { throw new Error('system notification must not be used') } }
}
mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/updater.ts'], bundle: true, platform: 'node',
  format: 'cjs', outfile: '.tmp/updater-quiet.cjs', logLevel: 'error',
  plugins: [{
    name: 'fake-updater',
    setup(build) {
      build.onResolve({ filter: /^(electron|electron-updater)$/ }, ({ path }) => ({ path, namespace: 'test' }))
      build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({
        contents: path === 'electron'
          ? 'module.exports = globalThis.__quietElectron'
          : 'module.exports = { autoUpdater: globalThis.__quietUpdater }',
        loader: 'js'
      }))
    }
  }]
})
const { initUpdater, checkForUpdates, getUpdateStatus, quitAndInstall } = require('../.tmp/updater-quiet.cjs')
initUpdater()
assert.equal((await checkForUpdates()).state, 'none')
updater.emit('update-available', { version: '0.0.1-test', files: [] })
await new Promise(resolve => setImmediate(resolve))
assert.ok(['available', 'manual'].includes(getUpdateStatus().state))
updater.emit('download-progress', { percent: 50, transferred: 5, total: 10 })
assert.equal(getUpdateStatus().state, 'downloading')
updater.emit('update-downloaded', { version: '0.0.1-test' })
assert.equal(getUpdateStatus().state, 'ready')
assert.equal(installs, 0)
assert.equal(opened, 0)
quitAndInstall()
assert.equal(installs, 1)
updater.emit('error', new Error('test network failure'))
assert.equal(getUpdateStatus().state, 'error')
quitAndInstall()
assert.equal(installs, 1)
console.log('PASS updater: results only update state; install requires an explicit command')
