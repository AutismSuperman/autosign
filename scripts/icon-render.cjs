/**
 * 图标光栅化渲染进程（仅由 scripts/make-icon.mjs 调起）。
 *
 * 用 Chromium 把 .tmp/icon-gen 下的 SVG 按目标尺寸画进 canvas，
 * 回传 PNG dataURL 与原始 RGBA（ICO 的 BMP 档需要未压缩像素）。
 * 矢量源按目标分辨率直接渲染，边缘质量优于「大图缩小」。
 */
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')
const { join } = require('path')

const gen = join(__dirname, '..', '.tmp', 'icon-gen')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1100, height: 700 })
  await win.loadFile(join(gen, 'render.html'))
  const result = await win.webContents.executeJavaScript('runJob(window.__JOB)')
  writeFileSync(join(gen, 'result.json'), result)
  app.exit(0)
})
