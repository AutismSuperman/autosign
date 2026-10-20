/**
 * 自动更新的平台策略与文案。
 *
 * 这里只放不依赖 Electron 运行时的判断，便于单独测试：
 *   - macOS 应用内安装的可行性（取决于代码签名方式）
 *   - 从更新清单里挑出与当前架构匹配的 DMG
 *   - 把 electron-updater 的原始报错翻译成用户能看懂的话
 */

/** 发布仓库。与 electron-builder.config.cjs 的 publish.owner/repo 保持一致。 */
export const RELEASE_REPO = 'AutismSuperman/autosign'

export interface UpdateFileInfo {
  url: string
}

/**
 * macOS 的应用内更新由 Squirrel.Mac 驱动：它用「当前已安装应用」的
 * designated requirement 校验新下载的包。ad-hoc 签名没有证书链，
 * 这条要求退化成当次构建的 cdhash，任何新版本都对不上，校验必然失败。
 *
 * 只有 Developer ID 签名（DR 基于证书）才能跨版本通过。因此：
 * 非 Developer ID 签名的 macOS 构建一律走「手动下载安装」，
 * 而不是让用户看到一个必然失败的进度条。
 */
export function requiresManualInstall(
  platform: NodeJS.Platform,
  developerIdSigned: boolean
): boolean {
  return platform === 'darwin' && !developerIdSigned
}

/** 解析 `codesign -dv --verbose=4` 的输出（写在 stderr）。 */
export function parseDeveloperIdSigned(codesignOutput: string): boolean {
  return /Authority=Developer ID Application/.test(codesignOutput)
}

/**
 * 从更新清单里挑出要下载的 DMG。
 *
 * 优先匹配当前架构（文件名形如 `AutoSign-0.4.2-arm64-mac.dmg`）；
 * 架构对不上时退回第一个 DMG，总比没有下载入口好。
 */
export function pickMacDownload(files: UpdateFileInfo[], arch: string): string | null {
  const dmgs = files
    .map((f) => f.url)
    .filter((url) => /\.dmg(?:$|[?#])/i.test(url))
  if (dmgs.length === 0) return null
  return dmgs.find((url) => url.includes(`-${arch}-`)) ?? dmgs[0]
}

/** 由文件名拼出 Release 资产地址：更新清单里的 url 只有文件名。 */
export function releaseAssetUrl(version: string, fileName: string): string {
  return `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${encodeURIComponent(fileName)}`
}

/**
 * 把清单里的条目换成可点击的绝对地址。
 * provider 有时给的是已解析的完整 URL，这种情况原样返回。
 */
export function resolveAssetUrl(version: string, url: string): string {
  return /^https?:\/\//i.test(url) ? url : releaseAssetUrl(version, url)
}

/** 手动下载入口：只有最新正式版，预发布不会出现在这里。 */
export function releasePageUrl(): string {
  return `https://github.com/${RELEASE_REPO}/releases/latest`
}

/**
 * 原始报错里既有库内部信息，也有大段 JSON。这里只保留可操作的那一句，
 * 避免用户对着「ZIP file not provided: [{...}]」无从下手。
 */
export function friendlyUpdateError(raw: string): string {
  const text = (raw ?? '').trim()
  if (/ZIP file not provided/i.test(text)) {
    return '当前发布缺少 macOS 更新包，请手动下载安装包覆盖安装。'
  }
  if (/code failed to satisfy|did not pass validation|could not be verified/i.test(text)) {
    return '系统拒绝了更新包的签名校验，请手动下载安装包覆盖安装。'
  }
  if (/sha512|checksum/i.test(text)) {
    return '更新包校验失败（可能下载不完整），请重试或手动下载。'
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|net::|getaddrinfo/i.test(text)) {
    return '无法连接更新服务器，请检查网络或代理设置后重试。'
  }
  if (/404|Cannot find|latest.*\.yml/i.test(text)) {
    return '更新信息获取失败，请稍后重试或手动下载。'
  }
  return text || '未知错误'
}
