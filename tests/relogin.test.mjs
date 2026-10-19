/**
 * 重登签到判据测试。
 *
 * 核心不变量：**只有余额增量达标才算到账**。
 * 响应里的 success / sign_in 一律不作为成功依据 —— 这些接口的返回值
 * 与实际到账并不同步，上游真机上出现过「响应成功但余额没变」。
 *
 * 这里只测纯函数 judgeCredit，不依赖 Electron 运行时。
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/relogin.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/relogin.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { judgeCredit } = require('../.tmp/relogin.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// 1) 正常到账
const r1 = judgeCredit(100, 125)
check('增量 +$25 判为到账', r1.credited === true && r1.delta === 25, r1.message)

// 2) 增量不足阈值
const r2 = judgeCredit(100, 110)
check('增量 +$10 判为未到账', r2.credited === false && r2.delta === 10, r2.message)

// 3) 恰好达到阈值
const r3 = judgeCredit(100, 115)
check('增量恰为 $15 判为到账', r3.credited === true && r3.delta === 15, r3.message)

// 4) 余额未变：奖励没发，绝不能报成功
const r4 = judgeCredit(100, 100)
check('余额未变判为失败', r4.credited === false && r4.delta === 0, r4.message)

// 5) 余额下降（正在用）：不得误判
const r5 = judgeCredit(100, 95)
check('余额下降判为失败', r5.credited === false && r5.delta === -5, r5.message)

// 6) 余额读不到：不能假装成功
const r6 = judgeCredit(undefined, undefined)
check('余额不可读判为失败', r6.credited === false && /无法确认/.test(r6.message), r6.message)

// 7) 单边读不到
const r7 = judgeCredit(100, undefined)
check('单边余额缺失判为失败', r7.credited === false, r7.message)

// 8) 浮点精度：0.1 + 0.2 类问题不应影响判据
const r8 = judgeCredit(100.1, 115.1)
check('浮点余额仍正确判定', r8.credited === true && r8.delta === 15, String(r8.delta))

// 9) 大额到账
const r9 = judgeCredit(0, 175)
check('大额到账正常识别', r9.credited === true && r9.delta === 175, r9.message)

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${results.length} checks)`)
process.exit(failed.length === 0 ? 0 : 1)
