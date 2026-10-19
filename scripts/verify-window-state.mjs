/**
 * 窗口大小 / 位置记忆的端到端验证。
 *
 * 起因：窗口尺寸写死为 1440×900，用户每次调整后重开都还原，
 * 小屏幕上尤其难受。
 *
 * 本脚本直接预置 `window-state.json` 再启动应用，用真实渲染进程的
 * `outerWidth/outerHeight` 断言窗口按记录恢复；另外验证记录落在
 * 已不存在的显示器上时窗口会被拉回主屏，而不是消失在屏幕外。
 *
 * 运行：node scripts/verify-window-state.mjs（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'

const root = process.cwd()
const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const main = join(root, 'out', 'main', 'index.js')
const userData = join(root, '.verify-window-user-data')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 启动一次应用，返回渲染进程上报的窗口几何，然后关掉它。 */
async function launchAndMeasure(port, state) {
  writeFileSync(join(userData, 'window-state.json'), JSON.stringify(state))
  const child = spawn(
    electron,
    [main, `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu'],
    { cwd: root, stdio: 'ignore' }
  )

  let page
  for (let i = 0; i < 50; i++) {
    try {
      const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      page = l.find((t) => t.type === 'page')
      if (page) break
    } catch {}
    await sleep(400)
  }
  if (!page) {
    child.kill()
    return null
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pend = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m)
      pend.delete(m.id)
    }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = ++id
      pend.set(i, res)
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  await send('Runtime.enable')
  await sleep(1800)
  const raw = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({outerWidth,outerHeight,screenX,screenY,aw:screen.availWidth,ah:screen.availHeight})',
    returnByValue: true
  })
  const value = raw.result?.result?.value
  ws.close()
  child.kill()
  await sleep(600)
  return value ? JSON.parse(value) : null
}

// 1. 记录为 1100×700：窗口应恢复到这个尺寸（outer 含边框，允许少量误差）
const sized = await launchAndMeasure(9481, {
  x: 80,
  y: 60,
  width: 1100,
  height: 700,
  maximized: false
})
ck('应用可启动并上报窗口尺寸', !!sized, sized ? `${sized.outerWidth}x${sized.outerHeight}` : 'null')
if (sized) {
  ck(
    '窗口按记录恢复尺寸',
    Math.abs(sized.outerWidth - 1100) <= 20 && Math.abs(sized.outerHeight - 700) <= 20,
    `${sized.outerWidth}x${sized.outerHeight}`
  )
  ck(
    '窗口未使用写死的默认尺寸',
    Math.abs(sized.outerWidth - 1440) > 20,
    `${sized.outerWidth}`
  )
  ck(
    '窗口位置在屏幕内',
    sized.screenX >= 0 && sized.screenY >= 0,
    `${sized.screenX},${sized.screenY}`
  )
}

// 2. 记录落在已拔掉的外接屏（x=9999）：应被拉回主屏，而不是消失
const offscreen = await launchAndMeasure(9482, {
  x: 9999,
  y: 9999,
  width: 1100,
  height: 700,
  maximized: false
})
ck('屏幕外的记录也能启动', !!offscreen, offscreen ? `${offscreen.screenX},${offscreen.screenY}` : 'null')
if (offscreen) {
  ck(
    '屏幕外的窗口被拉回可视区',
    offscreen.screenX >= 0 &&
      offscreen.screenY >= 0 &&
      offscreen.screenX + offscreen.outerWidth <= offscreen.aw + 20 &&
      offscreen.screenY + offscreen.outerHeight <= offscreen.ah + 20,
    `${offscreen.screenX},${offscreen.screenY} ${offscreen.outerWidth}x${offscreen.outerHeight} 屏幕 ${offscreen.aw}x${offscreen.ah}`
  )
}

rmSync(userData, { recursive: true, force: true })

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
process.exit(failed === 0 ? 0 : 1)
