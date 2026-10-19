/**
 * 签到状态显示测试。
 *
 * 起因：过了北京 0 点，界面仍显示「今日已签」。
 * 根因是渲染层只看回执的 ok 字段，从不比对日期——
 * 昨天的成功回执在今天依然是 ok=true，于是一直显示为今天已签。
 *
 * 覆盖：
 *   1. 今日回执 → 今日已签
 *   2. 昨日回执（跨 0 点）→ 不再显示今日已签，改为「上次 MM-DD HH:MM」
 *   3. 北京 0 点前后一分钟的边界
 *   4. 未签 / 无回执 / 失败回执
 *
 * 纯函数测试，不依赖 Electron。运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/renderer/src/lib/format.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/format.cjs',
  external: ['@shared/types'],
  logLevel: 'error'
})

const { checkinText, isCheckedToday, beijingDate } = require('../.tmp/format.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

/** 构造一个北京时间戳。 */
const bj = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm)

// 基准：北京 2026-10-19 00:05（刚过 0 点）
const NOW = bj(2026, 10, 19, 0, 5)
// 昨天 23:44 的签到回执
const YESTERDAY_RECEIPT = {
  at: bj(2026, 10, 18, 23, 44),
  date: '2026-10-18',
  ok: true,
  already: false,
  reward: 25
}

check(
  '昨日回执不算今日已签',
  isCheckedToday(YESTERDAY_RECEIPT, NOW) === false
)

const stale = checkinText(YESTERDAY_RECEIPT, NOW)
check(
  '跨天后显示未签（不是今日已签）',
  stale.label === '未签' && stale.stale === true,
  stale.label
)
check(
  '上次签到信息保留在悬停提示里',
  typeof stale.hint === 'string' &&
    stale.hint.includes('2026-10-18') &&
    stale.hint.includes('23:44') &&
    stale.hint.includes('+$25.00'),
  stale.hint
)
check('跨天后不再把上次奖励算作今日收入', stale.reward === undefined, String(stale.reward))

// 今天 00:02 刚签的回执
const TODAY_RECEIPT = {
  at: bj(2026, 10, 19, 0, 2),
  date: '2026-10-19',
  ok: true,
  already: false,
  reward: 20
}
check('今日回执算今日已签', isCheckedToday(TODAY_RECEIPT, NOW) === true)
const fresh = checkinText(TODAY_RECEIPT, NOW)
check('今日回执显示「已签」', fresh.label === '已签' && fresh.stale === false, fresh.label)

const alreadyReceipt = { ...TODAY_RECEIPT, already: true }
check(
  '今日补记回执显示「今日已签」',
  checkinText(alreadyReceipt, NOW).label === '今日已签'
)

// 边界：北京 0 点整前后
const BEFORE_MIDNIGHT = bj(2026, 10, 18, 23, 59)
check('23:59 时昨天的回执仍算当天已签', isCheckedToday(YESTERDAY_RECEIPT, BEFORE_MIDNIGHT) === true)
check('00:00 时立刻不再算已签', isCheckedToday(YESTERDAY_RECEIPT, bj(2026, 10, 19, 0, 0)) === false)
check(
  '北京日界跨 UTC 日：UTC 16:00 后进入新的一天',
  beijingDate(bj(2026, 10, 19, 0, 1)) === '2026-10-19' &&
    beijingDate(bj(2026, 10, 18, 23, 59)) === '2026-10-18',
  `${beijingDate(bj(2026, 10, 18, 23, 59))} → ${beijingDate(bj(2026, 10, 19, 0, 1))}`
)

// 无回执 / 失败回执
check('无回执显示未签', checkinText(undefined, NOW).label === '未签')
check(
  '失败回执显示未签',
  checkinText({ at: NOW, date: '2026-10-19', ok: false, already: false }, NOW).label === '未签'
)
check('无回执不算今日已签', isCheckedToday(undefined, NOW) === false)

// 跨天后重新签到 → 立刻变回已签（需求的核心闭环）
const AFTER_RECHECKIN = {
  at: bj(2026, 10, 19, 0, 20),
  date: '2026-10-19',
  ok: true,
  already: false,
  reward: 25
}
check(
  '跨天后签到成功立刻变回「已签」',
  checkinText(AFTER_RECHECKIN, bj(2026, 10, 19, 0, 21)).label === '已签'
)
check(
  '签到后恢复展示今日奖励',
  checkinText(AFTER_RECHECKIN, bj(2026, 10, 19, 0, 21)).reward === 25
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
