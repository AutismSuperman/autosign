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
    icon: 'build/icon.ico'
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
    icon: 'build/icon.icns'
  },
  linux: {
    target: ['AppImage'],
    category: 'Utility',
    icon: 'build/icon.png'
  }
}
