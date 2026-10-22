/**
 * 金额换算与「今日已签跳过」测试。
 *
 * 起因（用户现场）：
 *   1. 界面上一批 GitHub 账号显示 $999.51 / $847.59 / $1036.99 这类金额，
 *      和站点上实际的 $25 每日奖励完全对不上；
 *   2. 签到会重复处理今天已经签过的账号。
 *
 * 第 1 点的根因是余额换算复用了「奖励字段的小值保护」：余额 quota 小于 1000 时
 * 被当成美元原样返回，或者站点自定义了 quota_per_unit 却仍按 500000 折算，
 * 整片金额就会差若干倍。余额永远是 quota 单位，必须严格按站点单位换算。
 *
 * 第 2 点是设计如此（本地回执命中当前奖励周期就跳过），这里把判据锁住，
 * 包括北京日界的跨天边界。
 *
 * 纯函数测试，不依赖 Electron。运行：npm test
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
  outfile: '.tmp/engine-amounts.cjs',
  external: ['electron'],
  logLevel: 'error'
})
await build({
  entryPoints: ['src/main/sites/profile.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/profile-amounts.cjs',
  logLevel: 'error'
})

const {
  quotaToUsd,
  quotaToUsdExact,
  plausibleReward,
  unitOf,
  matchTodayCreditLog
} = require('../.tmp/engine-amounts.cjs')
const { checkedInThisPeriod, rewardDate } = require('../.tmp/profile-amounts.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

/* ---- 配额单位 ---- */
check('默认单位为 500000', unitOf({}) === 500000, String(unitOf({})))
check('站点自定义单位生效', unitOf({ quotaPerUnit: 1000000 }) === 1000000)
check('非法单位退回默认值', unitOf({ quotaPerUnit: 0 }) === 500000)
check('负数单位退回默认值', unitOf({ quotaPerUnit: -5 }) === 500000)
check('NaN 单位退回默认值', unitOf({ quotaPerUnit: Number.NaN }) === 500000)

/* ---- 余额：严格按单位换算，不做小值猜测 ---- */
check(
  '余额 500 quota 换算为 $0.001 而不是 $500',
  quotaToUsdExact(500) === 0.001,
  String(quotaToUsdExact(500))
)
check(
  '余额 500000 quota = $1',
  quotaToUsdExact(500000) === 1,
  String(quotaToUsdExact(500000))
)
check(
  '自定义单位：1000000 quota = $1',
  quotaToUsdExact(1000000, 1000000) === 1,
  String(quotaToUsdExact(1000000, 1000000))
)
check(
  '用户现场 $999.51 → 499755000 quota',
  quotaToUsdExact(499755000) === 999.51,
  String(quotaToUsdExact(499755000))
)
check('余额 undefined 保持 undefined', quotaToUsdExact(undefined) === undefined)

/* ---- 奖励：保留小值当美元的保护（有的站点直接给美元） ---- */
check('奖励 25 保持 25（站点给美元）', quotaToUsd(25) === 25, String(quotaToUsd(25)))
check('奖励 10000000 quota = $20', quotaToUsd(10000000) === 20, String(quotaToUsd(10000000)))

/* ---- 明显离谱的奖励不展示 ---- */
check('奖励 $1036.99 视为不可信', plausibleReward(1036.99) === undefined)
check('奖励 $25 可信', plausibleReward(25) === 25)
check('奖励 undefined 保持 undefined', plausibleReward(undefined) === undefined)

/* ---- 今日系统到账兜底（仅登录即发型站点使用） ---- */
const bj = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm)
const NOW = bj(2026, 10, 22, 9, 0)
const ts = (ms) => Math.floor(ms / 1000)

const grant = { created_at: ts(bj(2026, 10, 22, 0, 7)), type: 4, content: '获得额度 $25.000000 额度', quota: 0 }
const credit = matchTodayCreditLog([grant], NOW)
check(
  '登录即发型：今日到账文案能解析出金额',
  credit.found === true && credit.reward === 25,
  JSON.stringify(credit)
)

const register = { created_at: ts(bj(2026, 10, 22, 0, 7)), type: 4, content: '新用户注册赠送 $175', quota: 0 }
check('注册赠送不算今日到账', matchTodayCreditLog([register], NOW).found === false)

const yesterday = { ...grant, created_at: ts(bj(2026, 10, 21, 0, 7)) }
check('昨日到账不算今日', matchTodayCreditLog([yesterday], NOW).found === false)

const topup = { created_at: ts(bj(2026, 10, 22, 0, 7)), type: 4, content: '充值到账 $50', quota: 0 }
check('充值不算签到到账', matchTodayCreditLog([topup], NOW).found === false)

// 消耗类流水同样带金额，误判成签到会让当天真的漏签
const spend = { created_at: ts(bj(2026, 10, 22, 0, 7)), type: 4, content: '模型调用消耗 $3.5', quota: 0 }
check('消耗不算签到到账', matchTodayCreditLog([spend], NOW).found === false)

const usage = { created_at: ts(bj(2026, 10, 22, 0, 7)), type: 4, content: '使用额度 $8', quota: 0 }
check('使用额度不算签到到账', matchTodayCreditLog([usage], NOW).found === false)

const refund = { created_at: ts(bj(2026, 10, 22, 0, 7)), type: 4, content: '退款 $20', quota: 0 }
check('退款不算签到到账', matchTodayCreditLog([refund], NOW).found === false)

const noAmount = { created_at: ts(bj(2026, 10, 22, 0, 7)), type: 4, content: '每日额度发放', quota: 0 }
const na = matchTodayCreditLog([noAmount], NOW)
check(
  '无金额的到账记录命中但不编造数字',
  na.found === true && na.reward === undefined && na.known === false,
  JSON.stringify(na)
)

const quotaOnly = { created_at: ts(bj(2026, 10, 22, 0, 7)), type: 4, content: '每日额度发放', quota: 12500000 }
check(
  '只有 quota 字段时按单位折算',
  matchTodayCreditLog([quotaOnly], NOW).reward === 25,
  String(matchTodayCreditLog([quotaOnly], NOW).reward)
)

/* ---- 已签跳过：北京日界 ---- */
const receipt = { at: bj(2026, 10, 22, 0, 2), date: '2026-10-22', ok: true }
check('今日已签的账号会被跳过', checkedInThisPeriod(receipt, NOW) === true)
check(
  '23:59 时当天回执仍算今日已签',
  checkedInThisPeriod(receipt, bj(2026, 10, 22, 23, 59)) === true
)
check(
  '跨到次日 0 点后不再跳过',
  checkedInThisPeriod(receipt, bj(2026, 10, 23, 0, 0)) === false
)
check('无回执不跳过', checkedInThisPeriod(undefined, NOW) === false)
check(
  '失败回执不跳过',
  checkedInThisPeriod({ ...receipt, ok: false }, NOW) === false
)
check(
  '日期对不上不跳过（回执时间戳落在当天但 date 是昨天）',
  checkedInThisPeriod({ ...receipt, date: '2026-10-21' }, NOW) === false
)
check('rewardDate 使用北京日界', rewardDate(bj(2026, 10, 22, 0, 1)) === '2026-10-22')

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
