# 实现规划

本文档记录 AutoSign Desktop 的实现状态、技术决策与后续阶段安排。

## 一、已完成的工程骨架

### 架构

```
渲染进程 (React)  ──IPC──▶  主进程 (Node)  ──HTTP/TLS──▶  各站点
      │                        │
      │ contextBridge          ├── 凭据加密 (safeStorage)
      │ 窄接口，无 Node 能力     ├── WAF 求解 (acw_sc__v2)
      │                        ├── 代理 (system / manual / direct)
      └── 纯展示与交互           └── 配置与日志持久化
```

**关键约束**：渲染进程永远不直接发网络请求、不接触明文凭据。所有站点访问在主进程完成，
凭据只在主进程内存与加密文件之间流动。这条边界保证了即使渲染进程被注入脚本，
也拿不到会话 Cookie。

### 已实现的模块

| 模块 | 文件 | 职责 |
|---|---|---|
| 类型与契约 | `src/shared/types.ts`、`ipc.ts` | 跨进程数据结构与 IPC 清单 |
| 站点目录 | `src/shared/catalog.ts` | 6 个内置站点及其签到方式 |
| 加密 | `src/main/security.ts` | DPAPI / Keychain / libsecret 封装，拒绝明文降级 |
| 持久化 | `src/main/store.ts` | 配置与日志，串行写队列避免并发覆盖 |
| HTTP | `src/main/net/httpClient.ts` | 原生 http/https 请求，支持 http/socks5 代理 |
| WAF | `src/main/net/waf.ts` | 阿里云 ESA 质询解析与求解 |
| 代理 | `src/main/net/proxy.ts` | 系统代理发现（注册表 / scutil / env） |
| 协议表 | `src/main/sites/profile.ts` | 端点、字段、签到模式的数据化定义 |
| 探测 | `src/main/sites/probe.ts` | 读 `/api/status` 识别站点能力 |
| 引擎 | `src/main/sites/engine.ts` | 读额度、读签到状态、执行签到 |
| OAuth | `src/main/sites/oauth.ts` | 授权窗口、同分区取 state、state 校验、身份锚点、会话上限 |
| Turnstile | `src/main/sites/turnstile.ts` | 隐藏窗口取令牌，供签到使用 |
| 会话自愈 | `src/main/sites/session.ts` | 续期、并发合并、抖动重试、会话上限 |
| 重登签到 | `src/main/sites/relogin.ts` | 登出→重登→余额增量核对 |
| 登出 | `src/main/sites/logout.ts` | 登出前续期、分级结果 |
| 主进程 | `src/main/index.ts` | IPC 注册、窗口、后台调度 |
| 界面 | `src/renderer/src/**` | 侧栏、站点卡片、设置、日志 |
| 测试 | `tests/*.test.mjs` | 自愈与重登判据的分支测试 |

### 验证证据

| 验证项 | 结果 |
|---|---|
| TypeScript 类型检查（主进程 + 渲染进程） | 通过，0 错误 |
| 生产构建 `electron-vite build` | 通过，三个 bundle 均生成 |
| 冒烟测试：窗口创建、`.shell` 渲染、`window.api` 桥接、IPC 往返 | 通过 |
| 端到端：真实网络探测 `seekai.cc` | 通过，识别为 `NEWAPI` / `BUTTON` / Turnstile 开启 |
| 端到端：添加站点 → 加密落盘 → 重启后读回 → 界面渲染卡片 | 通过 |
| 端到端：侧栏折叠 / 展开往返 | 通过 |
| **端到端：隐藏窗口取真实 Turnstile 令牌** | 通过，7.2 秒取得 794 字符令牌 |
| **会话自愈单元测试（`npm test`）** | 14 项检查全部通过 |
| **重登判据单元测试（`npm test`）** | 9 项检查全部通过 |
| **界面元素验证（`npm run verify:ui`）** | 10 项检查全部通过 |
| **站点排序端到端** | 通过，配置顺序与界面卡片顺序同步变化 |

会话自愈测试覆盖的分支：

| 分支 | 断言 |
|---|---|
| 401 → 续期 → 重试 | 返回 200，token 已更新，refresh 被调用 1 次 |
| 并发两个 401 | 续期只发生 1 次（避免重复消费 refresh cookie） |
| 轮换后的 cookie | 已回写，不会用旧值续期 |
| 409 AUTH_SESSION_LIMIT | 立即返回，不续期、不重试 |
| 503 瞬时抖动 | 幂等 GET 重试后成功 |
| POST 签到 | 只发 1 次，绝不重放 |

重登判据测试覆盖的分支：

| 余额变化 | 判定 |
|---|---|
| +$25、+$175 | 到账，写入回执 |
| 恰好 +$15 | 到账（阈值含等号） |
| +$10 | 未到账，提示可能已领 |
| ±$0、-$5 | 未到账，绝不误判 |
| 余额不可读 / 单边缺失 | 未到账，不假装成功 |
| 浮点余额（100.1 → 115.1） | 正确识别为 $15 |

## 二、关键技术决策

### 1. 为什么用 Electron 而不是 Tauri

决定性因素是**后台无交互通过 Turnstile**。本机实测结果：

| 环境 | 能否无交互拿到真实 Turnstile token |
|---|---|
| 桌面 Chrome 无头模式 | ❌ 挂件渲染但不出 token |
| 桌面 Chrome 有界面模式 | ✅ 通过 |
| Electron 隐藏窗口（`show: false`） | ✅ 通过 |
| Electron 离屏渲染（`offscreen: true`） | ✅ 通过 |

Tauri 使用系统 WebView2，多账号分区隔离与后台渲染的可靠性不如 Electron 自带的
Chromium 实例。包体大是已知代价，换来的是「后台签到」这个核心功能成立。

### 2. 为什么用原生 http/https 而不是 fetch

目标站点普遍启用阿里云 ESA 质询（`acw_sc__v2`）。该质询需要：
拿到质询页 → 本地求解 → 带 Cookie 重发。

Node 的 `fetch`（undici）不暴露底层 socket 与完整响应头控制，而 `http`/`https` 模块
允许完全控制请求头、Cookie 与代理 agent。代价是要自己实现重定向与超时，
这部分已在 `httpClient.ts` 内收敛。

### 3. 为什么签到分四种模式

站点的签到机制本身不同，不是实现选择：

| 模式 | 含义 | 代表站点 |
|---|---|---|
| `BUTTON` | 有 `POST /api/user/checkin`，点按钮领取 | SeekAI、KKtoken、JustDoWork |
| `RELOGIN` | 无签到端点，当日额度由登录动作发放 | AgentRouter、AnyRouter |
| `LOGIN_GRANT` | 登录即得，只需核验当日回执 | GoRouter |
| `WEB_ONLY` | 只能网页人工处理 | 自定义站点兜底 |

把模式写成数据而不是代码分支，加站点时只改 `catalog.ts` 一行，
引擎与界面都不动。硬把 `RELOGIN` 站当 `BUTTON` 站发 POST 会得到 404，
这正是上游修复过的真实缺陷。

### 4. 奖励周期的日界是北京时间 08:00

多家站点的额度发放以北京时间 08:00 为日界，恰好等于 UTC 零点。
因此 `rewardDate()` 按 UTC 日界切分，而不是本地日历日。
在 08:00 之前不把一次请求记成当天领取，避免跨周期误跳过。

## 三、后续阶段

### 阶段 1：账号授权链路（已完成主体）

- [x] **state 与兑换同分区**：旧版 New API 把 state 存在服务端 session，
      必须在同一 Cookie 分区取 state 与交换，否则判「state 无效」
- [x] **state 端点 GET/POST 回退**：AgentRouter 型只认 GET，逐个尝试
- [x] **会话数上限处理**：`409 AUTH_SESSION_LIMIT` 立即停止并给出可操作提示
- [x] **身份锚点校验**：交换响应带数字 id 时与期望值比对，不一致即拒绝（防串号）
- [x] **授权窗口走代理**：分区代理与业务一致，否则页面上不去
- [ ] **多身份支持**：同一凭据可分别以 GitHub / Linux DO 登录同一站点
- [ ] **授权窗口进度提示**：当前只在 ready-to-show 后显示，缺「正在等待授权」文案

### 阶段 2：会话自愈（已完成）

- [x] **短期 Token 续期**：`POST /api/user/auth/refresh`，不重新 OAuth
- [x] **Cookie 轮换原子保存**：续期会轮换 refresh cookie，取不到 token 时也保存新 cookie
- [x] **401 强制续期**：服务端拒绝的 token 不论 JWT 是否过期都要换
- [x] **并发续期合并**：同一账号在同一时刻只续期一次，复用结果
- [x] **401/403/503 分级**：会话死亡 vs 瞬时抖动分开处理
- [x] **幂等重试约束**：只有 GET 做抖动重试；POST 签到永不重放
- [x] **登出前续期**：带过期 token 调 logout 会被判 401，看起来像已登出而会话仍活着
- [ ] **静默重授权**：Linux DO 站会话彻底失效时，用论坛会话在隐藏窗口重建

### 阶段 2.5：重登类站点自动签到（已完成）

AgentRouter / AnyRouter 没有签到端点，当日额度由**登录动作**发放。

- [x] **登出 → 重登**：真实服务端注销后再用隐藏窗口完成登录
- [x] **余额增量判据**：只认余额增量 ≥ $15；`sign_in` 响应不作依据
- [x] **不保活**：这类站点签到前**不得**续期会话，否则永远登不出去、领不到奖
- [x] **读不到余额则报失败**：不假装成功
- [x] **失败给出可操作提示**：说明可能今日已领或正在消耗
- [ ] **可见兜底**：分区内会话彻底失效时弹出授权窗口（当前返回「需要重新登录」）

### 阶段 3：Turnstile 签到（已完成主体）

- [x] **隐藏窗口取令牌**：`show: false` 的 BrowserWindow 加载站点页面，
      注入站点自己的挂件，等 `interaction-only` 无感通过
- [x] **协议对齐**：New API 把 token 放 query（`?turnstile=`），福利站走 `X-Turnstile-Token` 头
- [x] **按需取令牌**：只有明确被要求验证（消息含 turnstile/验证 或 403）才开隐藏窗口
- [x] **失败回查状态**：验证未过时回查一次签到记录，登录即发放的站可能其实已到账
- [x] **分区复用**：同一「站点 × 账号」固定分区，WAF 放行 Cookie 可复用
- [x] **不覆盖 UA**：实测自定义 UA 会让 Turnstile 永远不出令牌
- [ ] **可见兜底**：无感验证失败且确实需要人工交互时，弹出可见窗口让用户点一下

### 阶段 4：体验与系统集成

- [x] **单实例锁**：`app.requestSingleInstanceLock`，第二个实例拉起已有窗口后退出，
      避免双开互相覆盖配置
- [x] **系统通知**：定时签到结束后用系统通知报告成功/未成功数量（关窗也能收到）
- [x] **站点排序**：支持拖拽与上/下移按钮，顺序持久化
- [x] **配置变更广播**：主进程写配置后自动通知窗口刷新，后台任务改动状态不会失同步
- [x] **批量操作**：刷新全部额度 / 全部签到
- [ ] **系统托盘**：最小化到托盘、托盘菜单快捷签到
- [ ] **开机自启**：`app.setLoginItemSettings`
- [ ] **额度趋势图**：记录每日额度快照，展示变化曲线

### 阶段 5：打包与分发

- [ ] **图标与品牌资源**：`build/icon.ico`、`icon.icns`、`icon.png`
- [ ] **自动更新**：`electron-updater` + GitHub Releases
- [ ] **代码签名**：Windows Authenticode、macOS notarization
- [ ] **CI**：三平台构建矩阵（GitHub Actions）

## 四、已知限制

1. **直连可能不通**：部分网络环境下目标站点连接被重置，必须配置代理。
   设置页的「测试连通」会如实报告失败原因。
2. **重登站点依赖分区会话**：AgentRouter / AnyRouter 的重登使用账号分区里已有的
   长期会话。若该会话已彻底失效，会如实返回「需要重新登录」而不是假装签到成功。
3. **无人交互的 Turnstile 可能失败**：`interaction-only` 在大多数情况下能静默通过，
   但站点风控收紧时仍可能要求点击。当前如实报错，尚未提供可见兜底窗口。
4. **无自动更新**：当前需手动替换安装包。
5. **代理认证未支持**：`http://user:pass@host:port` 形式的代理尚未验证。
6. **Linux 加密后端**：依赖 libsecret，缺失时按设计拒绝保存凭据（不会明文降级）。
7. **重登阈值是经验值**：$15 取自上游实测（签到 $25 但可能同时消耗）。
   站点改奖励额度后需要调整 `MIN_CREDIT_USD`。

## 五、给后续开发者的提示

- **站点会变**：接口、字段、风控随时调整。`probe.ts` 是发现变化的入口，
  加站点前先跑一次探测，不要靠猜。
- **不要伪造成功**：拿不到到账证据就报失败。上游为此专门写了「余额增量」判据，
  比任何 `success: true` 都可靠。
- **不要把凭据传出主进程**：渲染进程拿到的永远只是额度数字与状态字符串。
- **新增站点只改 `catalog.ts`**：如果发现需要改引擎，先确认是不是协议形态没建模对。
