/**
 * 托盘图标的静态检查。
 *
 * 起因：macOS 菜单栏里出现过一块巨大的蓝紫色方块（托盘直接用了彩色应用
 * 图标），后来改为模板图后又出现过 Retina 下发虚（代码把 44px 单档
 * resize 成 22px，高分屏被系统放大回去）。
 *
 * 这里不启动 Electron，只校验产物本身：
 *   1. macOS 模板图两档齐全：22×22（@1x）与 44×44（@2x），
 *      Electron 按文件名自动装载 @2x，缺档时 Retina 必然发虚
 *   2. 模板图前景是纯黑、背景透明（模板图由系统按主题着色，
 *      带颜色或带不透明背景都会被系统原样呈现）
 *   3. Windows 托盘四档齐全：16/20/24/32 物理像素，
 *      对应 100%/125%/150%/200% DPI，缺档时系统拉伸相邻档会发糊
 *
 * 运行：npm test
 */
import { readFileSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

// 解出像素做形状与配色检查。PNG 数据是 zlib 压缩的 IDAT，这里按最小实现解。
// 不引第三方库：只处理我们自己生成的这一种格式（8 位 RGBA）。
function decodePng(image) {
  let pos = 8
  let w = 0
  let h = 0
  let ct = 0
  const idat = []
  while (pos < image.length) {
    const len = image.readUInt32BE(pos)
    const type = image.subarray(pos + 4, pos + 8).toString('latin1')
    const data = image.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      ct = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  const channels = ct === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const out = Buffer.alloc(w * h * channels)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = Buffer.alloc(stride)
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width: w, height: h, channels, data: out }
}

function pngInfo(file) {
  const buf = readFileSync(file)
  if (buf.subarray(1, 4).toString('latin1') !== 'PNG') return null
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    png: decodePng(buf)
  }
}

/** 模板图要求：RGBA、前景纯黑、背景透明、图形可见。 */
function checkTemplate(file, expect) {
  const label = file.split('/').pop()
  if (!existsSync(file)) {
    ck(`${label} 存在`, false)
    return
  }
  const info = pngInfo(file)
  ck(`${label} 是 8 位 RGBA PNG`, !!info && info.colorType === 6 && info.bitDepth === 8, info ? `colorType=${info.colorType}` : '解析失败')
  ck(`${label} 尺寸 ${expect}×${expect}`, !!info && info.width === expect && info.height === expect, info ? `${info.width}×${info.height}` : '')
  if (!info) return
  let opaque = 0
  let colored = 0
  for (let i = 0; i < info.width * info.height; i++) {
    const o = i * 4
    const [r, g, b, a] = [info.png.data[o], info.png.data[o + 1], info.png.data[o + 2], info.png.data[o + 3]]
    if (a > 200) {
      opaque++
      // 模板图要求前景为黑（或极深灰）；出现明显彩色说明还在用彩色图标
      if (Math.abs(r - g) > 24 || Math.abs(g - b) > 24) colored++
    }
  }
  const total = info.width * info.height
  const ratio = ((opaque / total) * 100).toFixed(0)
  ck(`${label} 背景透明、图形可见`, opaque > total * 0.05 && opaque < total * 0.85, `不透明占比 ${ratio}%`)
  ck(`${label} 前景单色黑`, colored === 0, `彩色像素 ${colored}`)
}

// macOS 菜单栏：@1x 与 @2x 两档都要在，Electron 才会按屏幕缩放自选
checkTemplate('resources/trayTemplate.png', 22)
checkTemplate('resources/trayTemplate@2x.png', 44)

// Windows 通知区：100%/125%/150%/200% DPI 各一档物理像素
for (const px of [16, 20, 24, 32]) {
  const file = `resources/tray-${px}.png`
  if (!existsSync(file)) {
    ck(`${file} 存在`, false)
    continue
  }
  const info = pngInfo(file)
  ck(`${file} 尺寸与 RGBA`, !!info && info.width === px && info.height === px && info.colorType === 6, info ? `${info.width}×${info.height}` : '解析失败')
  if (info) {
    let opaque = 0
    for (let i = 0; i < info.width * info.height; i++) if (info.png.data[i * 4 + 3] > 200) opaque++
    ck(`${file} 图形非空`, opaque > info.width * info.height * 0.2, `不透明占比 ${((opaque / (info.width * info.height)) * 100).toFixed(0)}%`)
  }
}

const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
if (failed > 0) process.exit(1)
