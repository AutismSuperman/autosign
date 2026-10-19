/**
 * 签到核对测试。
 *
 * 覆盖两处移植自上游的核对逻辑：
 *   1. 奖励周期按北京时区日界切分（站点使用日志的日窗从当地 0 点起算，
 *      旧版按 UTC 日界会把 0 点~8 点的发放盖成「前一天」，导致已签显示未签）
 *   2. matchTodayCheckinLog：从 /api/log/self 流水里认「今日签到」记录
 *      （只认签到文案、排除注册/邀请/兑换、按北京日窗过滤、倒序取最新一条、
 *        金额从文案解析——条目 quota 字段恒为 0）
 *
 * 纯函数测试，不依赖 Electron 运行时。运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/engine.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/engine.cjs',
  external: ['electron'],
  logLevel: 'error'
})
await build({
  entryPoints: ['src/main/sites/profile.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/profile.cjs',
  logLevel: 'error'
})

const { matchTodayCheckinLog } = require('../.tmp/engine.cjs')
const { rewardDate, rewardEpochMs, checkedInThisPeriod } = require('../.tmp/profile.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// 基准时刻：北京 2026-10-18 23:00（= UTC 2026-10-18 15:00）
const NOW = Date.UTC(2026, 9, 18, 15, 0, 0)
// 北京 2026-10-18 00:07:17（= UTC 2026-10-17 16:07:17）：站点日窗刚开启后的发放时刻
const GRANT_AT = Date.UTC(2026, 9, 17, 16, 7, 17)
// 北京 2026-10-19 00:30：进入下一个奖励周期
const NEXT_DAY = Date.UTC(2026, 9, 18, 16, 30, 0)
const TS_TODAY = Math.floor(GRANT_AT / 1000)
const TS_YESTERDAY = Math.floor((GRANT_AT - 86_400_000) / 1000)

/* ---- 北京日界 ---- */
check(
  'rewardDate：北京 23:00 落在当日',
  rewardDate(NOW) === '2026-10-18',
  rewardDate(NOW)
)
check(
  'rewardDate：北京 00:07 的发放属于当日（旧 UTC 日界会盖成前一天）',
  rewardDate(GRANT_AT) === '2026-10-18',
  rewardDate(GRANT_AT)
)
check(
  'rewardEpochMs：周期起点为北京 0 点',
  rewardEpochMs(NOW) === Date.UTC(2026, 9, 17, 16, 0, 0),
  new Date(rewardEpochMs(NOW)).toISOString()
)

const receipt = { at: GRANT_AT, date: rewardDate(GRANT_AT), ok: true }
check(
  'checkedInThisPeriod：北京 00:07 的回执在同日 23:00 仍算已签',
  checkedInThisPeriod(receipt, NOW) === true
)
check(
  'checkedInThisPeriod：跨到北京次日 00:30 后不再算已签',
  checkedInThisPeriod(receipt, NEXT_DAY) === false
)
check('checkedInThisPeriod：无回执算未签', checkedInThisPeriod(undefined, NOW) === false)

/* ---- 今日签到日志匹配 ---- */
const bonus = (content, createdAt) => ({ created_at: createdAt, type: 4, content, quota: 0 })

const hit1 = matchTodayCheckinLog(
  [bonus('每日签到成功，增加额度 $25.0000000 额度', TS_TODAY)],
  NOW
)
check(
  '日志核对：命中今日签到记录并解析金额',
  hit1.found === true && hit1.reward === 25 && hit1.known === true,
  JSON.stringify(hit1)
)

const hit2 = matchTodayCheckinLog([bonus('新用户注册赠送 ＄175 额度', TS_TODAY)], NOW)
check('日志核对：注册赠送不算签到', hit2.found === false)

const hit3 = matchTodayCheckinLog(
  [bonus('每日签到成功，增加额度 $25.0000000 额度', TS_YESTERDAY)],
  NOW
)
check('日志核对：昨日签到记录不算今日', hit3.found === false)

const hit4 = matchTodayCheckinLog([bonus('每日签到成功', TS_TODAY)], NOW)
check(
  '日志核对：无金额的签到记录命中但不编造数字',
  hit4.found === true && hit4.known === false && hit4.reward === undefined,
  JSON.stringify(hit4)
)

const hit5 = matchTodayCheckinLog(
  [
    bonus('每日签到成功，增加额度 $25.0000000 额度', TS_TODAY),
    bonus('每日签到成功，增加额度 $20.0000000 额度', TS_TODAY - 60)
  ],
  NOW
)
check('日志核对：倒序流水取最新一条', hit5.found === true && hit5.reward === 25, JSON.stringify(hit5))

const hit6 = matchTodayCheckinLog(
  [bonus('每日签到成功，增加额度 $25.0000000 额度', TS_TODAY * 1000)],
  NOW
)
check('日志核对：毫秒时间戳同样识别', hit6.found === true && hit6.reward === 25)

check('日志核对：空流水不算命中', matchTodayCheckinLog([], NOW).found === false)
check('日志核对：非数组入参不算命中', matchTodayCheckinLog(null, NOW).found === false)

/* ---- 奖励金额换算 ----
 * /api/user/checkin 的 quota_awarded 是 quota 单位（500000 = $1），
 * 旧版直接当美元显示，10000000 会渲染成「+$10000000」。
 * 小值（< 1000）是站点直接给的美元，必须原样保留。 */
const { quotaToUsd } = require('../.tmp/engine.cjs')

check('换算：10000000 quota → $20', quotaToUsd(10000000) === 20, String(quotaToUsd(10000000)))
check('换算：14678562 quota → $29.36', quotaToUsd(14678562) === 29.3571, String(quotaToUsd(14678562)))
check('换算：17500000 quota → $35', quotaToUsd(17500000) === 35, String(quotaToUsd(17500000)))
check('换算：已是美元的 25 保持 25', quotaToUsd(25) === 25, String(quotaToUsd(25)))
check('换算：已是美元的 999 保持 999', quotaToUsd(999) === 999, String(quotaToUsd(999)))
check('换算：1000 及以上按 quota 处理', quotaToUsd(1000) === 0.002, String(quotaToUsd(1000)))
check('换算：0 保持 0', quotaToUsd(0) === 0, String(quotaToUsd(0)))
check('换算：undefined 返回 undefined', quotaToUsd(undefined) === undefined)
check('换算：支持站点自定义单位', quotaToUsd(1000000, 1000000) === 1, String(quotaToUsd(1000000, 1000000)))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
