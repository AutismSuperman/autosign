/**
 * 签到分流与奖励补查判据测试。
 *
 * 起因（用户现场，v0.7.1）：
 *   1. 升级后大批账号只剩「已签」、没有金额 —— 因为上一版把「余额增量」
 *      标注为不可展示，而旧回执里存的全是增量。不能只隐藏了事，得把真实
 *      金额从站点记录补回来。
 *   2. 行内「重登领取」按钮点不动了 —— 「今日已签就跳过」把手动操作也拦住了。
 *      重登类站点本来就靠「登出再登」领取，拦住它等于按钮失效。
 *
 * 这里锁住两条不变量：
 *   - 批量 / 定时任务：今日已签就跳过（省请求、不白撞人机验证）
 *   - 手动点击：今日已签也要真的执行（按钮必须有效）
 * 以及「什么时候该向站点补查奖励金额」——补查成功金额才回来，
 * 失败要有冷却，不能每次刷新都白打请求。
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
  outfile: '.tmp/engine-plan.cjs',
  external: ['electron'],
  logLevel: 'error'
})
await build({
  entryPoints: ['src/main/sites/profile.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/profile-plan.cjs',
  logLevel: 'error'
})

const { planCheckin } = require('../.tmp/engine-plan.cjs')
const { needsRewardEnrichment, REWARD_RECHECK_MS } = require('../.tmp/profile-plan.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const bj = (y, m, d, hh = 0, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm)
const NOW = bj(2026, 10, 22, 10, 0)
const today = '2026-10-22'
const signedToday = { at: bj(2026, 10, 22, 8, 30), date: today, ok: true, already: false, reward: 25, rewardSource: 'site' }

/* ---- 批量：已签就跳过 ---- */
{
  const p = planCheckin('RELOGIN', signedToday, false, NOW)
  check('批量：重登站点今日已签 → 跳过', p.skip === true && p.verify === false, JSON.stringify(p))
}
{
  const p = planCheckin('BUTTON', signedToday, false, NOW)
  check('批量：按钮站点今日已签 → 跳过', p.skip === true, JSON.stringify(p))
}
{
  const p = planCheckin('BUTTON', undefined, false, NOW)
  check('批量：今日没签 → 先核对', p.skip === false && p.verify === true, JSON.stringify(p))
}
{
  const p = planCheckin('LOGIN_GRANT', undefined, false, NOW)
  check('批量：登录即得站点没签 → 先核对', p.skip === false && p.verify === true, JSON.stringify(p))
}

/* ---- 手动：已签也要执行（这是用户报的核心问题） ---- */
{
  const p = planCheckin('RELOGIN', signedToday, true, NOW)
  check(
    '手动点「重登领取」即使今日已签也要真的重登',
    p.skip === false && p.verify === false,
    JSON.stringify(p)
  )
}
{
  const p = planCheckin('BUTTON', signedToday, true, NOW)
  check(
    '手动点「签到」即使今日已签也继续（仍先核对站点记录）',
    p.skip === false && p.verify === true,
    JSON.stringify(p)
  )
}
{
  const p = planCheckin('RELOGIN', undefined, true, NOW)
  check('手动且今天没签：直接重登，不做多余核对', p.skip === false && p.verify === false, JSON.stringify(p))
}

/* ---- 跨天：昨天的回执不该拦住今天的批量 ---- */
{
  const yesterday = { ...signedToday, at: bj(2026, 10, 21, 9, 0), date: '2026-10-21' }
  const p = planCheckin('RELOGIN', yesterday, false, NOW)
  check('批量：昨天的回执不算今日已签', p.skip === false, JSON.stringify(p))
}

/* ---- 失败回执不跳过 ---- */
{
  const failed = { ...signedToday, ok: false }
  const p = planCheckin('BUTTON', failed, false, NOW)
  check('批量：失败回执不跳过', p.skip === false, JSON.stringify(p))
}

/* ---- 奖励补查：什么时候该问站点 ---- */
const deltaReceipt = {
  at: bj(2026, 10, 22, 8, 30),
  date: today,
  ok: true,
  already: false,
  reward: 20.9,
  rewardSource: 'delta'
}
check(
  '余额增量的今日回执需要补查真实金额',
  needsRewardEnrichment(deltaReceipt, NOW) === true
)

const noReward = { at: bj(2026, 10, 22, 8, 30), date: today, ok: true, already: true, rewardSource: 'site' }
check('没有金额的今日回执需要补查', needsRewardEnrichment(noReward, NOW) === true)

const siteReward = { ...deltaReceipt, reward: 25, rewardSource: 'site' }
check(
  '已有站点金额的回执不再补查',
  needsRewardEnrichment(siteReward, NOW) === false
)

check('今天的回执才补查（没签不补）', needsRewardEnrichment(undefined, NOW) === false)
const yesterday = { ...deltaReceipt, at: bj(2026, 10, 21, 9, 0), date: '2026-10-21' }
check('昨天的回执不补查（新周期重新领）', needsRewardEnrichment(yesterday, NOW) === false)

const justChecked = { ...deltaReceipt, rewardCheckedAt: NOW - 60_000 }
check(
  '刚查过（冷却期内）不重复补查',
  needsRewardEnrichment(justChecked, NOW) === false
)
const cooled = { ...deltaReceipt, rewardCheckedAt: NOW - REWARD_RECHECK_MS - 1000 }
check('超过冷却期后会再查一次', needsRewardEnrichment(cooled, NOW) === true)

const failedReceipt = { ...deltaReceipt, ok: false }
check('失败回执不补查', needsRewardEnrichment(failedReceipt, NOW) === false)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
