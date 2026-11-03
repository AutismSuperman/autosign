/**
 * 分区锁测试。
 *
 * 目的：保证同一账号不会同时开两个隐藏窗口（同 sitekey 双挂件会触发
 * Cloudflare 300030，两个 OAuth 窗口会抢同一个 state），同时不能把
 * 不同账号的批量任务串行化。
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/partitionLock.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/partition-lock.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { withPartitionLock, partitionPendingCount } = require('../.tmp/partition-lock.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 记录进入/离开顺序，用来验证串行性。 */
function makeRecorder() {
  const events = []
  return {
    events,
    make(name, ms, fail = false) {
      return async () => {
        events.push(`start:${name}`)
        await sleep(ms)
        if (fail) {
          events.push(`fail:${name}`)
          throw new Error(name)
        }
        events.push(`end:${name}`)
        return name
      }
    }
  }
}

// ---- 同 key 严格串行 ----
{
  const rec = makeRecorder()
  const all = [
    withPartitionLock('p1', rec.make('a', 30)),
    withPartitionLock('p1', rec.make('b', 10)),
    withPartitionLock('p1', rec.make('c', 5))
  ]
  await Promise.all(all)
  check(
    '同 key 严格串行（不重叠）',
    rec.events.join(',') === 'start:a,end:a,start:b,end:b,start:c,end:c',
    rec.events.join(',')
  )
}

// ---- 不同 key 并行 ----
{
  const rec = makeRecorder()
  const t0 = Date.now()
  await Promise.all([
    withPartitionLock('x1', rec.make('a', 40)),
    withPartitionLock('x2', rec.make('b', 40)),
    withPartitionLock('x3', rec.make('c', 40))
  ])
  const elapsed = Date.now() - t0
  check(
    '不同 key 并行（约等于单个耗时，而非三倍）',
    elapsed < 110,
    `${elapsed}ms`
  )
  check('不同 key 的开始都排在各自结束之前', rec.events.filter((e) => e.startsWith('start')).length === 3)
}

// ---- 任务抛错不阻塞后续 ----
{
  const rec = makeRecorder()
  let secondRan = false
  const first = withPartitionLock('p2', rec.make('bad', 10, true))
  const second = withPartitionLock('p2', async () => {
    secondRan = true
    return 'ok'
  })
  let firstErr = null
  try {
    await first
  } catch (e) {
    firstErr = e
  }
  const secondResult = await second
  check('抛错的任务本身仍 reject（不吞掉调用方错误）', !!firstErr)
  check('抛错后同分区的下一个任务照常执行', secondRan && secondResult === 'ok')
}

// ---- 返回值透传 ----
{
  const v = await withPartitionLock('p3', async () => ({ ok: true, n: 42 }))
  check('返回值原样透传', v.ok === true && v.n === 42)
}

// ---- 队列清理：任务结束后不残留 ----
{
  await withPartitionLock('p4', async () => 'done')
  await sleep(5)
  check('任务结束后该分区无残留排队', partitionPendingCount('p4') === 0, String(partitionPendingCount('p4')))
}

// ---- 排队计数准确 ----
{
  const p = withPartitionLock('p5', () => sleep(30))
  const q = withPartitionLock('p5', () => sleep(5))
  // 两个都已进入队列
  check('排队计数包含执行中与等待中', partitionPendingCount('p5') === 2, String(partitionPendingCount('p5')))
  await Promise.all([p, q])
  await sleep(5)
  check('全部完成后计数归零', partitionPendingCount('p5') === 0, String(partitionPendingCount('p5')))
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
