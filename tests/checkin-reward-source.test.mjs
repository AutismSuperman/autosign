/**
 * 签到奖励金额来源测试。
 *
 * 起因（用户现场）：同一批 GitHub 账号的签到奖励显示成 +$20.90、+$21.71、
 * +$21.37……每天都不一样，而站点的每日奖励其实是固定 $25。
 *
 * 根因：重登类站点的回执里记的不是奖励，而是「重登前后余额差」。
 * 这个差值包含同时段的正常消耗、其它入账，天然每次不同，把它当奖励展示
 * 就成了这堆噪声；跨机器/重装后本地缓存丢失，还会整片变成这些数字。
 *
 * 这里锁住三条不变量：
 *   1. 奖励金额只来自站点自己的今日发放记录（rewardSource='site'）
 *   2. 余额增量（rewardSource='delta'）永远不展示成奖励
 *   3. 明显离谱的金额（>= $1000）宁可不显示，也不渲染一个错数
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
  outfile: '.tmp/format-reward.cjs',
  external: ['@shared/types'],
  logLevel: 'error'
})

const { checkinText, showableReward } = require('../.tmp/format-reward.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

/** 北京时间戳。 */
const bj = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm)
const NOW = bj(2026, 10, 22, 9, 0)
const TODAY = '2026-10-22'

const receipt = (extra) => ({
  at: bj(2026, 10, 22, 8, 30),
  date: TODAY,
  ok: true,
  already: false,
  message: '重登成功',
  ...extra
})

// ---- 核心：余额增量不是奖励 ----
const delta = receipt({ reward: 20.9, rewardSource: 'delta' })
check('余额增量不展示成签到奖励', showableReward(delta) === undefined, String(showableReward(delta)))
check(
  '余额增量的回执仍显示「已签」',
  checkinText(delta, NOW).label === '已签',
  checkinText(delta, NOW).label
)
check(
  '余额增量的回执不再渲染 +$ 金额',
  checkinText(delta, NOW).reward === undefined,
  String(checkinText(delta, NOW).reward)
)

// ---- 站点给的金额正常展示 ----
const site = receipt({ reward: 25, rewardSource: 'site' })
check('站点奖励金额正常展示', showableReward(site) === 25, String(showableReward(site)))
check('站点奖励渲染 +$25', checkinText(site, NOW).reward === 25)

// ---- 合理区间之外的一律不展示 ----
check('1000 以上不展示（明显是 unit 错）', showableReward(receipt({ reward: 1036.99, rewardSource: 'site' })) === undefined)
check('恰好 999.99 仍展示', showableReward(receipt({ reward: 999.99, rewardSource: 'site' })) === 999.99)
check('负值不展示', showableReward(receipt({ reward: -1, rewardSource: 'site' })) === undefined)
check('NaN 不展示', showableReward(receipt({ reward: Number.NaN, rewardSource: 'site' })) === undefined)
check('旧回执没有 rewardSource 时按 site 处理', showableReward({ reward: 25 }) === 25)

// ---- 跨天后，悬停提示里也不该出现增量 ----
const staleDelta = {
  at: bj(2026, 10, 21, 9, 0),
  date: '2026-10-21',
  ok: true,
  already: false,
  reward: 21.37,
  rewardSource: 'delta'
}
const stale = checkinText(staleDelta, NOW)
check('跨天的增量回执显示未签', stale.label === '未签' && stale.stale === true, stale.label)
check(
  '跨天提示里不带增量金额',
  typeof stale.hint === 'string' && !stale.hint.includes('+$'),
  stale.hint
)

// ---- 站点金额在跨天提示里保留（这是有意义的「上次签到」信息） ----
const staleSite = { ...staleDelta, reward: 25, rewardSource: 'site' }
check(
  '跨天提示保留站点给的金额',
  (checkinText(staleSite, NOW).hint ?? '').includes('+$25.00'),
  checkinText(staleSite, NOW).hint
)

// ---- 已签语义：already 字段决定文案 ----
check(
  'already 回执显示「今日已签」',
  checkinText(receipt({ already: true, reward: 25, rewardSource: 'site' }), NOW).label === '今日已签'
)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
