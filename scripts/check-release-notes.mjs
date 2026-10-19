/**
 * 发版前检查发布说明。
 *
 * AGENTS.md §1.7 要求每个正式版本都有可读的发布说明。这项检查必须发生在
 * **打 tag 之前**：tag 一旦推送就不允许删除重打，若等到 CI 再判定缺失，
 * 只能再递增一个 patch 版本去绕，代价比提前拦住大得多。
 *
 * 判定标准（都可机器验证）：
 *   1. docs/releases/v<version>.md 存在
 *   2. 标题里的版本号与 package.json 一致
 *   3. 写了发布日期
 *   4. 有「本次变更」与「需要你手动做的」两节
 *   5. 不出现「优化体验」「修复若干问题」这类无法验证的表述
 *
 * 运行：node scripts/check-release-notes.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const relPath = join(root, 'docs', 'releases', `v${version}.md`)

const problems = []
const fail = (msg) => problems.push(msg)

if (!existsSync(relPath)) {
  fail(
    `缺少发布说明 docs/releases/v${version}.md —— 正式版本必须有可读的变更说明（AGENTS.md §1.7）`
  )
} else {
  const text = readFileSync(relPath, 'utf8')
  const body = text.trim()

  if (!body) {
    fail('发布说明是空文件')
  } else {
    if (!new RegExp(`v?${version.replace(/\./g, '\\.')}`).test(text.split('\n')[0] ?? '')) {
      fail(`标题里的版本号与 package.json（${version}）不一致`)
    }
    if (!/发布日期[:：]\s*\d{4}-\d{2}-\d{2}/.test(text)) {
      fail('缺少「发布日期：YYYY-MM-DD」')
    }
    if (!/##\s*本次变更/.test(text)) fail('缺少「本次变更」一节')
    if (!/##\s*需要你手动做的/.test(text)) fail('缺少「需要你手动做的」一节')

    // 无法验证的空话：说清楚改了什么，而不是笼统地说「优化」
    for (const vague of [/优化体验/g, /修复若干问题/g, /若干优化/g, /性能优化/g]) {
      if (vague.test(text)) fail(`出现无法验证的表述「${vague.source}」，请写清具体改了什么`)
    }
  }
}

if (problems.length > 0) {
  console.error(`✗ 发布说明检查未通过（v${version}）：`)
  for (const p of problems) console.error(`  - ${p}`)
  console.error('\n参考已有写法：docs/releases/')
  process.exit(1)
}

console.log(`✓ 发布说明检查通过：docs/releases/v${version}.md`)
