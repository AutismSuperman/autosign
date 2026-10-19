/**
 * API Key 解析测试。
 *
 * New API 的 /api/token/ 返回结构有多个变体（上游为此做过兼容）：
 *   - data.items[]
 *   - data 直接是数组
 *   - data.data.items
 *   - data.records
 * 这里逐种覆盖，确保不会因为结构差异显示 0 个 Key。
 *
 * 同时校验：站点给的是脱敏 key 就原样展示，缺字段时留空，绝不编造。
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/sites/tokens.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/tokens.cjs',
  external: ['electron'],
  logLevel: 'error'
})

const { pickTokenItems, normalizeToken } = require('../.tmp/tokens.cjs')

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// ---- 各种嵌套形态 ----
const item = { id: 1, name: '默认', key: 'sk-a****z', group: 'default', status: 1 }

check(
  'data.items[]',
  pickTokenItems({ success: true, data: { items: [item] } }).length === 1
)
check(
  'data 直接是数组',
  pickTokenItems({ success: true, data: [item, item] }).length === 2
)
check(
  'data.data.items',
  pickTokenItems({ success: true, data: { data: { items: [item] } } }).length === 1
)
check(
  'data.records',
  pickTokenItems({ success: true, data: { records: [item] } }).length === 1
)
check(
  '根级 items（极少变体）',
  pickTokenItems({ success: true, items: [item] }).length === 1
)
check('success=false 不解析', pickTokenItems({ success: false, data: { items: [item] } }).length === 0)
check('空对象返回空数组', pickTokenItems({ success: true, data: {} }).length === 0)
check('null 返回空数组', pickTokenItems(null).length === 0)

// ---- 字段规范化 ----
const k = normalizeToken(
  {
    id: 7,
    name: '主力',
    key: 'sk-abc****xyz',
    group: 'vip',
    status: 1,
    unlimited_quota: true,
    remain_quota: 123456,
    expired_time: -1
  },
  0
)
check('id 转字符串', k.id === '7', k.id)
check('名称保留', k.name === '主力', k.name)
check('key 原样保留（已脱敏）', k.key === 'sk-abc****xyz', k.key)
check('分组保留', k.group === 'vip', k.group)
check('status 数字 1 视为启用', k.status === true)
check('unlimited_quota 正确', k.unlimitedQuota === true)
check('剩余额度保留', k.remainQuota === 123456, String(k.remainQuota))
check('过期时间 -1（永不过期）', k.expiredTime === -1)

const noKey = normalizeToken({ id: 9 }, 3)
check('缺名称时用序号兜底', noKey.name === 'Key 4', noKey.name)
check('缺 key 时留空不编造', noKey.key === '', JSON.stringify(noKey.key))
check('缺分组时为空字符串', noKey.group === '')
check('缺 status 视为禁用', noKey.status === false)

const disabled = normalizeToken({ id: 1, status: 0 }, 0)
check('status 数字 0 视为禁用', disabled.status === false)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length) process.exit(1)
