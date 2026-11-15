import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { electronPath } from '../scripts/electron-path.mjs'

mkdirSync('.tmp', { recursive: true })
await build({
  stdin: {
    contents: "export { silentReauth } from './src/main/sites/silentReauth'; export { runOAuth } from './src/main/sites/oauth'; export { createAuthWindow } from './src/main/authWindow'; export { githubLoginScript, githubAuthorizeScript } from './src/main/auth/fill'; export { recoverOnce } from './src/main/sites/keepAlive'",
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
async function verifyFixture(fixture) {
  return new Promise(resolve => {
    const child = spawn(electronPath, [
      join('tests', 'fixtures', fixture), '--disable-gpu', '--no-sandbox',
      `--user-data-dir=${join(process.cwd(), '.tmp', `oauth-verify-data-${process.pid}-${fixture}`)}`
    ], { cwd: process.cwd(), env, windowsHide: true, stdio: 'inherit' })
    const timer = setTimeout(() => {
      console.error(`FAIL  Electron verification timed out: ${fixture}`)
      child.kill()
    }, 60_000)
    child.once('error', error => {
      clearTimeout(timer)
      console.error(error.message)
      resolve(1)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      resolve(code ?? 1)
    })
  })
}
for (const fixture of ['oauth-electron.cjs', 'reauth-success.cjs']) {
  const code = await verifyFixture(fixture)
  if (code !== 0) {
    process.exitCode = code
    break
  }
}
