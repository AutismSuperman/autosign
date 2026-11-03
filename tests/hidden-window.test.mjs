/**
 * 隐藏窗口生命周期测试。
 *
 * 起因：三处隐藏窗口（Turnstile / 静默重授权 / 手动 OAuth）各写了一遍
 * 「settled + destroy + deadline」，但都漏了东西：
 *   - turnstile 的清理在 Promise.race 之后，work reject 就跳过清理 → 窗口泄漏
 *   - silentReauth / oauth 的 deadline 计时器从不 clearTimeout
 *   - oauth 根本没有硬超时
 *
 * 这里锁住 withHiddenWindow 的六条不变量：四条出口都清理窗口、计时器被清、
 * 任务异常不让 Promise reject、兜底值类型正确。
 *
 * 用假 BrowserWindow + 假计时器，不依赖 Electron。运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/hiddenWindow.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/hidden-window.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { withHiddenWindow, safeCurrentUrl } = require('../.tmp/hidden-window.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 假窗口：记录 destroy 调用次数、closed 监听器，可模拟外部关闭。
 * 只实现 withHiddenWindow 真正用到的成员。
 */
function fakeWindow() {
  const state = { destroyed: false, destroyCalls: 0 }
  const listeners = { closed: [] }
  const win = {
    isDestroyed: () => state.destroyed,
    destroy: () => {
      state.destroyCalls++
      if (state.destroyed) throw new Error('already destroyed')
      state.destroyed = true
    },
    once: (event, fn) => {
      if (event === 'closed') listeners.closed.push(fn)
    },
    webContents: {
      getURL: () => {
        if (state.destroyed) throw new Error('Object has been destroyed')
        return 'https://example.com/'
      }
    },
    /** 模拟外部关闭（用户点 X）。 */
    close: () => {
      state.destroyed = true
      for (const fn of listeners.closed) fn()
    }
  }
  return { win, state }
}

const okFallback = (reason, detail) => ({ ok: false, reason, detail })

// ---- 路径一：任务正常返回 → 清理窗口，采用任务结果 ----
{
  const { win, state } = fakeWindow()
  const r = await withHiddenWindow(
    { label: 'normal', create: () => win, timeoutMs: 1000, fallback: okFallback },
    async () => ({ ok: true, value: 42 })
  )
  check('正常返回采用任务结果', r.ok === true && r.value === 42)
  check('正常返回也销毁窗口', state.destroyCalls === 1 && state.destroyed, `calls=${state.destroyCalls}`)
}

// ---- 路径二：超时 → 清理窗口，返回 fallback('timeout') ----
{
  const { win, state } = fakeWindow()
  const r = await withHiddenWindow(
    { label: 'timeout', create: () => win, timeoutMs: 30, fallback: okFallback },
    async (h) => {
      // 模拟长时间等待；用轮询让出控制权，避免挂住事件循环
      for (let i = 0; i < 100; i++) {
        if (h.aborted()) return { ok: true, note: 'should-not-win' }
        await sleep(5)
      }
      return { ok: true, note: 'finished-late' }
    }
  )
  check('超时返回 timeout 原因', r.ok === false && r.reason === 'timeout', JSON.stringify(r))
  check('超时路径销毁窗口', state.destroyCalls === 1 && state.destroyed, `calls=${state.destroyCalls}`)
}

// ---- 路径三：任务抛错 → 清理窗口，Promise 不 reject ----
{
  const { win, state } = fakeWindow()
  let rejected = false
  let r = null
  try {
    r = await withHiddenWindow(
      { label: 'throws', create: () => win, timeoutMs: 1000, fallback: okFallback },
      async () => {
        await sleep(5)
        throw new Error('boom')
      }
    )
  } catch {
    rejected = true
  }
  check('任务抛错不会让 Promise reject', rejected === false)
  check('任务抛错返回 error 原因并带详情', r && r.ok === false && r.reason === 'error' && r.detail === 'boom', JSON.stringify(r))
  check('任务抛错路径销毁窗口', state.destroyCalls === 1 && state.destroyed, `calls=${state.destroyCalls}`)
}

// ---- 路径四：窗口被外部关闭 → 清理（幂等），返回 closed 原因 ----
{
  const { win, state } = fakeWindow()
  const p = withHiddenWindow(
    { label: 'closed', create: () => win, timeoutMs: 5000, fallback: okFallback },
    async (h) => {
      // 等待外部关闭（由测试在下方触发）
      for (let i = 0; i < 100; i++) {
        if (h.aborted()) return { ok: true, note: 'late' }
        await sleep(5)
      }
      return { ok: true, note: 'never' }
    }
  )
  // 让任务先进入等待，再模拟用户关窗
  await sleep(15)
  win.close()
  const r = await p
  check('外部关闭返回 closed 原因', r.ok === false && r.reason === 'closed', JSON.stringify(r))
  // closed 时窗口已经是 destroyed，destroy() 应由 isDestroyed 拦住
  check('外部关闭后不重复销毁', state.destroyCalls === 0, `calls=${state.destroyCalls}`)
}

// 补一条：先让外部 close 触发，再确认任务体被 aborted 感知
{
  const { win } = fakeWindow()
  const p = withHiddenWindow(
    { label: 'closed-live', create: () => win, timeoutMs: 5000, fallback: okFallback },
    async (h) => {
      for (let i = 0; i < 200; i++) {
        if (h.aborted()) return { ok: true, note: 'aborted-seen' }
        await sleep(5)
      }
      return { ok: true, note: 'timeout-in-task' }
    }
  )
  await sleep(20)
  win.close() // 模拟用户关窗
  const r = await p
  check('外部关闭立刻结束 Promise（不等超时）', r.ok === false && r.reason === 'closed', JSON.stringify(r))
}

// ---- 计时器被清理：成功后不应有残留 deadline timer ----
{
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const created = []
  const TIMEOUT_MS = 60_000
  globalThis.setTimeout = (fn, ms) => {
    // 只关心 deadline 计时器（时长为 timeoutMs 的那个）；测试自身的 sleep 不计入
    const isDeadline = ms === TIMEOUT_MS
    const t = realSetTimeout(fn, ms)
    if (isDeadline) created.push({ t, cleared: false })
    return t
  }
  globalThis.clearTimeout = (t) => {
    const rec = created.find((c) => c.t === t)
    if (rec) rec.cleared = true
    return realClearTimeout(t)
  }
  const { win } = fakeWindow()
  let r
  try {
    r = await withHiddenWindow(
      { label: 'timer', create: () => win, timeoutMs: TIMEOUT_MS, fallback: okFallback },
      async () => ({ ok: true })
    )
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
  check('计时器测试确实注册了 deadline', created.length === 1, `注册=${created.length}`)
  check('成功后 deadline 计时器被 clearTimeout（不残留 long timer）', created.every((c) => c.cleared), `未清理=${created.filter((c) => !c.cleared).length}`)
  check('该轮任务结果正常', r.ok === true)
}

// ---- safeCurrentUrl：窗口销毁后不抛错 ----
{
  const { win, state } = fakeWindow()
  check('未销毁时返回当前 URL', safeCurrentUrl(win) === 'https://example.com/')
  state.destroyed = true
  let threw = false
  let url = null
  try {
    url = safeCurrentUrl(win)
  } catch {
    threw = true
  }
  check('窗口已销毁时返回空串且不抛错', threw === false && url === '', `threw=${threw} url=${url}`)
}

// ---- settle 幂等：任务双次 settle 只生效一次 ----
{
  const { win, state } = fakeWindow()
  const r = await withHiddenWindow(
    { label: 'idempotent', create: () => win, timeoutMs: 1000, fallback: okFallback },
    async (h) => {
      h.settle({ ok: true, n: 1 })
      h.settle({ ok: true, n: 2 })
      return { ok: true, n: 3 }
    }
  )
  check('多次 settle 只有第一次生效', r.n === 1, JSON.stringify(r))
  check('多次 settle 也只销毁一次', state.destroyCalls === 1, `calls=${state.destroyCalls}`)
}

// ---- extend：交还用户后重新计时 ----
// 交互式 OAuth 窗口把控制权交给用户后，机器预算（60s）不该继续生效，
// 否则用户刚准备登录，窗口就被判超时销毁。
{
  const { win } = fakeWindow()
  const t0 = Date.now()
  let extendCalled = false
  const r = await withHiddenWindow(
    { label: 'extend', create: () => win, timeoutMs: 60, fallback: okFallback },
    async (h) => {
      // 在机器预算快到点时切到长预算
      await sleep(40)
      h.extend(400)
      extendCalled = true
      // 再等超过原预算的时间：若 extend 没生效，这里会被判 timeout
      await sleep(80)
      return { ok: true, note: 'survived-original-deadline' }
    }
  )
  const elapsed = Date.now() - t0
  check('extend 被调用', extendCalled)
  check('extend 后不再按原预算超时', r.ok === true && r.note === 'survived-original-deadline', JSON.stringify(r))
  check('实际持续时间超过了原超时值', elapsed > 60, `${elapsed}ms`)
}

// ---- extend 不会救活已经结束的窗口 ----
{
  const { win } = fakeWindow()
  const r = await withHiddenWindow(
    { label: 'extend-after-settle', create: () => win, timeoutMs: 50, fallback: okFallback },
    async (h) => {
      await sleep(120) // 必然已超时
      h.extend(10_000) // 不该有任何效果
      return { ok: true, note: 'should-not-happen' }
    }
  )
  check('已超时后 extend 无效', r.ok === false && r.reason === 'timeout', JSON.stringify(r))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
