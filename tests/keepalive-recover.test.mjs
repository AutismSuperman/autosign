/**
 * 会话恢复节奏测试。
 *
 * 起因（用户现场）：AgentRouter 会话失效后，GitHub 自动授权没有接上，
 * 用户每天都要手动点。链路修复之外，恢复节奏本身也要跟得上：
 *   - 常规间隔 10 分钟（旧版 30 分钟，RELOGIN 站点的当日额度靠登录动作发放，
 *     恢复越及时越不容易错过发放窗口）
 *   - 有待恢复账号但一轮全失败时切短间隔快速重试（2 分钟），连续数轮
 *     无进展则退回常规间隔，避免无限快节奏重试
 *   - 有账号恢复成功就立刻回到常规节奏
 *
 * 定时器行为用假 setTimeout 捕获间隔断言，不真实等待。运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/keepAlive.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/keepalive.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { startKeepAlive } = require('../.tmp/keepalive.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const FAST_MS = 2 * 60_000
const NORMAL_MS = 10 * 60_000

/** 假定时器：记录每次安排的延迟，允许测试手动触发。 */
function makeFakeTimers() {
  const timers = []
  const origSetTimeout = globalThis.setTimeout
  const origClearTimeout = globalThis.clearTimeout
  const origSetInterval = globalThis.setInterval
  const origClearInterval = globalThis.clearInterval
  globalThis.setTimeout = (fn, ms) => {
    const t = { fn, ms, fired: false, cleared: false, unref: () => t }
    timers.push(t)
    return t
  }
  globalThis.clearTimeout = (t) => {
    if (t) t.cleared = true
  }
  globalThis.setInterval = () => ({ unref: () => undefined })
  globalThis.clearInterval = () => undefined
  return {
    timers,
    /** 触发下一个未被清除、尚未触发的 setTimeout（按创建顺序）。 */
    async fireNext() {
      const t = timers.find((x) => !x.cleared && !x.fired)
      if (!t) return null
      t.fired = true
      await t.fn()
      // recoverTick 链式的下一次 setTimeout 发生在它内部 await 的宏任务之后：
      // fn() 本身返回 undefined（void 包装），只 await 它拿不到后续排程，
      // 必须排空一轮宏任务再断言
      await new Promise((r) => setImmediate(r))
      return t
    },
    /** 当前安排的下一个间隔：最后一个未触发定时器的延迟。 */
    nextDelay() {
      const pending = timers.filter((x) => !x.cleared && !x.fired)
      return pending.length > 0 ? pending[pending.length - 1].ms : undefined
    },
    restore() {
      globalThis.setTimeout = origSetTimeout
      globalThis.clearTimeout = origClearTimeout
      globalThis.setInterval = origSetInterval
      globalThis.clearInterval = origClearInterval
    }
  }
}

/** 造一份可控的 deps：sites() 控制待恢复账号数量，recover 控制结果。 */
function makeDeps(recover) {
  return {
    proxy: async () => '',
    sites: () => {
      // needsRelogin: true 才会被 recoverOnce 视为待恢复账号
      const account = { id: 'acc-1', token: 't', cookie: 'c', needsRelogin: true }
      return [{ id: 'site-1', accounts: [account] }]
    },
    sessionFor: () => ({ proxy: '', onRenewed: async () => {}, readAccount: () => undefined, log: () => {} }),
    log: () => {},
    recover: async () => {
      const r = await recover()
      return r
    }
  }
}

// ---- 场景一：有待恢复账号但恢复一直失败 → 先快节奏，连败后退回常规 ----
{
  const timers = makeFakeTimers()
  const stop = startKeepAlive(makeDeps(async () => ({ ok: false, error: 'x' })))
  try {
    // 第一次触发恢复：全失败 → 安排快节奏
    await timers.fireNext()
    const d1 = timers.nextDelay()
    check('恢复全失败后切快节奏（2 分钟）', d1 === FAST_MS, String(d1))

    await timers.fireNext()
    const d2 = timers.nextDelay()
    check('连续失败保持快节奏', d2 === FAST_MS, String(d2))

    // 第 4 轮起超过 3 轮上限，退回常规
    await timers.fireNext()
    await timers.fireNext()
    const d3 = timers.nextDelay()
    check('连败超过上限退回常规间隔（10 分钟）', d3 === NORMAL_MS, String(d3))
  } finally {
    stop()
    timers.restore()
  }
}

// ---- 场景二：恢复成功 → 立即回到常规节奏 ----
{
  const timers = makeFakeTimers()
  let failFirst = true
  const stop = startKeepAlive(
    makeDeps(async () => (failFirst ? { ok: false, error: 'x' } : { ok: true }))
  )
  try {
    await timers.fireNext() // 失败 → 快节奏
    failFirst = false
    await timers.fireNext() // 成功 → 常规节奏
    const d = timers.nextDelay()
    check('恢复成功后回到常规间隔', d === NORMAL_MS, String(d))
  } finally {
    stop()
    timers.restore()
  }
}

// ---- 场景三：没有待恢复账号 → 常规间隔 ----
{
  const timers = makeFakeTimers()
  const stop = startKeepAlive(
    makeDeps(async () => ({ ok: true }))
  )
  try {
    await timers.fireNext() // recover 返回成功但账号本来没有 needsRelogin → total=0
    const d = timers.nextDelay()
    check('无待恢复账号时保持常规间隔', d === NORMAL_MS, String(d))
  } finally {
    stop()
    timers.restore()
  }
}

// ---- 场景四：停止后不再安排新的恢复 ----
{
  const timers = makeFakeTimers()
  const stop = startKeepAlive(makeDeps(async () => ({ ok: false, error: 'x' })))
  await timers.fireNext()
  stop()
  const pending = timers.timers.filter((t) => !t.cleared && !t.fired)
  check('停止后没有未清理的恢复定时器', pending.length === 0, String(pending.length))
  timers.restore()
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
