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
    // zip 不是可选项：electron-updater 在 macOS 上只接受 zip 更新包
    // （MacUpdater 按扩展名过滤，找不到 zip 直接抛 ERR_UPDATER_ZIP_FILE_NOT_FOUND）。
    // 只出 dmg 时 latest-mac.yml 里只有 dmg，检查更新必然报
    // 「ZIP file not provided」。dmg 仍保留给用户手动下载安装。
    target: ['dmg', 'zip'],
    category: 'public.app-category.utilities',
    icon: 'build/icon.icns',
    // identity: '-' 表示 ad-hoc 签名。
    //
    // 没有 Apple Developer 证书时，electron-builder 默认完全不签名；
    // 而 Apple Silicon 上的 Gatekeeper 会把「未签名」的 app 直接判为
    // 「已损坏，应移到废纸篓」。ad-hoc 签名不证明开发者身份，但让
    // 应用带有有效的代码签名结构，双击即可正常启动。
    //
    // 注意：ad-hoc 签名下**应用内自动安装不可用**。Squirrel.Mac 用
    // 已安装应用的 designated requirement 校验新包，ad-hoc 的该要求
    // 绑定当次构建的 cdhash，换版本必然不匹配。程序会在检查到新版本
    // 后改为提供安装包直链，详见 src/main/updatePolicy.ts。
    //
    // 配置了正式证书（CSC_LINK / CSC_KEY_PASSWORD）时，CI 会用证书
    // 签名，identity 会被实际证书覆盖，届时应用内更新自动启用。
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
