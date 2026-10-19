/**
 * 窗口位置 / 大小记忆的纯计算测试。
 *
 * 覆盖真实会遇到的几种情况：
 *   1. 首次启动没有任何记录 → 主屏居中
 *   2. 正常记录原样恢复
 *   3. 记录尺寸小于最小尺寸 → 抬到最小尺寸
 *   4. 记录位于已拔掉的外接屏 → 回到主屏居中，而不是留在看不见的地方
 *   5. 记录跨屏但仍有足够可见部分 → 保留原位
 *   6. 最大化标记会跟着恢复
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/windowBounds.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/windowBounds.cjs',
  logLevel: 'error'
})
const { sanitizeWindowBounds } = require('../.tmp/windowBounds.cjs')

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const secondary = { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }
const size = { width: 1440, height: 900, minWidth: 1040, minHeight: 640 }

// 1. 首次启动：主屏居中，默认尺寸
{
  const b = sanitizeWindowBounds(null, [primary], size)
  ck('无记录时使用默认尺寸', b.width === 1440 && b.height === 900, `${b.width}x${b.height}`)
  ck(
    '无记录时在主屏居中',
    b.x === (1920 - 1440) / 2 && b.y === (1040 - 900) / 2,
    `${b.x},${b.y}`
  )
  ck('无记录时不处于最大化', b.maximized === false)
}

// 2. 正常记录原样恢复
{
  const saved = { x: 120, y: 80, width: 1300, height: 800, maximized: false }
  const b = sanitizeWindowBounds(saved, [primary], size)
  ck('正常记录原样恢复', b.x === 120 && b.y === 80 && b.width === 1300 && b.height === 800)
}

// 3. 小于最小尺寸时抬到最小尺寸
{
  const saved = { x: 100, y: 100, width: 400, height: 300, maximized: false }
  const b = sanitizeWindowBounds(saved, [primary], size)
  ck('恢复时不小于最小尺寸', b.width === 1040 && b.height === 640, `${b.width}x${b.height}`)
}

// 4. 外接屏已拔掉：位置完全不在任何显示器内 → 主屏居中
{
  const saved = { x: 2400, y: 200, width: 1200, height: 800, maximized: false }
  const b = sanitizeWindowBounds(saved, [primary], size)
  const centeredX = Math.floor((1920 - 1200) / 2)
  ck('屏幕外记录回到主屏居中', b.x === centeredX && b.y === 120, `${b.x},${b.y}`)
}

// 5. 跨屏但仍有可见部分：保留原位
{
  const saved = { x: -300, y: 60, width: 1200, height: 800, maximized: false }
  const b = sanitizeWindowBounds(saved, [primary], size)
  ck('部分可见时保留原位置', b.x === -300 && b.y === 60, `${b.x},${b.y}`)
}

// 6. 副屏仍在时允许留在副屏
{
  const saved = { x: 2200, y: 100, width: 1200, height: 800, maximized: false }
  const b = sanitizeWindowBounds(saved, [primary, secondary], size)
  ck('副屏可用时保留在副屏', b.x === 2200 && b.y === 100, `${b.x},${b.y}`)
}

// 7. 最大化标记跟随恢复
{
  const saved = { x: 100, y: 100, width: 1200, height: 800, maximized: true }
  const b = sanitizeWindowBounds(saved, [primary], size)
  ck('最大化标记被恢复', b.maximized === true)
}

// 8. 尺寸超过屏幕时收敛到工作区
{
  const saved = { x: 0, y: 0, width: 3000, height: 2000, maximized: false }
  const b = sanitizeWindowBounds(saved, [primary], size)
  ck('超出屏幕的尺寸收敛到工作区', b.width === 1920 && b.height === 1040, `${b.width}x${b.height}`)
}

// 9. 损坏的记录（非数字）按首次启动处理
{
  const b = sanitizeWindowBounds(
    { x: NaN, y: 10, width: 1200, height: 800, maximized: false },
    [primary],
    size
  )
  ck('损坏记录回退到默认尺寸', b.width === 1440 && b.height === 900, `${b.width}x${b.height}`)
}

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
process.exit(failed === 0 ? 0 : 1)
