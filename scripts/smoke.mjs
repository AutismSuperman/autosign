/**
 * 冒烟测试：启动打包后的应用，通过 CDP 验证
 *   1. 窗口与渲染进程正常加载
 *   2. 预加载桥接 window.api 存在且可调用（IPC 往返成功）
 *   3. 主界面外壳渲染完成（.shell 节点存在）
 *
 * 不触网、不读真实凭据。用法：node scripts/smoke.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9444

if (!existsSync(electron)) {
  console.error('FAIL: 未找到 Electron 可执行文件，请先安装依赖')
  process.exit(1)
}
if (!existsSync(main)) {
  console.error('FAIL: 未找到 out/main/index.js，请先 npm run build')
  process.exit(1)
}

const userData = join(root, '.smoke-user-data')
rmSync(userData, { recursive: true, force: true })

const child = spawn(
  electron,
  [main, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'],
  { cwd: root, env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }
)

let output = ''
child.stdout.on('data', (d) => (output += d.toString()))
child.stderr.on('data', (d) => (output += d.toString()))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && !t.url.startsWith('devtools'))
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      // 调试端口尚未就绪
    }
    await sleep(400)
  }
  return null
}

function connect(url) {
  const ws = new WebSocket(url)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  })
  const ready = new Promise((resolve) => ws.addEventListener('open', resolve))
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id
      pending.set(i, resolve)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  return { ready, send, close: () => ws.close() }
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  console.error('--- 进程输出 ---')
  console.error(output.slice(0, 4000))
  child.kill()
  process.exit(1)
}

const run = async () => {
  const page = await findPage()
  if (!page) fail('渲染进程未启动或调试端口不可达')

  const cdp = connect(page.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')

  // 等界面完成首次渲染（config 通过 IPC 拉取后才渲染 .shell）
  let shellReady = false
  for (let i = 0; i < 25; i++) {
    const r = await cdp.send('Runtime.evaluate', {
      expression: '!!document.querySelector(".shell")',
      returnByValue: true
    })
    if (r.result?.result?.value === true) {
      shellReady = true
      break
    }
    await sleep(300)
  }
  if (!shellReady) fail('主界面未渲染出 .shell 外壳')

  const bridge = await cdp.send('Runtime.evaluate', {
    expression:
      'JSON.stringify({hasApi: typeof window.api === "object", keys: window.api ? Object.keys(window.api) : []})',
    returnByValue: true
  })
  const parsed = JSON.parse(bridge.result?.result?.value ?? '{}')
  if (!parsed.hasApi) fail('预加载桥接 window.api 不存在')
  for (const key of ['config', 'account', 'logs', 'proxy', 'app']) {
    if (!parsed.keys.includes(key)) fail(`window.api 缺少 ${key}`)
  }

  // 真正走一次 IPC 往返，确认主进程 handler 已注册
  const roundTrip = await cdp.send('Runtime.evaluate', {
    expression: 'window.api.config.get().then(c => JSON.stringify({version: c.version, sites: c.sites.length}))',
    awaitPromise: true,
    returnByValue: true
  })
  const config = JSON.parse(roundTrip.result?.result?.value ?? 'null')
  if (!config || typeof config.version !== 'number') fail('IPC config.get 往返失败')
  const sidebar = await cdp.send('Runtime.evaluate', {
    expression: 'JSON.stringify({sidebar: !!document.querySelector(".sidebar"), title: document.querySelector(".brand-name")?.textContent})',
    returnByValue: true
  })
  const ui = JSON.parse(sidebar.result?.result?.value ?? '{}')
  if (!ui.sidebar) fail('侧栏未渲染')

  console.log('PASS: 应用启动、界面渲染与 IPC 往返均正常')
  console.log(`  - 界面标题: ${ui.title}`)
  console.log(`  - 配置版本: ${config.version}，站点数: ${config.sites}`)
  console.log('  - 预加载桥接: ok')
  cdp.close()
  child.kill()
  await sleep(600)
  process.exit(0)
}

run().catch((e) => fail(e instanceof Error ? e.message : String(e)))

setTimeout(() => fail('冒烟测试超时（45s）'), 45_000)
