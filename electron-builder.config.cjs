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
    // 同时产出 Apple Silicon 与 Intel 两版：GitHub 的 arm64 runner 默认只出 arm64，
    // 显式声明后 Intel Mac 用户也能安装
    artifactName: '${productName}-${version}-${arch}-mac.${ext}'
  },
  linux: {
    target: ['AppImage'],
    category: 'Utility',
    icon: 'build/icon.png',
    artifactName: '${productName}-${version}-${arch}-linux.${ext}'
  }
}
