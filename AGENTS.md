# AGENTS.md

本文件规定 AutoSign 桌面端的版本号规则与仓库保密要求。任何自动化代理、
协作者在提交代码或发版前都必须遵守。

---

## 一、版本号规则

### 1.1 唯一来源

- **应用版本号只有一个来源：`package.json` 的 `version` 字段。**
- 禁止在其他文件（README、源码常量、界面文案）里重复写死版本号。
  需要展示时从 `package.json` 读取。
- `package-lock.json` 里的 `version` 由 npm 自动维护，跟随 `package.json`，
  **不要手工修改**。改版本请用 `npm version`。

### 1.2 语义化版本（SemVer）

格式 `MAJOR.MINOR.PATCH`，含义按用户可感知的变更判断：

| 位 | 何时递增 | 本项目示例 |
|---|---|---|
| MAJOR | 不兼容的变更：配置格式无法自动迁移、破坏既有账号数据 | 几乎不发生，需先写迁移 |
| MINOR | 向下兼容的新功能 | 新增排序、API Key 展示、站点 logo |
| PATCH | 向下兼容的问题修复 | 修复跨天状态、WAF 识别、弹窗关不掉 |

判定原则：

- **只有 bugfix、内部重构、文档、依赖升级 → PATCH**
- **含用户可见的新能力 → MINOR**
- 同一个发布里既修 bug 又加功能 → 取 MINOR
- 修复中包含「行为语义变化」（例如跨天改为显示未签）仍算 PATCH；
  但如果改的是用户必须重新配置才能正常用的东西，视为 MAJOR

### 1.3 预发布标识

正式发布前若需试发，使用 SemVer 预发布后缀，**不带前缀 `v`**：

```
0.2.0-beta.1
0.2.0-rc.1
```

规则：

- `beta` 用于功能未定型，`rc` 用于只等验证
- 预发布版本不进 `latest`，发布说明里要写清楚
- 正式版发布时去掉后缀，**不重编内容**（同一份构建）

### 1.4 发版操作

```bash
npm version patch -m "chore: 发布 v%s"   # 或用 minor / major
git push --follow-tags
npm run dist                            # 生成安装包
```

`npm version` 会自动：改 `package.json`、同步 `package-lock.json`、
提交、打 `v0.2.0` 形式的 tag。**不要手改版本号后单独提交。**

### 1.5 Git tag

- 格式：`v<version>`，例如 `v0.2.0`
- **tag 必须指向通过完整验证的提交**
- 打 tag 前必须确认：`npm run typecheck`、`npm test`、`npm run verify:ui` 全部通过
- 已推送的 tag 不得删除重打；发错了就递增一个 patch 再发

### 1.6 什么算一次发版

只有**用户可感知的行为或产物发生变化**才发版。以下情况不发版：

- 纯文档、注释、格式调整
- 开发期临时脚本（`scripts/shot-ui.mjs`、`.tmp/` 下内容）
- 测试用例补充（除非同时改了被测行为）
- 依赖小版本升级且无行为变化

### 1.7 发布说明

每个正式版本必须有可读的发布说明，至少包含：

1. 版本号与发布日期
2. 用用户语言写的变更点（不写内部实现细节）
3. 需要用户手动操作的项（例如「需要重新授权」）
4. 已知问题

禁止出现「优化体验」「修复若干问题」这类无法验证的表述。

---

## 二、账号与凭据保密要求

AutoSign 处理的是真实站点的登录会话与密码。**仓库中任何位置都不得出现
真实账号信息**，包括代码、注释、测试、文档、提交信息、issue、截图。

### 2.1 绝对禁止入库的内容

| 类别 | 示例 |
|---|---|
| 账号标识 | 真实邮箱、用户名、站点数字用户 ID |
| 会话凭据 | Cookie、`session`、`access_token`、refresh token |
| 长期密钥 | TOTP 密钥、应用密码、个人访问令牌（`ghp_`、`github_pat_`） |
| 站点密钥 | 真实 API Key（`sk-...`）、站点分发的用户 token |
| 用户数据目录 | 任何 Electron `userData` 目录（含 `config.json`、`logs.json`、`Cookies`、`Local Storage`） |
| 本地环境信息 | 含用户名的绝对路径、本机代理地址、内网 IP |

### 2.2 新增文件前的自检

提交前必须确认：

```bash
git status --short          # 没有意外的新增目录
git diff --cached --stat    # 只包含预期的文件
```

以下目录**永不提交**（`.gitignore` 已覆盖，不要用 `-f` 绕过）：

- `.*-user-data/`、`.*-data/`：测试与截图用的 Electron 数据目录
- `.tmp/`、`.shot-*/`、`.zcode/`
- `out/`、`dist/`、`node_modules/`

### 2.3 代码中的写法

示例数据必须明显是假的，并优先使用文档保留域名：

```ts
// 正确
const demo = { label: 'demo-user', email: 'demo@example.com' }
// 错误：真实邮箱或真实站点用户名
```

- 测试里需要账号时用 `example.com`、`test-user`、`user_123`
- 日志与错误信息**永不打印** cookie / token / 密码原值，
  只允许打印布尔、长度、指纹（如 SHA-256 前 8 位）
- 截图用于文档时，先确认界面里没有真实账号、邮箱、额度

### 2.4 提交信息

- 提交信息里不写账号、邮箱、站点凭据
- 不粘贴完整的接口响应（可能含 token）
- 描述问题用「某账号」「某站点」，必要时用站点域名但不要带账号

### 2.5 发现泄露时的处理

如果误提交了敏感内容：

1. **立即停止推送**，先处理再推
2. 若尚未推送：`git reset` 掉该提交，改好重新提交
3. 若已推送：重写历史（`git filter-repo` 或重建单提交），
   并**到对应站点撤销该凭据**——一旦离开本机就应视为已泄露
4. 撤销凭据优先于清理历史：历史可能已被缓存或索引

### 2.6 加密与落盘

- 会话 Cookie、令牌、密码、TOTP 密钥必须经操作系统密钥加密后落盘
- 加密不可用时**拒绝写入**，不得降级为明文
- 凭据只在主进程内存中短暂存在，渲染进程永远拿不到原文

---

## 三、自动化约束（已落地）

约定只有配了执行手段才算数。仓库中已内置：

### 3.1 敏感信息扫描

```bash
npm run check:secrets      # 扫描暂存区
node scripts/check-secrets.mjs --all          # 扫描全部跟踪文件
node scripts/check-secrets.mjs --tree <rev>   # 扫描某个提交
```

检测项：真实邮箱、API Key、GitHub 令牌、JWT、AWS Key、
含用户名的绝对路径，以及不应被跟踪的用户数据目录。

### 3.2 提交前拦截

仓库自带 `.githooks/pre-commit`，启用一次即可长期生效：

```bash
git config core.hooksPath .githooks
```

启用后每次 `git commit` 都会先跑敏感信息扫描，命中即拒绝提交。
**不要用 `--no-verify` 绕过**；确认是误报时，应修改写法
（换成 `example.com` 等示例值），而不是绕过检查。

### 3.3 发版前总检查

```bash
npm run release:check
```

等价于 `check:secrets` + `typecheck` + `test` + `verify:ui`。
打 tag 前必须跑通。

---

## 四、提交前的最低验证

任何改动在提交前至少跑通：

```bash
npm run typecheck   # 主进程 + 渲染进程
npm test            # 单元断言
npm run build       # 生产构建
```

涉及界面改动时追加：

```bash
npm run verify:ui   # 关键控件渲染与交互
```

涉及签到、会话、额度、OAuth 的改动，必须额外说明**如何验证**，
并在提交信息里写清验证结果，而不是只写「已修复」。

---

## 五、发布检查清单

发版前逐项确认：

- [ ] `package.json` 的 `version` 已按 SemVer 更新
- [ ] 变更内容与版本号级别匹配（新功能不能只发 PATCH）
- [ ] `npm run release:check` 全通过
- [ ] `git status` 干净，没有用户数据目录被跟踪
- [ ] 发布说明已写，含需要用户手动操作的项
- [ ] 三平台图标齐全：`build/icon.ico`、`build/icon.icns`、`build/icon.png`
- [ ] tag 格式为 `v<version>`，指向验证过的提交
