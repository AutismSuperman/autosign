/**
 * 更新策略的纯计算测试。
 *
 * 覆盖真实会遇到的几种情况：
 *   1. 只有 Developer ID 签名的 macOS 构建可以应用内安装
 *   2. ad-hoc / 未签名 / 读不到签名信息时一律走手动下载
 *   3. Windows / Linux 不受签名影响
 *   4. 从更新清单挑 DMG 时优先当前架构，架构缺失时退回第一个
 *   5. 文件名要拼成可点击的 Release 资产地址，完整 URL 不重复拼接
 *   6. 原始报错翻译成用户能操作的一句话
 *
 * 运行：npm test
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
mkdirSync('.tmp', { recursive: true })
await build({
  entryPoints: ['src/main/updatePolicy.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: '.tmp/updatePolicy.cjs',
  logLevel: 'error'
})
const {
  parseDeveloperIdSigned,
  pickMacDownload,
  releaseAssetUrl,
  releasePageUrl,
  repoHomeUrl,
  requiresManualInstall,
  resolveAssetUrl,
  friendlyUpdateError,
  RELEASE_REPO
} = require('../.tmp/updatePolicy.cjs')

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

const developerIdOutput = [
  'Executable=/Applications/AutoSign.app/Contents/MacOS/AutoSign',
  'Identifier=icu.autosign.desktop',
  'Authority=Developer ID Application: Example Corp (ABCDE12345)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA'
].join('\n')

const adhocOutput = [
  'Executable=/Applications/AutoSign.app/Contents/MacOS/AutoSign',
  'Identifier=icu.autosign.desktop',
  'Signature=adhoc',
  'TeamIdentifier=not set'
].join('\n')

// 1. 签名识别
ck('识别 Developer ID 签名', parseDeveloperIdSigned(developerIdOutput) === true)
ck('ad-hoc 签名不算开发者签名', parseDeveloperIdSigned(adhocOutput) === false)
ck('空输出不会误判为已签名', parseDeveloperIdSigned('') === false)

// 2. 平台策略
ck('macOS + Developer ID 可应用内安装', requiresManualInstall('darwin', true) === false)
ck('macOS + ad-hoc 只能手动安装', requiresManualInstall('darwin', false) === true)
ck('Windows 不受签名影响', requiresManualInstall('win32', false) === false)
ck('Linux 不受签名影响', requiresManualInstall('linux', false) === false)

// 3. 挑安装包：优先当前架构
const files = [
  { url: 'AutoSign-0.4.2-x64-mac.dmg' },
  { url: 'AutoSign-0.4.2-arm64-mac.dmg' },
  { url: 'AutoSign-0.4.2-arm64-mac.zip' }
]
ck('arm64 机器挑到 arm64 包', pickMacDownload(files, 'arm64') === 'AutoSign-0.4.2-arm64-mac.dmg')
ck('x64 机器挑到 x64 包', pickMacDownload(files, 'x64') === 'AutoSign-0.4.2-x64-mac.dmg')
ck(
  '只有另一架构时退回第一个 dmg',
  pickMacDownload([{ url: 'AutoSign-0.4.2-x64-mac.dmg' }], 'arm64') === 'AutoSign-0.4.2-x64-mac.dmg'
)
ck('没有 dmg 时返回 null', pickMacDownload([{ url: 'a.zip' }], 'arm64') === null)
ck('空清单返回 null', pickMacDownload([], 'arm64') === null)

// 4. 链接拼装
ck(
  '文件名拼成 Release 资产地址',
  releaseAssetUrl('0.4.2', 'AutoSign-0.4.2-arm64-mac.dmg') ===
    'https://github.com/AutismSuperman/autosign/releases/download/v0.4.2/AutoSign-0.4.2-arm64-mac.dmg'
)
ck(
  '完整 URL 原样返回',
  resolveAssetUrl('0.4.2', 'https://example.com/a.dmg') === 'https://example.com/a.dmg'
)
ck(
  '相对文件名走拼接',
  resolveAssetUrl('0.4.2', 'a.dmg').startsWith('https://github.com/')
)
ck('Release 页地址稳定', releasePageUrl().endsWith('/releases/latest'))

// 项目地址与下载地址都由主进程给出，界面不再自己拼字符串。
// 两者必须指向同一仓库，否则「下载不了又不知道去哪下」。
ck(
  '项目主页指向发布仓库',
  repoHomeUrl() === `https://github.com/${RELEASE_REPO}`,
  repoHomeUrl()
)
ck(
  '下载页是同一仓库的 releases 页面',
  releasePageUrl() === `${repoHomeUrl()}/releases/latest`,
  releasePageUrl()
)

// 5. 报错翻译
const zipErr = friendlyUpdateError('ZIP file not provided: [{"url":"x.dmg"}]')
ck('ZIP 缺失翻译为手动下载提示', zipErr.includes('手动下载'), zipErr)
ck('签名拒绝有对应提示', friendlyUpdateError('code failed to satisfy specified code requirement').includes('签名'))
ck('校验和错误有对应提示', friendlyUpdateError('sha512 checksum mismatch').includes('校验'))
ck('网络错误有对应提示', friendlyUpdateError('getaddrinfo ENOTFOUND github.com').includes('网络'))
ck('未知错误原样保留', friendlyUpdateError('something odd') === 'something odd')
ck('空错误不会变成空串', friendlyUpdateError('') === '未知错误')

const failed = checks.filter((ok) => !ok).length
console.log(`\n${checks.length - failed}/${checks.length} 通过`)
if (failed > 0) process.exit(1)
