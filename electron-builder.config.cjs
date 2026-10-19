/**
 * 版本号唯一来源是 package.json，这里只在构建时读一次，
 * 供 electron-builder 生成 latest.yml（自动更新用它判断版本）。
 */
const { version } = require('./package.json')

module.exports = {
  appId: 'icu.autosign.desktop',
  productName: 'AutoSign',
  directories: {
    output: 'dist',
    buildResources: 'build'
  },
  files: ['out/**/*', 'resources/**/*'],
  publish: [
    {
      provider: 'github',
      owner: 'AutismSuperman',
      repo: 'autosign'
    }
  ],
  // 便于在产物里核对版本号与构建来源
  extraMetadata: {
    version
  },
  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    // 文件名带上版本与平台：三个平台的产物混在同一个 Release 里时更好辨认
    artifactName: '${productName}-${version}-${arch}-win.${ext}'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // 卸载时保留用户数据目录：重装后账号与登录态仍在
    deleteAppDataOnUninstall: false
  },
  mac: {
    target: ['dmg'],
    category: 'public.app-category.utilities',
    icon: 'build/icon.icns',
    // identity: '-' 表示 ad-hoc 签名。
    //
    // 没有 Apple Developer 证书时，electron-builder 默认完全不签名；
    // 而 Apple Silicon 上的 Gatekeeper 会把「未签名」的 app 直接判为
    // 「已损坏，应移到废纸篓」。ad-hoc 签名不证明开发者身份，但让
    // 应用带有有效的代码签名结构，双击即可正常启动。
    //
    // 配置了正式证书（CSC_LINK / CSC_KEY_PASSWORD）时，CI 会用证书
    // 签名，identity 会被实际证书覆盖。
    identity: '-',
    hardenedRuntime: false,
    gatekeeperAssess: false,
    // 同时产出 Apple Silicon 与 Intel 两版
    artifactName: '${productName}-${version}-${arch}-mac.${ext}'
  },
  linux: {
    target: ['AppImage'],
    category: 'Utility',
    icon: 'build/icon.png',
    artifactName: '${productName}-${version}-${arch}-linux.${ext}'
  }
}
