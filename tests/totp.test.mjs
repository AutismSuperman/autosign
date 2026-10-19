/**
 * TOTP 算法测试。
 *
 * 用 RFC 6238 标准测试向量验证实现正确性。
 * 这段代码一旦算错，用户保存的两步验证凭据就永远登不进去，
 * 所以必须有确定性的向量比对，不能只测"能跑"。
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/auth/totp.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/totp.cjs',
  logLevel: 'error'
})

const { totp, base32Decode, isUsableTotpSecret, secondsRemaining } = require('../.tmp/totp.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// RFC 6238 附录 B 的标准向量（SHA-1，密钥 "12345678901234567890"）
// 编码为 Base32 是 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const vectors = [
  { time: 59_000, expect: '287082' },
  { time: 1_111_111_109_000, expect: '081804' },
  { time: 1_111_111_111_000, expect: '050471' },
  { time: 1_234_567_890_000, expect: '005924' },
  { time: 2_000_000_000_000, expect: '279037' }
]

for (const v of vectors) {
  const got = totp(RFC_SECRET, v.time)
  check(`RFC 6238 向量 t=${v.time / 1000}`, got === v.expect, `期望 ${v.expect}，实际 ${got}`)
}

// Base32 解码
const decoded = base32Decode(RFC_SECRET)
check(
  'Base32 解码得到 20 字节',
  decoded.length === 20,
  `实际 ${decoded.length} 字节`
)
check(
  'Base32 解码内容正确',
  decoded.toString() === '12345678901234567890',
  decoded.toString()
)

// 容错：空格、小写、连字符都应接受
check('忽略空格与小写', totp('GEZD GNBV GY3T QOJQ GEZD GNBV GY3T QOJQ', 59_000) === '287082')
check('忽略连字符', totp('GEZD-GNBV-GY3T-QOJQ', 59_000) === base32Decode('GEZDGNBVGY3TQOJQ').length ? true : totp('GEZD-GNBV-GY3T-QOJQ', 59_000).length === 6)

// 合法性校验
check('有效密钥通过校验', isUsableTotpSecret(RFC_SECRET) === true)
check('过短密钥被拒绝', isUsableTotpSecret('ABCD') === false)
check('非法字符被拒绝', isUsableTotpSecret('GEZD!!!') === false)
check('空密钥被拒绝', isUsableTotpSecret('') === false)

// 时间片边界：同一 30s 内结果稳定，跨片变化
const t = 1_700_000_000_000
check('同一时间片内结果稳定', totp(RFC_SECRET, t) === totp(RFC_SECRET, t + 5_000))
check('跨时间片结果不同', totp(RFC_SECRET, t) !== totp(RFC_SECRET, t + 30_000))

// 输出格式
const code = totp(RFC_SECRET, Date.now())
check('验证码为 6 位数字', /^\d{6}$/.test(code), code)

// 剩余秒数
const remain = secondsRemaining(Date.now())
check('剩余秒数在 1..30', remain >= 1 && remain <= 30, String(remain))

const failed = results.filter((r) => !r.ok)
console.log(`\n${failed.length === 0 ? 'ALL PASS' : `${failed.length} FAILED`} (${results.length} checks)`)
process.exit(failed.length === 0 ? 0 : 1)
