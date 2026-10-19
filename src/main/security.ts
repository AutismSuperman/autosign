import { safeStorage } from 'electron'

/**
 * 敏感字段加密。
 *
 * 优先使用 safeStorage（Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 系统后端不可用时**拒绝降级为明文**，由调用方保留旧值并提示用户，
 * 与上游 Android 端「Keystore 不可用即拒绝明文落盘」保持同一策略。
 */

const PREFIX = 'enc:v1:'

export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

/** 加密为可落盘的字符串。不可用时返回 null，调用方必须据此拒绝写入。 */
export function seal(plain: string): string | null {
  if (!plain) return ''
  if (!encryptionAvailable()) return null
  try {
    return PREFIX + safeStorage.encryptString(plain).toString('base64')
  } catch {
    return null
  }
}

/** 解密。未加密的旧值或解密失败返回空串，不抛异常。 */
export function open(sealed: string | undefined | null): string {
  if (!sealed) return ''
  if (!sealed.startsWith(PREFIX)) return sealed
  if (!encryptionAvailable()) return ''
  try {
    return safeStorage.decryptString(Buffer.from(sealed.slice(PREFIX.length), 'base64'))
  } catch {
    return ''
  }
}

/** 是否为已加密值，用于迁移判断。 */
export function isSealed(value: string | undefined | null): boolean {
  return !!value && value.startsWith(PREFIX)
}
