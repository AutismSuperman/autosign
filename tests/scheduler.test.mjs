import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
mkdirSync('.tmp', { recursive: true })
await build({
  stdin: {
    contents: "export * from './src/main/scheduler'; export * from './src/main/scheduleState'; export * from './src/main/singleFlight'",
    resolveDir: process.cwd()
  },
  bundle: true, platform: 'node', format: 'cjs',
  outfile: '.tmp/scheduler-test.cjs', logLevel: 'error'
})
const {
  CheckinScheduler, ScheduleStateStore, createSingleFlight,
  nextScheduleAt, scheduleDueToday, scheduleTimeOf, needsManualCheckin
} = require('../.tmp/scheduler-test.cjs')
const local = (day, hour = 9, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()
const defaults = { enabled: true, time: '08:05', weekdaysOnly: false }
let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`PASS  ${name}`)
}

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const timers = new Set()
globalThis.setTimeout = (fn, delay) => {
  const timer = { fn, delay, unref() { return this } }
  timers.add(timer)
  return timer
}
globalThis.clearTimeout = (timer) => timers.delete(timer)
function harness(options = {}) {
  let now = options.now ?? local(9)
  let online = true
  let settings = { ...defaults, ...options.settings }
  let saved
  const calls = []
  const logs = []
  const notifications = []
  const accounts = (options.ids ?? ['test-a', 'test-b']).map((id) => ({ id, checked: false }))
  let handler = options.handler ?? (async () => ({ ok: false, message: 'HTTP 503' }))
  const deps = {
    now: () => now, settings: () => settings,
    accounts: () => structuredClone(accounts), online: () => online,
    save: async (state) => { saved = structuredClone(state) },
    checkin: async (id) => { calls.push(id); return handler(id) },
    log: (...args) => logs.push(args), notify: (summary) => notifications.push(summary)
  }
  const scheduler = new CheckinScheduler(deps, options.initial)
  scheduler.start()
  return {
    scheduler, calls, accounts, notifications, logs,
    get saved() { return saved },
    setNow: (value) => { now = value },
    online: (value) => { online = value },
    settings: (patch) => { settings = { ...settings, ...patch }; scheduler.changed() },
    handler: (fn) => { handler = fn }
  }
}

try {
  await test('valid local schedule times and weekday boundaries', () => {
    assert.equal(scheduleTimeOf({ time: '24:00' }), undefined)
    assert.equal(scheduleTimeOf({ time: '8:05' }), undefined)
    assert.equal(scheduleTimeOf({ time: '' }), undefined)
    assert.equal(scheduleDueToday(new Date(local(9, 8, 4)), defaults), false)
    assert.equal(scheduleDueToday(new Date(local(9, 8, 5)), defaults), true)
    const weekdays = { ...defaults, weekdaysOnly: true }
    assert.equal(scheduleDueToday(new Date(local(14)), weekdays), false)
    assert.equal(nextScheduleAt(new Date(local(13)), weekdays), local(16, 8, 5))
  })
  await test('startup before due time waits; late startup catches up today', async () => {
    const h = harness({ now: local(9, 7) })
    await h.scheduler.tick()
    assert.equal(h.calls.length, 0)
    h.setNow(local(9))
    await h.scheduler.tick()
    assert.deepEqual(h.calls, ['test-a', 'test-b'])
    h.scheduler.stop()
  })
  await test('only failed accounts retry at 5, 10, 20 minutes and then stop', async () => {
    const h = harness({ handler: async (id) => ({ ok: id === 'test-a', message: 'HTTP 503' }) })
    await h.scheduler.tick()
    assert.equal(h.saved.accounts['test-b'].nextAt, local(9) + 5 * 60_000)
    await h.scheduler.tick()
    assert.equal(h.calls.length, 2)
    h.setNow(local(9) + 5 * 60_000)
    await h.scheduler.tick()
    assert.equal(h.saved.accounts['test-b'].nextAt, local(9) + 15 * 60_000)
    h.setNow(local(9) + 15 * 60_000)
    await h.scheduler.tick()
    assert.equal(h.saved.accounts['test-b'].nextAt, local(9) + 35 * 60_000)
    h.setNow(local(9) + 35 * 60_000)
    await h.scheduler.tick()
    assert.equal(h.saved.accounts['test-b'].status, 'exhausted')
    h.setNow(local(9, 16))
    await h.scheduler.tick()
    assert.deepEqual(h.calls, ['test-a', 'test-b', 'test-b', 'test-b', 'test-b'])
    assert.equal(h.notifications.at(-1).retrying, 0)
    assert.equal(h.notifications.at(-1).stopped, 1)
    h.scheduler.stop()
  })
  await test('restart retains cooldowns and retry count', async () => {
    const first = harness({ ids: ['test-a'] })
    await first.scheduler.tick()
    first.scheduler.stop()
    const second = harness({ ids: ['test-a'], initial: first.saved, now: local(9) + 60_000 })
    await second.scheduler.tick()
    assert.equal(second.calls.length, 0)
    second.setNow(local(9) + 5 * 60_000)
    await second.scheduler.tick()
    assert.equal(second.saved.accounts['test-a'].attempts, 2)
    second.scheduler.stop()
  })
  await test('one account exception does not abort the remaining accounts', async () => {
    const h = harness({ handler: async (id) => {
      if (id === 'test-a') throw new Error('simulated exception')
      return { ok: true, message: 'ok' }
    } })
    await h.scheduler.tick()
    assert.equal(h.saved.accounts['test-a'].status, 'pending')
    assert.equal(h.saved.accounts['test-b'].status, 'done')
    h.scheduler.stop()
  })
  await test('disabled schedule cancels timers and enabling starts immediately', async () => {
    const h = harness({ settings: { enabled: false } })
    assert.equal(timers.size, 0)
    await h.scheduler.tick()
    assert.equal(h.calls.length, 0)
    h.settings({ enabled: true })
    assert.equal(timers.size, 1)
    h.settings({ enabled: false })
    assert.equal(timers.size, 0)
    await h.scheduler.tick()
    assert.equal(h.calls.length, 0)
    h.scheduler.stop()
  })
  await test('schedule time changes take effect before old timer runs', async () => {
    const h = harness()
    h.settings({ time: '10:00' })
    await h.scheduler.tick()
    assert.equal(h.calls.length, 0)
    h.setNow(local(9, 10))
    await h.scheduler.tick()
    assert.equal(h.calls.length, 2)
    h.scheduler.stop()
  })
  await test('disabling during an account stops the rest of the batch', async () => {
    const h = harness()
    h.handler(async () => {
      h.settings({ enabled: false })
      return { ok: true, message: 'ok' }
    })
    await h.scheduler.tick()
    assert.deepEqual(h.calls, ['test-a'])
    assert.equal(timers.size, 0)
    h.scheduler.stop()
  })
  await test('offline polling consumes no attempts; reconnection catches up', async () => {
    const h = harness()
    h.online(false)
    await h.scheduler.tick()
    assert.equal(h.calls.length, 0)
    assert.equal(h.saved, undefined)
    h.online(true)
    await h.scheduler.tick()
    assert.equal(h.calls.length, 2)
    h.scheduler.stop()
  })
  await test('completed accounts skip retries and deleted accounts are ignored', async () => {
    const h = harness()
    await h.scheduler.tick()
    h.accounts[0].checked = true
    h.accounts.pop()
    h.setNow(local(9, 10))
    await h.scheduler.tick()
    assert.equal(h.calls.length, 2)
    h.scheduler.stop()
  })
  await test('site claim window delays the first attempt without consuming retries', async () => {
    const h = harness()
    h.accounts[0].notBefore = local(9, 10)
    await h.scheduler.tick()
    assert.deepEqual(h.calls, ['test-b'])
    assert.equal(h.saved.accounts['test-a'], undefined)
    h.setNow(local(9, 10))
    await h.scheduler.tick()
    assert.equal(h.saved.accounts['test-a'].attempts, 1)
    h.scheduler.stop()
  })
  await test('new reward day resets old retries; weekend policy still applies', async () => {
    const h = harness()
    await h.scheduler.tick()
    h.setNow(local(10, 7))
    await h.scheduler.tick()
    assert.equal(h.calls.length, 2)
    h.setNow(local(10, 9))
    await h.scheduler.tick()
    assert.equal(h.saved.accounts['test-a'].attempts, 1)
    assert.equal(h.calls.length, 4)
    h.settings({ weekdaysOnly: true })
    h.setNow(local(14, 9))
    await h.scheduler.tick()
    assert.equal(h.calls.length, 4)
    h.scheduler.stop()
  })
  await test('concurrent wakeups share one batch', async () => {
    const h = harness({ handler: async () => ({ ok: true, message: 'ok' }) })
    await Promise.all([h.scheduler.tick(), h.scheduler.tick(), h.scheduler.tick()])
    assert.deepEqual(h.calls, ['test-a', 'test-b'])
    h.scheduler.stop()
  })
  await test('manual verification stops retries; temporary errors remain retryable', async () => {
    assert.equal(needsManualCheckin('需要手动完成设备验证'), true)
    assert.equal(needsManualCheckin('站点会话数已达上限'), true)
    assert.equal(needsManualCheckin('静默重授权超时，请手动点「重新授权」'), false)
    assert.equal(needsManualCheckin('人机验证触发频率过高，请稍等几分钟再试'), false)
    const h = harness({ handler: async () => ({ ok: false, message: '需要人工验证' }) })
    await h.scheduler.tick()
    h.setNow(local(9, 16))
    await h.scheduler.tick()
    assert.equal(h.calls.length, 2)
    assert.equal(h.saved.accounts['test-a'].status, 'blocked')
    h.scheduler.stop()
  })
  await test('failed state write sends no request and later recovers', async () => {
    let writable = false
    let calls = 0
    const scheduler = new CheckinScheduler({
      now: () => local(9), settings: () => defaults, online: () => true,
      accounts: () => [{ id: 'test-a', checked: false }],
      save: async () => { if (!writable) throw new Error('test disk failure') },
      checkin: async () => { calls++; return { ok: true, message: 'ok' } },
      log: () => {}, notify: () => {}
    })
    scheduler.start()
    await scheduler.tick()
    assert.equal(calls, 0)
    writable = true
    await scheduler.tick()
    assert.equal(calls, 1)
    scheduler.stop()
  })
  await test('single account concurrent requests share result and release after errors', async () => {
    const run = createSingleFlight()
    let calls = 0
    const work = async () => { calls++; return 'ok' }
    assert.deepEqual(await Promise.all([run('test-a', work), run('test-a', work)]), ['ok', 'ok'])
    assert.equal(calls, 1)
    await assert.rejects(run('test-a', async () => { throw new Error('test') }))
    assert.equal(await run('test-a', work), 'ok')
    assert.equal(calls, 2)
  })
  await test('schedule state round trips and invalid state is rejected', async () => {
    const dir = mkdtempSync(join('.tmp', 'schedule-state-'))
    const file = join(dir, 'schedule-state.json')
    const store = new ScheduleStateStore(file)
    assert.equal(await store.read(), undefined)
    const state = { date: '2026-11-09', accounts: {
      'test-a': { attempts: 2, status: 'pending', nextAt: local(9, 10) }
    } }
    await store.save(state)
    assert.deepEqual(await new ScheduleStateStore(file).read(), state)
    writeFileSync(file, '{"date":"invalid"}')
    assert.equal(await store.read(), undefined)
    assert.ok(!readFileSync(file, 'utf8').includes('password'))
  })
} finally {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
}
assert.equal(timers.size, 0, 'scheduler timers leaked')
console.log(`ALL PASS (${passed} scheduler checks)`)
