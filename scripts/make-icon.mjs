/**
 * 应用图标生成器（唯一来源）。
 *
 * 设计：渐变圆角方块 + 环形箭头 + 对勾。
 *   - 圆角方块沿用品牌渐变（蓝 → 紫），与应用内侧边栏品牌标一致
 *   - 环形箭头表示「周期性重复执行」，对勾表示「签到已完成」
 *   - 环的两端用圆头收尾、箭头用圆角三角形，避免旧版 PIL 直切端点的破损感
 *
 * 三套光学变体（同一设计语言，按使用场景取舍细节）：
 *   mac      macOS 主图标：1024 画布上方块占 824（系统图标网格），带柔和投影
 *   win      Windows/Linux 主图标：满幅圆角方块（任务栏/资源管理器不遮罩，留白会显小）
 *   compact  16–32px 小尺寸：只保留加粗对勾，小尺寸下环+箭头会糊成一团
 *   template macOS 菜单栏：22pt 单色模板图，纯黑 + alpha，由系统按亮暗主题着色
 *
 * 光栅化交给 Chromium（scripts/icon-render.cjs）：SVG 是矢量源，
 * 每个尺寸直接按目标分辨率渲染，比「画大图再缩小」边缘更干净。
 *
 * 产物：
 *   build/icon.png              1024，electron-builder（Linux 及兜底）
 *   build/icon.ico              Windows：16/20/24/32/40/48/64/128 为 32 位 BMP，
 *                               256 为 PNG（微软图标规范只允许 256 用 PNG 压缩）
 *   build/icon.icns             macOS：icp4…ic10 全档位
 *   resources/icon.png          512，开发期 Dock / 非 Windows 窗口图标
 *   resources/icon.ico          Windows 窗口图标（标题栏、Alt-Tab）
 *   resources/brand.png         256，侧边栏品牌标
 *   resources/tray-16/20/24/32  Windows 托盘按 DPI 取 16/20/24/32 物理像素
 *   resources/trayTemplate.png      22×22（22pt @1x）
 *   resources/trayTemplate@2x.png   44×44（22pt @2x，Retina 不放大发虚）
 *
 * 运行：npm run icons
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { electronPath } from './electron-path.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const gen = join(root, '.tmp', 'icon-gen')

// ---------- 几何 ----------

const rad = (deg) => (deg * Math.PI) / 180
const pt = (cx, cy, r, deg) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))]
const n2 = (v) => Math.round(v * 100) / 100

/** 环缺口固定在上偏右：弧从 -55° 顺时针画到 235°（290° 弧），箭头接在 235° 端。 */
const ARC_FROM = -55
const ARC_TO = 235

/**
 * 环形箭头 + 对勾。master 与 template 共用一套参数化几何，
 * 只是坐标系与线宽不同（菜单栏要更粗的相对线宽才看得清）。
 */
function glyph({ cx, cy, R, W, headLen, headHalf, headRound, checkW, checkPts, color }) {
  const [ax, ay] = pt(cx, cy, R, ARC_FROM)
  const [bx, by] = pt(cx, cy, R, ARC_TO)
  const arc = `M ${n2(ax)} ${n2(ay)} A ${R} ${R} 0 1 1 ${n2(bx)} ${n2(by)}`

  // 顺时针切线 / 径向外法线（屏幕坐标 y 向下）
  const t = [-Math.sin(rad(ARC_TO)), Math.cos(rad(ARC_TO))]
  const n = [Math.cos(rad(ARC_TO)), Math.sin(rad(ARC_TO))]
  const pull = W * 0.13 // 箭头底边压进弧身，圆头端点被盖住，缺口处不露毛刺
  const bx0 = bx - t[0] * pull
  const by0 = by - t[1] * pull
  const tip = [bx0 + t[0] * headLen, by0 + t[1] * headLen]
  const b1 = [bx0 + n[0] * headHalf, by0 + n[1] * headHalf]
  const b2 = [bx0 - n[0] * headHalf, by0 - n[1] * headHalf]
  const head = `M ${n2(tip[0])} ${n2(tip[1])} L ${n2(b1[0])} ${n2(b1[1])} L ${n2(b2[0])} ${n2(b2[1])} Z`

  const check = `M ${checkPts.map(([x, y]) => `${n2(x)} ${n2(y)}`).join(' L ')}`

  return [
    `<path d="${arc}" fill="none" stroke="${color}" stroke-width="${W}" stroke-linecap="round"/>`,
    `<path d="${head}" fill="${color}" stroke="${color}" stroke-width="${headRound}" stroke-linejoin="round"/>`,
    `<path d="${check}" fill="none" stroke="${color}" stroke-width="${checkW}" stroke-linecap="round" stroke-linejoin="round"/>`
  ].join('\n    ')
}

const MASTER_GLYPH = {
  cx: 512,
  cy: 520,
  R: 248,
  W: 62,
  headLen: 136,
  headHalf: 76,
  headRound: 30,
  checkW: 70,
  checkPts: [
    [396, 544],
    [482, 630],
    [640, 436]
  ]
}

/** 彩色图标：渐变方块 + 高光/暗部 + 图形。box 决定留白（mac 网格 vs 满幅）。 */
function colorSvg({ box, shadow, compact }) {
  const { x, w, rx } = box
  const body = compact
    ? `<path d="M 300 540 L 452 692 L 736 376" fill="none" stroke="#fff" stroke-width="132" stroke-linecap="round" stroke-linejoin="round"/>`
    : glyph({ ...MASTER_GLYPH, color: '#fff' })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="128" y1="96" x2="896" y2="928">
      <stop offset="0" stop-color="#4F8CFF"/>
      <stop offset="0.52" stop-color="#6D7BF7"/>
      <stop offset="1" stop-color="#8B5CF6"/>
    </linearGradient>
    <radialGradient id="hl" gradientUnits="userSpaceOnUse" cx="360" cy="268" r="560">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="shade" gradientUnits="userSpaceOnUse" x1="512" y1="540" x2="512" y2="1024">
      <stop offset="0" stop-color="#101040" stop-opacity="0"/>
      <stop offset="1" stop-color="#101040" stop-opacity="0.16"/>
    </linearGradient>
    <clipPath id="sq"><rect x="${x}" y="${x}" width="${w}" height="${w}" rx="${rx}"/></clipPath>
    <filter id="ds" x="-25%" y="-25%" width="150%" height="150%">
      <feDropShadow dx="0" dy="12" stdDeviation="20" flood-color="#141a4a" flood-opacity="0.32"/>
    </filter>
  </defs>
  <rect x="${x}" y="${x}" width="${w}" height="${w}" rx="${rx}" fill="url(#bg)"${shadow ? ' filter="url(#ds)"' : ''}/>
  <g clip-path="url(#sq)">
    <rect x="0" y="0" width="1024" height="1024" fill="url(#hl)"/>
    <rect x="0" y="0" width="1024" height="1024" fill="url(#shade)"/>
  </g>
  ${body}
</svg>
`
}

/** macOS 菜单栏模板图：22pt 画布，纯黑剪影，线宽按菜单栏观感单独调粗。 */
function templateSvg() {
  const body = glyph({
    cx: 11,
    cy: 11.3,
    R: 7.35,
    W: 2.05,
    headLen: 4.1,
    headHalf: 2.25,
    headRound: 0.85,
    checkW: 2.35,
    checkPts: [
      [8.51, 11.67],
      [10.36, 13.52],
      [13.75, 9.37]
    ],
    color: '#000'
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
  ${body}
</svg>
`
}

const MAC_BOX = { x: 100, w: 824, rx: 185 } // macOS 图标网格：824/1024，圆角 ≈22.4%
const FULL_BOX = { x: 0, w: 1024, rx: 196 } // Windows/Linux：满幅

const JOB = [
  { key: 'mac', file: 'mac.svg', sizes: [1024, 512, 256, 128, 64, 32, 16] },
  { key: 'win', file: 'win.svg', sizes: [256, 128, 64, 48, 40] },
  { key: 'compact', file: 'compact.svg', sizes: [32, 24, 20, 16] },
  { key: 'template', file: 'template.svg', sizes: [44, 22] }
]

// ---------- ICO / ICNS 封装 ----------

/** 32 位 BI_RGB DIB：XOR 数据自底向上 BGRA，后跟全零 AND 掩码。 */
function dib(size, rgba) {
  const px = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4
      const di = ((size - 1 - y) * size + x) * 4
      px[di] = rgba[si + 2]
      px[di + 1] = rgba[si + 1]
      px[di + 2] = rgba[si]
      px[di + 3] = rgba[si + 3]
    }
  }
  const header = Buffer.alloc(40)
  header.writeInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // 含 AND 掩码的双倍高度
  header.writeInt16LE(1, 12)
  header.writeInt16LE(32, 14)
  const maskRow = Math.floor((size + 31) / 32) * 4
  return Buffer.concat([header, px, Buffer.alloc(maskRow * size)])
}

/** entries: [{ size, png?, rgba? }]；256 用 PNG，其余用 BMP（微软图标规范）。 */
function icoBuffer(entries) {
  const chunks = []
  let offset = 6 + entries.length * 16
  const dir = Buffer.alloc(6 + entries.length * 16)
  dir.writeUInt16LE(0, 0)
  dir.writeUInt16LE(1, 2)
  dir.writeUInt16LE(entries.length, 4)
  entries.forEach((e, i) => {
    const data = e.size === 256 ? e.png : dib(e.size, e.rgba)
    const o = 6 + i * 16
    dir[o] = e.size >= 256 ? 0 : e.size
    dir[o + 1] = e.size >= 256 ? 0 : e.size
    dir[o + 2] = 0
    dir[o + 3] = 0
    dir.writeUInt16LE(1, o + 4)
    dir.writeUInt16LE(32, o + 6)
    dir.writeUInt32LE(data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += data.length
    chunks.push(data)
  })
  return Buffer.concat([dir, ...chunks])
}

const ICNS_TYPES = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' }

function icnsBuffer(pngsBySize) {
  const parts = []
  let total = 8
  for (const [size, type] of Object.entries(ICNS_TYPES)) {
    const png = pngsBySize[Number(size)]
    if (!png) throw new Error(`icns 缺少 ${size}px 档`)
    parts.push(Buffer.from(type, 'latin1'), uint32be(png.length + 8), png)
    total += png.length + 8
  }
  return Buffer.concat([Buffer.from('icns', 'latin1'), uint32be(total), ...parts])
}

function uint32be(v) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(v, 0)
  return b
}

// ---------- 主流程 ----------

function main() {
  rmSync(gen, { recursive: true, force: true })
  mkdirSync(gen, { recursive: true })

  const svgs = {
    'mac.svg': colorSvg({ box: MAC_BOX, shadow: true, compact: false }),
    'win.svg': colorSvg({ box: FULL_BOX, shadow: false, compact: false }),
    'compact.svg': colorSvg({ box: FULL_BOX, shadow: false, compact: true }),
    'template.svg': templateSvg()
  }
  for (const [name, svg] of Object.entries(svgs)) writeFileSync(join(gen, name), svg)
  writeFileSync(
    join(gen, 'render.html'),
    `<!doctype html><meta charset="utf-8"><script>window.__JOB=${JSON.stringify(JOB)};
async function runJob(job) {
  const out = []
  for (const item of job) {
    const img = new Image()
    img.src = item.file
    await img.decode()
    for (const s of item.sizes) {
      const c = document.createElement('canvas')
      c.width = s
      c.height = s
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0, s, s)
      const d = ctx.getImageData(0, 0, s, s).data
      let bin = ''
      for (let i = 0; i < d.length; i += 8192) bin += String.fromCharCode.apply(null, d.subarray(i, i + 8192))
      out.push({ key: item.key, size: s, png: c.toDataURL('image/png'), raw: btoa(bin) })
    }
  }
  return JSON.stringify(out)
}
</script>`
  )

  const child = spawn(electronPath, [join(root, 'scripts', 'icon-render.cjs')], { stdio: 'inherit' })
  child.on('exit', (code) => {
    if (code !== 0) {
      console.error(`渲染进程退出码 ${code}`)
      process.exit(code ?? 1)
    }
    assemble()
  })
}

function assemble() {
  const renders = JSON.parse(readFileSync(join(gen, 'result.json'), 'utf8'))
  const pngOf = (key, size) => {
    const r = renders.find((x) => x.key === key && x.size === size)
    if (!r) throw new Error(`缺少渲染结果 ${key}@${size}`)
    return Buffer.from(r.png.split(',')[1], 'base64')
  }
  const rgbaOf = (key, size) => {
    const r = renders.find((x) => x.key === key && x.size === size)
    return Buffer.from(r.raw, 'base64')
  }

  const build = join(root, 'build')
  const res = join(root, 'resources')

  writeFileSync(join(build, 'icon.png'), pngOf('mac', 1024))
  writeFileSync(join(res, 'icon.png'), pngOf('mac', 512))
  writeFileSync(join(res, 'brand.png'), pngOf('win', 256))

  // Windows ICO：小尺寸用紧凑变体（只留对勾），48 及以上用完整图形
  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const ico = icoBuffer(
    icoSizes.map((size) => {
      const key = size <= 32 ? 'compact' : 'win'
      return size === 256
        ? { size, png: pngOf(key, size) }
        : { size, rgba: rgbaOf(key, size) }
    })
  )
  writeFileSync(join(build, 'icon.ico'), ico)
  writeFileSync(join(res, 'icon.ico'), ico)

  const icns = icnsBuffer(Object.fromEntries([16, 32, 64, 128, 256, 512, 1024].map((s) => [s, pngOf('mac', s)])))
  writeFileSync(join(build, 'icon.icns'), icns)

  // Windows 托盘：按 DPI 提供 16/20/24/32 物理像素
  for (const size of [16, 20, 24, 32]) writeFileSync(join(res, `tray-${size}.png`), pngOf('compact', size))

  // macOS 菜单栏：@1x 22px + @2x 44px，Electron 按文件名自动装载两档
  writeFileSync(join(res, 'trayTemplate.png'), pngOf('template', 22))
  writeFileSync(join(res, 'trayTemplate@2x.png'), pngOf('template', 44))

  console.log('已生成：')
  console.log('  build/icon.png        1024（macOS 网格 + 投影）')
  console.log(`  build/icon.ico        ${icoSizes.join('/')}（<256 为 BMP，256 为 PNG）`)
  console.log('  build/icon.icns       icp4…ic10 全档位')
  console.log('  resources/icon.png    512 / icon.ico / brand.png 256')
  console.log('  resources/tray-16|20|24|32.png（Windows 托盘，按 DPI）')
  console.log('  resources/trayTemplate.png 22 + @2x 44（macOS 菜单栏单色模板）')
}

main()
