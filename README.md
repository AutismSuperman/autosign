# AutoSign Desktop

桌面端公益 AI 中转站自动签到与额度管理，Electron + React + TypeScript。

> 本项目是 [AI-modelsAPI/autosign](https://github.com/AI-modelsAPI/autosign)（Android，AGPL-3.0-or-later）
> 的桌面重实现，沿用其站点协议与安全策略，界面与运行时完全重写。
> 原项目只维护 Android 端，本项目面向 Windows / macOS / Linux。

## 当前状态

工程骨架已跑通：主进程、预加载桥接、渲染界面、站点探测、额度读取、签到调度、日志与设置均已实现，
并通过类型检查、生产构建与端到端验证。详细进度与后续计划见 [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md)。

## 功能

- **左侧站点菜单**：站点列表常驻，可整栏折叠为图标条，也可把单个站点隐藏后恢复。
- **多站点多账号**：每个「站点 × 账号」使用独立持久化分区，Cookie 互不串号。
- **额度看板**：可用额度、累计消耗、今日签到状态与奖励，支持一键刷新全部。
- **签到**：按站点能力自动选择按钮签到 / 重登领取 / 登录即得，不伪造成功。
- **Turnstile**：隐藏窗口复用站点自身挂件完成无感人机验证，不破解、不代答。
- **会话自愈**：短期令牌过期用 refresh cookie 续期；并发续期合并；409 会话上限立即停止。
- **后台定时**：主进程内调度，关闭窗口后仍按时执行，结束后发系统通知。
- **代理**：支持跟随系统（注册表 / scutil / 环境变量）、手动 http/socks5、直连。
- **凭据加密**：会话 Cookie 与令牌经系统密钥（DPAPI / Keychain / libsecret）加密，不可用时拒绝明文落盘。

## 快速开始

```bash
npm install
npm run dev        # 开发模式
npm run typecheck  # 类型检查
npm run build      # 生产构建
npm run test       # 自愈与重登判据测试（23 项断言）
npm run smoke      # 冒烟测试（需先 build）
npm run verify:ui  # 界面元素验证（需先 build）
npm run dist       # 打安装包
```

要求 Node.js ≥ 22.12（Electron 44 的运行要求）。

## 目录结构

```
src/
  main/                 主进程：唯一拥有网络与凭据访问权
    net/                HTTP 客户端、WAF 求解、代理解析
    sites/              站点协议表、能力探测、业务引擎、OAuth
    security.ts         系统密钥加密
    store.ts            配置与日志持久化
    index.ts            IPC 注册、窗口、后台调度
  preload/              contextBridge 窄接口
  renderer/             React 界面
  shared/               跨进程类型、IPC 契约、站点目录
scripts/smoke.mjs       启动与 IPC 往返冒烟测试
```

## 安全约束

- 渲染进程不直接发网络请求、不接触明文凭据，所有访问在主进程完成。
- OAuth 回调必须 `state` 严格匹配，不匹配即拒绝，防串流与 CSRF。
- 日志不记录 OAuth code、state、token、cookie、密码原值。
- 加密不可用时拒绝写入凭据，不降级为明文。
- 不提供批量注册、验证码绕过、账号共享或未授权访问。

## 使用边界

使用者须遵守所在地法律、GitHub 条款及各站点服务条款，只操作本人所有或已获授权的账号。
站点可能随时调整接口、风控与奖励政策，本软件不对站点可用性作任何保证。
本项目与 GitHub、Cloudflare 及各内置站点无隶属或担保关系。

## 许可证

AGPL-3.0-or-later。分发或通过网络提供修改版本时，须履行该许可证要求的版权声明、
许可证与对应源代码义务。
