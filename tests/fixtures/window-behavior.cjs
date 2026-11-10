const { app, ipcMain } = require('electron')
const { join } = require('node:path')
app.setAppPath(process.cwd())
const handle = ipcMain.handle.bind(ipcMain)
let installs = 0
// Substitute only the update service; the window lifecycle and IPC remain real.
ipcMain.handle = (channel, listener) => {
  if (channel === 'update:status') {
    return handle(channel, () => ({ state: 'ready', version: '0.0.0-test', testInstalls: installs }))
  }
  if (channel === 'update:install') return handle(channel, () => { installs++ })
  return handle(channel, listener)
}
require(join(process.cwd(), 'out/main/index.js'))
