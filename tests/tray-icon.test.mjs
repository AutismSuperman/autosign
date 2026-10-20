/**
 * 托盘图标的静态检查。
 *
 * 起因：macOS 菜单栏里出现了一块巨大的蓝紫色方块 —— 托盘直接用了
 * 512px 的彩色应用图标，系统把它原样塞进 22pt 高的菜单栏。
 *
 * 这里不启动 Electron，只校验产物本身：
 *   1. macOS 模板图存在，且是 44×44 的 RGBA（对应 22pt @2x）
 *   2. 模板图前景是纯黑、背景透明（模板图由系统按主题着色，
 *      带颜色或带不透明背景都会被系统原样呈现）
 *   3. 模板图不是整块不透明（那就是又退回了彩色方块）
 *
 * 运行：npm test
 */
import { readFileSync, existsSync } from 'node:fs'

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const file = 'resources/trayTemplate.png'
ck('macOS 托盘模板图存在', existsSync(file))
if (!existsSync(file)) {
  console.log(`\n0/${checks.length} 通过`)
  process.exit(1)
}

const buf = readFileSync(file)
// PNG 头：8 字节签名 + IHDR（宽高各 4 字节大端，随后位深、颜色类型）
ck('是 PNG 格式', buf.subarray(1, 4).toString('latin1') === 'PNG')
const width = buf.readUInt32BE(16)
const height = buf.readUInt32BE(20)
const bitDepth = buf[24]
const colorType = buf[25]

ck('尺寸为 44×44（22pt @2x）', width === 44 && height === 44, `${width}×${height}`)
// colorType 6 = RGBA，模板图必须有 alpha 通道
ck('带 alpha 通道（RGBA）', colorType === 6, `colorType=${colorType}`)
ck('位深 8', bitDepth === 8, `bitDepth=${bitDepth}`)

// 解出像素做形状与配色检查。PNG 数据是 zlib 压缩的 IDAT，这里按最小实现解。
// 不引第三方库：只处理我们自己生成的这一种格式。
import { inflateSync } from 'node:zlib'

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

const png = decodePng(buf)
let opaque = 0
let colored = 0
for (let i = 0; i < png.width * png.height; i++) {
  const o = i * 4
  const [r, g, b, a] = [png.data[o], png.data[o + 1], png.data[o + 2], png.data[o + 3]]
  if (a > 200) {
    opaque++
    // 模板图要求前景为黑（或极深灰）；出现明显彩色说明还在用彩色图标
    if (Math.abs(r - g) > 24 || Math.abs(g - b) > 24) colored++
  }
}

const total = png.width * png.height
ck('背景为透明（不是整块实心）', opaque < total * 0.85, `不透明占比 ${((opaque / total) * 100).toFixed(0)}%`)
ck('前景为单色黑（适合模板着色）', colored === 0, `彩色像素 ${colored}`)
ck('图形足够可见（不是空图）', opaque > total * 0.05, `不透明占比 ${((opaque / total) * 100).toFixed(0)}%`)

const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
if (failed > 0) process.exit(1)
