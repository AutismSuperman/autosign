import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { electronPath } from '../scripts/electron-path.mjs'

mkdirSync('.tmp', { recursive: true })
await build({
  stdin: {
    contents: "export { silentReauth } from './src/main/sites/silentReauth'; export { runOAuth } from './src/main/sites/oauth'; export { createAuthWindow } from './src/main/authWindow'",
    resolveDir: process.cwd()
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/oauth-electron.cjs',
  external: ['electron'],
  logLevel: 'error'
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electronPath, [join('tests', 'fixtures', 'oauth-electron.cjs'), '--disable-gpu', '--no-sandbox'], {
  cwd: process.cwd(), env, windowsHide: true, stdio: 'inherit'
})
const timer = setTimeout(() => {
  console.error('FAIL  Electron OAuth verification timed out')
  child.kill()
}, 30_000)
child.once('error', (error) => {
  clearTimeout(timer)
  console.error(error.message)
  process.exitCode = 1
})
child.once('exit', (code) => {
  clearTimeout(timer)
  process.exitCode = code ?? 1
})
