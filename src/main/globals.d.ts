/**
 * 构建时注入的常量。
 *
 * 由 electron.vite.config.ts 的 `define` 从 package.json 读入，
 * 这样版本号仍然只有一个来源，开发模式下也不会取到 Electron 自身的版本。
 */
declare const __APP_VERSION__: string
