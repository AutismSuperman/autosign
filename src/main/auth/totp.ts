import { createHmac } from 'node:crypto'

/**
 * TOTP（RFC 6238）生成。
 *
 * GitHub 的两步验证支持 TOTP，Linux DO（Discourse）也支持。
 * 保存的是 Base32 密钥，每次登录时现算 6 位码 —— 不把码本身存下来，
 * 否则几秒后就失效了。
 */

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** Base32 解码。忽略空格、连字符与填充。 */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '')
  if (!clean) return Buffer.alloc(0)

  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch)
    if (idx < 0) throw new Error(`TOTP 密钥含非法字符：${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** 生成指定时间片的 6 位验证码。 */
export function totp(secret: string, at = Date.now()): string {
  const key = base32Decode(secret)
  if (key.length === 0) throw new Error('TOTP 密钥为空')
  const counter = Math.floor(at / 1000 / 30)
  const buf = Buffer.alloc(8)
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  buf.writeUInt32BE(counter >>> 0, 4)
  const digest = createHmac('sha1', key).update(buf).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(code % 1_000_000).padStart(6, '0')
}

/** 校验用户输入的密钥是否可用（不校验时间，只校验格式）。 */
export function isUsableTotpSecret(secret: string): boolean {
  try {
    return base32Decode(secret).length >= 10
  } catch {
    return false
  }
}

/** 距下个时间片还有多少秒，用于界面提示。 */
export function secondsRemaining(at = Date.now()): number {
  return 30 - Math.floor((at / 1000) % 30)
}
