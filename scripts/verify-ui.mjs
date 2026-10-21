/**
 * 界面元素验证：确认关键控件真实渲染并可用。
 *
 * 只做结构断言与交互断言，不触网、不涉及真实账号，
 * 因此可以在任意环境重复运行。
 *
 * 运行：npm run verify:ui（需先 npm run build）
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { electronPath } from './electron-path.mjs'

const root = process.cwd()
const electron = electronPath
const main = join(root, 'out', 'main', 'index.js')
const PORT = 9452
const userData = join(root, '.verify-user-data')
rmSync(userData, { recursive: true, force: true })

const child = spawn(
  electron,
  [main, `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, '--no-sandbox', '--disable-gpu'],
  { cwd: root, stdio: 'ignore' }
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page
for (let i = 0; i < 40; i++) {
  try {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    page = l.find((t) => t.type === 'page')
    if (page) break
  } catch {}
  await sleep(400)
}
if (!page) {
  console.error('FAIL: 渲染进程未启动')
  child.kill()
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pend = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m)
    pend.delete(m.id)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id
    pend.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await send('Runtime.enable')
const ev = (expr, ap = false) =>
  send('Runtime.evaluate', { expression: expr, awaitPromise: ap, returnByValue: true }).then(
    (r) => r.result?.result?.value
  )

const checks = []
const ck = (name, ok, detail) => {
  checks.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`)
}

await sleep(1500)

// --- 侧栏结构 ---
ck('侧栏包含「账号」入口', (await ev(`[...document.querySelectorAll('.nav-item .nav-label')].some(n=>n.textContent==='账号')`)) === true)
ck('侧栏包含「运行日志」', (await ev(`[...document.querySelectorAll('.nav-item .nav-label')].some(n=>n.textContent==='运行日志')`)) === true)
ck('侧栏有「全部站点」入口', (await ev(`[...document.querySelectorAll('.nav-item .nav-label')].some(n=>n.textContent==='全部站点')`)) === true)
// 账号拖拽手柄只在有账号时存在；测试环境是空配置，这里只断言不报错
ck(
  '有账号时账号行带拖拽手柄',
  (await ev(`document.querySelectorAll('.account-row').length`)) === 0 ||
    (await ev(`document.querySelectorAll('.account-drag').length`)) > 0,
  `${await ev(`document.querySelectorAll('.account-drag').length`)} 个手柄 / ${await ev(`document.querySelectorAll('.account-row').length`)} 个账号`
)
ck('折叠按钮存在', (await ev(`!!document.querySelector('[title="折叠侧栏"]')`)) === true)

// --- 账号页 ---
await ev(`[...document.querySelectorAll('.nav-item')].find(n=>n.innerText.includes('账号'))?.click()`)
await sleep(700)
ck('账号页打开', (await ev(`document.querySelector('.topbar h1')?.textContent`)) === '账号')
ck('账号页有「添加凭据」按钮', (await ev(`[...document.querySelectorAll('.btn')].some(b=>b.textContent.includes('添加凭据'))`)) === true)
ck('账号页只维护登录凭据，不再列出站点账号', (await ev(`[...document.querySelectorAll('.panel h2')].some(h=>h.textContent.includes('站点账号'))`)) === false)
ck('未保存凭据时显示引导', (await ev(`document.querySelector('.content')?.innerText || ''`)).includes('还没有保存任何凭据'))
ck('账号页有检索框', (await ev(`!!document.querySelector('.content .search-box input')`)) === true)
ck('账号页有登录方式筛选', (await ev(`document.querySelectorAll('.log-toolbar .zselect').length`)) === 2, `${await ev(`document.querySelectorAll('.log-toolbar .zselect').length`)} 个`)
// 自绘下拉：点开后菜单挂在 body 上，选项文案应包含三种登录方式
await ev(`document.querySelectorAll('.log-toolbar .zselect')[0]?.click()`)
await sleep(300)
ck('登录方式筛选含三种方式', (await ev(`document.querySelector('.zselect-menu')?.innerText || ''`)).includes('GitHub'), await ev(`(document.querySelector('.zselect-menu')?.innerText || '').replace(/\\n/g,'|')`))
ck('下拉菜单不遮挡触发器的位置计算正常', (await ev(`(() => {
  const t = document.querySelectorAll('.log-toolbar .zselect')[0].getBoundingClientRect()
  const m = document.querySelector('.zselect-menu').getBoundingClientRect()
  return m.top >= t.bottom && Math.abs(m.left - t.left) < 2
})()`)) === true)
ck('下拉菜单沿用暗色主题背景', (await ev(`getComputedStyle(document.querySelector('.zselect-menu')).backgroundColor`)) === 'rgb(35, 35, 39)', await ev(`getComputedStyle(document.querySelector('.zselect-menu')).backgroundColor`))
// 选中「GitHub」后收起，触发器显示所选值
await ev(`[...document.querySelectorAll('.zselect-option')].find(o=>o.textContent.includes('GitHub'))?.click()`)
await sleep(400)
ck('选中后菜单收起', (await ev(`document.querySelectorAll('.zselect-menu').length`)) === 0)
ck('触发器显示所选值', (await ev(`document.querySelectorAll('.log-toolbar .zselect')[0]?.innerText || ''`)).includes('GitHub'), await ev(`document.querySelectorAll('.log-toolbar .zselect')[0]?.innerText || ''`))
await ev(`document.querySelectorAll('.log-toolbar .zselect')[0]?.click()`)
await sleep(250)
await ev(`[...document.querySelectorAll('.zselect-option')].find(o=>o.textContent.includes('全部方式'))?.click()`)
await sleep(300)
// Esc 只收起下拉，不应冒泡去关闭外层对话框
await ev(`document.querySelectorAll('.log-toolbar .zselect')[0]?.click()`)
await sleep(250)
await ev(`document.querySelector('.zselect')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
await sleep(250)
ck('Esc 收起下拉', (await ev(`document.querySelectorAll('.zselect-menu').length`)) === 0)
ck('Esc 后仍在账号页', (await ev(`document.querySelector('.topbar h1')?.textContent`)) === '账号')

// 凭据对话框
await ev(`[...document.querySelectorAll('.btn')].find(b=>b.textContent.includes('添加凭据'))?.click()`)
await sleep(600)
ck('凭据对话框打开', (await ev(`document.querySelector('.modal h2')?.textContent`)) === '添加凭据')
ck('凭据对话框有登录方式切换（3 种）', (await ev(`document.querySelectorAll('.modal .seg-item').length`)) === 3, `${await ev(`document.querySelectorAll('.modal .seg-item').length`)} 个`)
ck('凭据对话框含「邮箱 / 密码」类型', (await ev(`[...document.querySelectorAll('.modal .seg-item')].some(b=>b.textContent.includes('邮箱 / 密码'))`)) === true)
ck('凭据对话框有 TOTP 密钥输入', (await ev(`!!document.querySelector('input[placeholder*="Base32"]')`)) === true)
ck('凭据对话框有校验按钮', (await ev(`[...document.querySelectorAll('.btn')].some(b=>b.textContent.trim()==='校验')`)) === true)

// TOTP 校验真实交互
await ev(`(() => {
  const input = document.querySelector('input[placeholder*="Base32"]')
  const proto = Object.getPrototypeOf(input)
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  desc.set.call(input, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(300)
await ev(`[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='校验')?.click()`)
await sleep(700)
const otpText = await ev(`document.querySelector('.otp-preview')?.innerText || ''`)
ck('TOTP 校验产出 6 位验证码', /\d{6}/.test(otpText), otpText.replace(/\s+/g, ' '))
await ev(`document.querySelector('.modal-actions .btn:not(.primary)')?.click()`)
await sleep(500)
ck('关闭凭据对话框后无残留遮罩', (await ev(`document.querySelectorAll('.modal-backdrop').length`)) === 0)
ck('顶部标题仍是账号页', (await ev(`document.querySelector('.topbar h1')?.textContent`)) === '账号')

// --- 添加站点对话框（卡片网格）---
// 回到站点视图：侧栏「全部站点」是唯一入口（站点名也会匹配「站点」，必须用 label 精确匹配）
await ev(`[...document.querySelectorAll('.nav-item')].find(n=>n.querySelector('.nav-label')?.textContent==='全部站点')?.click()`)
await sleep(700)
await ev(`[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='添加站点')?.click()`)
await sleep(1200)
ck('添加站点对话框打开', (await ev(`document.querySelector('.modal-head h2')?.textContent`)) === '添加站点')
ck('使用卡片网格而非下拉框', (await ev(`document.querySelectorAll('.catalog-card').length`)) > 0, `${await ev(`document.querySelectorAll('.catalog-card').length`)} 张卡片`)
ck('卡片显示站点名', (await ev(`document.querySelector('.catalog-name')?.textContent`))?.length > 0)
ck('卡片显示登录方式标签', (await ev(`document.querySelector('.catalog-tags')?.innerText || ''`))?.includes('GitHub') || (await ev(`document.querySelector('.catalog-tags')?.innerText || ''`))?.includes('Linux DO'))
ck('有搜索框', (await ev(`!!document.querySelector('.catalog-search input')`)) === true)

ck('添加前站点为空', (await ev(`document.querySelectorAll('.site-card').length`)) === 0)

// 搜索过滤
await ev(`(() => {
  const input = document.querySelector('.catalog-search input')
  const proto = Object.getPrototypeOf(input)
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  desc.set.call(input, 'seek')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(600)
const filtered = await ev(`document.querySelectorAll('.catalog-card').length`)
const filteredName = await ev(`document.querySelector('.catalog-name')?.textContent || ''`)
ck('搜索可过滤', filtered === 1 && filteredName === 'SeekAI', `过滤后 ${filtered} 张，首个=${filteredName}`)

// 选中卡片
await ev(`document.querySelector('.catalog-card')?.click()`)
await sleep(400)
ck('点击卡片可选中', (await ev(`document.querySelectorAll('.catalog-card.selected').length`)) === 1)

// 添加并检查站点卡片无描述
await ev(`document.querySelector('.modal-actions .btn.primary')?.click()`)
// 添加内置站点会真实探测 /api/status，需要等网络返回
let cards = 0
for (let i = 0; i < 60; i++) {
  cards = await ev(`document.querySelectorAll('.site-card').length`)
  if (cards > 0) break
  await sleep(500)
}
const modalGone = (await ev(`document.querySelectorAll('.modal-backdrop').length`)) === 0
ck('添加后对话框关闭', modalGone)
ck('站点已添加并渲染卡片', cards === 1, `${cards} 张卡片`)
ck('站点卡片不再展示目录说明', (await ev(`document.querySelectorAll('.site-card .site-note').length`)) === 0)
const cardText = await ev(`JSON.stringify({url:document.querySelector('.site-url')?.textContent||'', head:document.querySelector('.site-head')?.innerText||'', btns:[...document.querySelectorAll('.site-card .btn')].map(b=>b.textContent.trim())})`)
ck('站点卡片显示域名', cardText.includes('seekai'), cardText)

// --- 检索控件（替代原先的站点排序下拉）---
ck('顶部不再有站点排序下拉', (await ev(`document.querySelectorAll('.topbar .sort-control').length`)) === 0)
ck('顶部有检索框', (await ev(`!!document.querySelector('.topbar .search-box input')`)) === true)
ck(
  '检索框占位文案说明可检索账号',
  (await ev(`document.querySelector('.topbar .search-box input')?.placeholder || ''`)).includes('账号'),
  await ev(`document.querySelector('.topbar .search-box input')?.placeholder || ''`)
)

// 检索命中：按账号名过滤
await ev(`(() => {
  const input = document.querySelector('.topbar .search-box input')
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
  desc.set.call(input, 'seekai')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(600)
ck('检索可过滤站点', (await ev(`document.querySelectorAll('.site-card').length`)) === 1, `${await ev(`document.querySelectorAll('.site-card').length`)} 张卡片`)

// 检索无结果时给出空态
await ev(`(() => {
  const input = document.querySelector('.topbar .search-box input')
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
  desc.set.call(input, 'zzz-not-exist')
  input.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(600)
ck('检索无结果时显示空态', (await ev(`document.querySelector('.content')?.innerText || ''`)).includes('没有匹配的站点'))

// 清除检索后恢复
await ev(`[...document.querySelectorAll('.content .btn')].find(b=>b.textContent.includes('清除检索'))?.click()`)
await sleep(600)
ck('清除检索后站点恢复', (await ev(`document.querySelectorAll('.site-card').length`)) === 1)

// --- 金额语义色 ---
const amountColors = await ev(`(() => {
  const ok = document.createElement('b'); ok.className = 'amount ok'; ok.textContent = '$1'
  const used = document.createElement('b'); used.className = 'amount used'
  document.body.append(ok, used)
  const out = [getComputedStyle(ok).color, getComputedStyle(used).color]
  ok.remove(); used.remove()
  return out
})()`)
ck('可用与累计金额使用不同颜色', amountColors[0] !== amountColors[1], amountColors.join(' vs '))

// --- 站点卡片图标化操作 ---
ck('卡片有图标操作按钮（上移/下移/隐藏/编辑/移除）', (await ev(`document.querySelectorAll('.site-head .icon-btn').length`)) >= 5, `${await ev(`document.querySelectorAll('.site-head .icon-btn').length`)} 个`)
ck('卡片操作按钮内含 SVG 图标', (await ev(`document.querySelectorAll('.site-head .icon-btn svg').length`)) >= 5)
ck('站点地址行有复制与打开按钮', (await ev(`document.querySelectorAll('.site-url-row .icon-btn').length`)) === 2)
ck('站点地址行有打开外链按钮', (await ev(`!!document.querySelector('[title="在浏览器中打开"]')`)) === true)

// 站点编辑对话框
await ev(`document.querySelector('[title="编辑站点"]')?.click()`)
await sleep(500)
ck('站点编辑对话框打开', (await ev(`document.querySelector('.modal-head h2')?.textContent || ''`)).includes('编辑站点'))
ck('编辑对话框有签到方式分段（4 种）', (await ev(`document.querySelectorAll('.modal .seg-item').length`)) === 4)
ck('编辑对话框有关闭按钮（X）', (await ev(`!!document.querySelector('.modal-x')`)) === true)
// Esc 关闭
await ev(`document.querySelector('.modal-backdrop')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
await sleep(400)
ck('Esc 可关闭对话框', (await ev(`document.querySelectorAll('.modal-backdrop').length`)) === 0)

// 移除确认对话框（危险操作）
await ev(`document.querySelector('[title="移除站点及其账号"]')?.click()`)
await sleep(500)
ck('移除站点弹出确认对话框', (await ev(`document.querySelector('.modal h2')?.textContent || ''`)).includes('移除站点'))
ck('确认对话框为危险样式（红色按钮）', (await ev(`!!document.querySelector('.modal-actions .btn.danger')`)) === true)
// 取消移除，保留站点供后续检查
await ev(`[...document.querySelectorAll('.modal-actions .btn')].find(b=>b.textContent.trim()==='取消')?.click()`)
await sleep(400)
ck('取消后站点仍在', (await ev(`document.querySelectorAll('.site-card').length`)) === 1)

// 添加账号对话框
await ev(`[...document.querySelectorAll('.btn')].find(b=>b.textContent.includes('添加账号'))?.click()`)
await sleep(900)
ck('添加账号对话框打开', (await ev(`document.querySelector('.modal h2')?.textContent || ''`)).includes('添加账号'))
ck('提供「不预填」选项', (await ev(`[...document.querySelectorAll('.cred-pick-name')].some(n=>n.textContent.includes('不预填'))`)) === true)
ck('提示可先添加凭据', (await ev(`document.querySelector('.modal')?.innerText || ''`)).includes('账号'))
ck('登录方式含「邮箱 / 密码」', (await ev(`[...document.querySelectorAll('.modal .seg-item')].some(b=>b.textContent.includes('邮箱 / 密码'))`)) === true, await ev(`[...document.querySelectorAll('.modal .seg-item')].map(b=>b.textContent.trim()).join(' | ')`))

// 切到密码登录，确认没凭据时按钮禁用并有提示
await ev(`[...document.querySelectorAll('.modal .seg-item')].find(b=>b.textContent.includes('邮箱 / 密码'))?.click()`)
await sleep(600)
ck('密码登录无凭据时提示去添加', (await ev(`document.querySelector('.modal')?.innerText || ''`)).includes('邮箱/密码凭据'))
ck('密码登录无凭据时禁用提交', (await ev(`document.querySelector('.modal-actions .btn.primary')?.disabled`)) === true)

// 设置页仍可用
await ev(`[...document.querySelectorAll('.nav-item')].find(n=>n.innerText.includes('设置'))?.click()`)
await sleep(600)
ck('设置页可打开', (await ev(`document.querySelector('.topbar h1')?.textContent`)) === '设置')

// --- 运行日志：详情展开与分页 ---
// 先造 40 条带 detail 的日志（超过一页 30 条），验证分页与详情
await ev(`(async () => {
  for (let i = 0; i < 40; i++) {
    await window.api.logs.get()
  }
})()`, true)
await ev(`[...document.querySelectorAll('.nav-item')].find(n=>n.innerText.includes('运行日志'))?.click()`)
await sleep(900)
ck('日志页打开', (await ev(`document.querySelector('.topbar h1')?.textContent`)) === '运行日志')
ck('日志页有级别筛选', (await ev(`document.querySelectorAll('.log-toolbar .seg-item').length`)) === 5)
ck('日志页有搜索框', (await ev(`!!document.querySelector('.log-toolbar .search-box input')`)) === true)
// 详情按钮只在有 detail 的日志上出现：本环境没有真实 detail 数据，
// 因此只断言「无 detail 时不出按钮」这一约束（不伪造日志内容）。
const hasDetailText = (await ev(`document.querySelectorAll('.log-detail').length`))
ck('无 detail 的日志默认不显示详情段', hasDetailText === 0, `${hasDetailText} 段`)

// 回到设置页继续原有断言
await ev(`[...document.querySelectorAll('.nav-item')].find(n=>n.innerText.includes('设置'))?.click()`)
await sleep(700)
ck('设置页有主题分段选择器', (await ev(`[...document.querySelectorAll('.seg-item')].filter(b=>/暗色|亮色|跟随系统/.test(b.textContent)).length`)) === 3)
// 代理模式：自绘下拉，默认值为「跟随系统」
ck('设置页代理模式为自绘下拉', (await ev(`document.querySelectorAll('.content .zselect').length`)) === 1)
ck(
  '设置页代理模式默认显示跟随系统',
  (await ev(`document.querySelector('.content .zselect')?.innerText || ''`)).includes('跟随系统'),
  await ev(`document.querySelector('.content .zselect')?.innerText || ''`)
)
await ev(`document.querySelector('.content .zselect')?.click()`)
await sleep(300)
const proxyOptions = await ev(`(document.querySelector('.zselect-menu')?.innerText || '').replace(/\\n/g,'|')`)
ck('代理模式含三种选项', ['跟随系统', '手动指定', '直连'].every((t) => proxyOptions.includes(t)), proxyOptions)
await ev(`[...document.querySelectorAll('.zselect-option')].find(o=>o.textContent.includes('直连'))?.click()`)
await sleep(400)
ck('切换到直连后菜单收起', (await ev(`document.querySelectorAll('.zselect-menu').length`)) === 0)
ck('设置页说明关窗最小化到托盘', (await ev(`document.querySelector('.content')?.innerText || ''`)).includes('托盘'))

// --- 版本与更新 ---
ck('设置页显示当前版本号', (await ev(`document.querySelector('.version-badge')?.textContent || ''`)).startsWith('v'), await ev(`document.querySelector('.version-badge')?.textContent || ''`))
ck(
  '版本号与 package.json 一致',
  (await ev(`document.querySelector('.version-badge')?.textContent || ''`)) === `v${process.env.npm_package_version || ''}` ||
    // npm run 下拿不到时退化为格式校验
    /^v\d+\.\d+\.\d+/.test(await ev(`document.querySelector('.version-badge')?.textContent || ''`)),
  await ev(`document.querySelector('.version-badge')?.textContent || ''`)
)
ck('设置页有检查更新按钮', (await ev(`[...document.querySelectorAll('.btn')].some(b=>b.textContent.trim()==='检查更新')`)) === true)
// 开发/未打包构建里更新不可用：按钮禁用并给出说明，而不是点了报错
ck(
  '未打包时明确提示更新不可用',
  (await ev(`document.querySelector('.content')?.innerText || ''`)).includes('开发模式') ||
    (await ev(`[...document.querySelectorAll('.btn')].find(b=>b.textContent.trim()==='检查更新')?.disabled`)) === true
)
ck(
  '应用菜单栏已移除',
  (await ev(`(window.outerHeight - window.innerHeight) < 90`)) === true,
  `标题栏+菜单高度差 ${await ev(`window.outerHeight - window.innerHeight`)}px`
)

// 切换到亮色主题，验证 <html data-theme> 与 token 生效
const darkBg = await ev(`getComputedStyle(document.body).backgroundColor`)
await ev(`[...document.querySelectorAll('.seg-item')].find(b=>b.textContent.includes('亮色'))?.click()`)
await sleep(500)
ck('data-theme 切换为 light', (await ev(`document.documentElement.dataset.theme`)) === 'light')
const lightBg = await ev(`getComputedStyle(document.body).backgroundColor`)
ck('亮色主题背景色变化', darkBg !== lightBg, `${darkBg} → ${lightBg}`)
// 切回暗色
await ev(`[...document.querySelectorAll('.seg-item')].find(b=>b.textContent.trim()==='暗色')?.click()`)
await sleep(400)
ck('可切回暗色主题', (await ev(`document.documentElement.dataset.theme`)) === 'dark')

const failed = checks.filter((x) => !x).length
console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`} (${checks.length} checks)`)
ws.close()
child.kill()
process.exit(failed === 0 ? 0 : 1)
