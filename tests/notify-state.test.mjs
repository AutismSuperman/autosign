/**
 * 「每版本只提示一次」的持久化状态测试。
 *
 * 覆盖真实会遇到的几种情况：
 *   1. 首次启动没有记录文件 → 任何版本都该提示
 *   2. 提示过的版本不再提示，但不影响其它版本
 *   3. 记录能跨实例读回（模拟重启应用）
 *   4. 文件损坏时退化为「没提示过」，而不是抛错
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/notifyState.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/notifyState.cjs',
  logLevel: 'error'
})
const { NotifyStateStore } = require('../.tmp/notifyState.cjs')

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const dir = '.tmp/notify-test'
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const file = join(dir, 'update-notify.json')

// 1. 没有记录文件
{
  const s = new NotifyStateStore(file)
  await s.load()
  ck('首次运行任何版本都提示', s.shouldNotify('0.4.3') === true)
  ck('首次运行对同一版本也返回 true', s.shouldNotify('0.4.3') === true)
}

// 2. 记录后不再提示该版本
{
  const s = new NotifyStateStore(file)
  await s.load()
  await s.markNotified('0.4.3')
  ck('提示过的版本不再提示', s.shouldNotify('0.4.3') === false)
  ck('新版本仍会提示', s.shouldNotify('0.4.4') === true)
}

// 3. 跨实例读回（模拟重启）
{
  const s = new NotifyStateStore(file)
  await s.load()
  ck('重启后记得已提示的版本', s.shouldNotify('0.4.3') === false)
  ck('重启后新版本仍需提示', s.shouldNotify('0.5.0') === true)
}

// 4. 文件损坏
{
  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{ not json')
  const s = new NotifyStateStore(broken)
  await s.load()
  ck('文件损坏时退化为未提示', s.shouldNotify('0.4.3') === true)
}

// 5. 只记最近一次，旧的版本号不该无限增长
{
  const s = new NotifyStateStore(file)
  await s.load()
  await s.markNotified('0.9.9')
  await s.markNotified('1.0.0')
  ck('只保留最近提示的版本', s.shouldNotify('0.9.9') === true)
  ck('最近提示的版本被记住', s.shouldNotify('1.0.0') === false)
}

// 6. 落盘产生可读文件
{
  ck('状态文件已写入', existsSync(file))
}

rmSync(dir, { recursive: true, force: true })

const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
if (failed > 0) process.exit(1)
