/**
 * 脚本共用的 Electron 可执行文件路径。
 *
 * npm 的 electron 包会在 node_modules/electron/path.txt 里写明二进制位置
 * （Windows 是 electron.exe，macOS 在 .app 里，Linux 是 electron），
 * 直接按平台拼路径会在 CI 的 Linux 上找不到文件。
 */
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

const root = process.cwd()

export const electronPath = (() => {
  try {
    const rel = readFileSync(join(root, 'node_modules', 'electron', 'path.txt'), 'utf8').trim()
    return join(root, 'node_modules', 'electron', 'dist', rel)
  } catch {
    // 兜底：未安装或 path.txt 缺失时按平台推断
    const name =
      process.platform === 'win32'
        ? 'electron.exe'
        : process.platform === 'darwin'
          ? 'Electron.app/Contents/MacOS/Electron'
          : 'electron'
    return join(root, 'node_modules', 'electron', 'dist', name)
  }
})()
