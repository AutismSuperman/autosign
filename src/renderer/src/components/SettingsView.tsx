import { useEffect, useState } from 'react'
import {
  Activity,
  CalendarClock,
  Clock,
  Eye,
  EyeOff,
  HardDriveDownload,
  Minimize2,
  Monitor,
  Moon,
  Network,
  Palette,
  PanelLeft,
  RefreshCw,
  RotateCw,
  Settings2,
  ShieldCheck,
  Sun
} from 'lucide-react'
import type { AppInfo, UpdateStatus } from '@shared/ipc'
import type { ProxyProbeResult, Settings, ThemeMode } from '@shared/types'
import { Select } from './Select'
import type { SelectOption } from './Select'
import { Seg } from './Seg'
import type { ToastKind } from './Toast'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => Promise<void>
  onToast: (message: string, kind?: ToastKind) => void
}

type ProxyMode = Settings['proxy']['mode']

const PROXY_MODES: ReadonlyArray<SelectOption<ProxyMode>> = [
  { value: 'system', label: '跟随系统' },
  { value: 'manual', label: '手动指定' },
  { value: 'direct', label: '直连（不使用代理）' }
]

const THEME_OPTIONS: Array<{ key: ThemeMode; label: string; icon: typeof Moon }> = [
  { key: 'dark', label: '暗色', icon: Moon },
  { key: 'light', label: '亮色', icon: Sun },
  { key: 'system', label: '跟随系统', icon: Monitor }
]

/** 设置页：代理、定时签到、界面、安全与版本。 */
export function SettingsView(props: Props): React.JSX.Element {
  const { settings } = props
  const [proxyUrl, setProxyUrl] = useState(settings.proxy.url)
  const [probe, setProbe] = useState<ProxyProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [secure, setSecure] = useState<{ encryptionAvailable: boolean; platform: string } | null>(
    null
  )
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [update, setUpdate] = useState<UpdateStatus>({ state: 'idle' })

  useEffect(() => {
    void window.api.app.secureInfo().then(setSecure)
    void window.api.app.info().then(setInfo)
    void window.api.update.current().then(setUpdate)
    return window.api.update.onChange(setUpdate)
  }, [])

  const runProbe = async (): Promise<void> => {
    setProbing(true)
    try {
      const r = await window.api.proxy.probe({
        mode: settings.proxy.mode,
        url: proxyUrl
      })
      setProbe(r)
      props.onToast(
        r.ok ? `代理可用（来源 ${r.source}）` : `代理不可用：${r.error ?? '未知'}`,
        r.ok ? 'success' : 'error'
      )
    } finally {
      setProbing(false)
    }
  }

  return (
    <>
      <div className="topbar">
        <span className="topbar-icon">
          <Settings2 size={16} />
        </span>
        <h1>设置</h1>
        <span className="sub">代理、定时签到与界面</span>
      </div>

      <div className="content">
        <div className="panel settings-panel">
          <h2>
            <Network size={16} />
            网络代理
          </h2>
          <div className="field">
            <span className="field-icon">
              <Network size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">代理模式</div>
              <span className="field-hint">
                部分网络环境下目标站点直连会被重置，此时需要代理。跟随系统会读取 Windows
                注册表 / macOS scutil / 环境变量。
              </span>
            </div>
            <div className="field-body">
              <Select
                value={settings.proxy.mode}
                options={PROXY_MODES}
                onChange={(mode) =>
                  void props.onChange({
                    proxy: { ...settings.proxy, mode }
                  })
                }
                ariaLabel="代理模式"
                minWidth={180}
              />
            </div>
          </div>

          {settings.proxy.mode === 'manual' && (
            <div className="field">
              <span className="field-icon">
                <Network size={16} />
              </span>
              <div className="field-text">
                <div className="field-label">代理地址</div>
                <span className="field-hint">支持 http:// 与 socks5:// 两种协议；留空等同直连。</span>
              </div>
              <div className="field-body">
                <input
                  className="input-wide"
                  placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080"
                  value={proxyUrl}
                  onChange={(e) => setProxyUrl(e.target.value)}
                  onBlur={() =>
                    void props.onChange({ proxy: { ...settings.proxy, url: proxyUrl.trim() } })
                  }
                />
                <button className="btn small" onClick={() => void runProbe()} disabled={probing}>
                  <Activity size={13} />
                  {probing ? '探测中…' : '测试连通'}
                </button>
              </div>
            </div>
          )}

          {settings.proxy.mode !== 'manual' && (
            <div className="field">
              <span className="field-icon">
                <Activity size={16} />
              </span>
              <div className="field-text">
                <div className="field-label">连通性</div>
              </div>
              <div className="field-body">
                <button className="btn small" onClick={() => void runProbe()} disabled={probing}>
                  <Activity size={13} />
                  {probing ? '探测中…' : '测试连通'}
                </button>
                {probe && (
                  <span className={probe.ok ? 'tag ok' : 'tag err'}>
                    {probe.ok
                      ? `可用 · ${probe.source}${probe.proxy ? ` · ${probe.proxy}` : ''}`
                      : `失败 · ${probe.error ?? '未知'}`}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="panel settings-panel">
          <h2>
            <CalendarClock size={16} />
            定时签到
          </h2>
          <div className="field">
            <span className="field-icon">
              <CalendarClock size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">自动签到</div>
              <span className="field-hint">启用后由主进程在后台执行，不依赖窗口是否打开。</span>
            </div>
            <div className="field-body">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={settings.schedule.enabled}
                  onChange={(e) =>
                    void props.onChange({
                      schedule: { ...settings.schedule, enabled: e.target.checked }
                    })
                  }
                />
                启用
              </label>
            </div>
          </div>
          <div className="field">
            <span className="field-icon">
              <Clock size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">执行时间</div>
              <span className="field-hint">
                建议设为 08:05 之后：多数站点的奖励周期在北京时间 08:00 切换。
              </span>
            </div>
            <div className="field-body">
              <input
                type="time"
                value={settings.schedule.time}
                onChange={(e) =>
                  void props.onChange({
                    schedule: { ...settings.schedule, time: e.target.value }
                  })
                }
              />
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={settings.schedule.weekdaysOnly}
                  onChange={(e) =>
                    void props.onChange({
                      schedule: { ...settings.schedule, weekdaysOnly: e.target.checked }
                    })
                  }
                />
                仅工作日
              </label>
            </div>
          </div>
        </div>

        <div className="panel settings-panel">
          <h2>
            <Palette size={16} />
            界面
          </h2>
          <div className="field">
            <span className="field-icon">
              <Palette size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">主题</div>
              <span className="field-hint">跟随系统会随操作系统的深浅色自动切换。</span>
            </div>
            <div className="field-body">
              <Seg
                value={settings.theme}
                items={THEME_OPTIONS}
                onChange={(key) => void props.onChange({ theme: key })}
                ariaLabel="主题"
              />
            </div>
          </div>
          <div className="field">
            <span className="field-icon">
              <PanelLeft size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">侧栏</div>
            </div>
            <div className="field-body">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={settings.sidebarCollapsed}
                  onChange={(e) => void props.onChange({ sidebarCollapsed: e.target.checked })}
                />
                折叠为图标条
              </label>
            </div>
          </div>
          <div className="field">
            <span className="field-icon">
              <EyeOff size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">隐藏站点</div>
              <span className="field-hint">
                关闭后可让已隐藏的站点重新出现在侧栏，账号与数据不会丢失。
              </span>
            </div>
            <div className="field-body">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={settings.hideHiddenSites}
                  onChange={(e) => void props.onChange({ hideHiddenSites: e.target.checked })}
                />
                隐藏的站点不在列表显示
              </label>
            </div>
          </div>
          <div className="field">
            <span className="field-icon">
              <Eye size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">账号打码</div>
              <span className="field-hint">
                开启后账号名、登录账号与凭据用户名会替换成灰色遮罩块，
                日志里的账号标识同样被遮住，方便截图分享。站点名不受影响。
              </span>
            </div>
            <div className="field-body">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={settings.maskAccounts}
                  onChange={(e) => void props.onChange({ maskAccounts: e.target.checked })}
                />
                隐藏账号与邮箱
              </label>
            </div>
          </div>
          <div className="field">
            <span className="field-icon">
              <Minimize2 size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">关闭窗口</div>
              <span className="field-hint">
                点击窗口关闭按钮后应用会收进托盘，定时签到继续在后台运行；
                在托盘图标上右键选择「退出」才会真正结束应用。
              </span>
            </div>
            <div className="field-body">
              <span className="field-static">
                <Minimize2 size={14} />
                最小化到系统托盘
              </span>
            </div>
          </div>
        </div>

        <div className="panel settings-panel">
          <h2>
            <ShieldCheck size={16} />
            安全
          </h2>
          <div className="field">
            <span className="field-icon">
              <ShieldCheck size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">凭据加密</div>
              <span className="field-hint">
                会话 Cookie 与访问令牌使用操作系统密钥保护
                {secure?.platform === 'win32' ? '（Windows DPAPI）' : ''}；
                不可用时会拒绝写入，不会降级为明文。
              </span>
            </div>
            <div className="field-body">
              {secure?.encryptionAvailable ? (
                <span className="tag ok">系统加密可用</span>
              ) : (
                <span className="tag err">系统加密不可用</span>
              )}
            </div>
          </div>
        </div>

        <div className="panel settings-panel">
          <h2>
            <HardDriveDownload size={16} />
            版本与更新
          </h2>
          <div className="field">
            <span className="field-icon">
              <HardDriveDownload size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">当前版本</div>
              <span className="field-hint">
                {info && !info.updaterAvailable
                  ? '开发模式构建，不支持应用内更新；安装版会在后台自动检查。'
                  : '应用启动后会在后台检查更新，下载完成后退出时自动安装。'}
              </span>
            </div>
            <div className="field-body">
              <span className="version-badge">v{info?.version ?? '—'}</span>
            </div>
          </div>
          <div className="field">
            <span className="field-icon">
              <RefreshCw size={16} />
            </span>
            <div className="field-text">
              <div className="field-label">检查更新</div>
            </div>
            <div className="field-body">
              <button
                className="btn small"
                onClick={() => void window.api.update.check()}
                disabled={
                  !!info && !info.updaterAvailable
                    ? true
                    : update.state === 'checking' || update.state === 'downloading'
                }
                title={
                  info && !info.updaterAvailable ? '开发模式不支持应用内更新' : '检查是否有新版本'
                }
              >
                <RefreshCw
                  size={13}
                  className={
                    update.state === 'checking' || update.state === 'downloading'
                      ? 'rotating'
                      : undefined
                  }
                />
                {update.state === 'checking' ? '检查中…' : '检查更新'}
              </button>
              <UpdateStatusText
                status={update}
                onInstall={() => void window.api.update.install()}
                onDownload={() => void window.api.update.openDownload()}
              />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/**
 * 更新状态的一句话说明 + 就绪后的安装按钮。
 *
 * 状态本身在主进程维护，这里只负责翻译成用户能读懂的话，
 * 不重复维护「是否在下载」之类的判断。
 */
function UpdateStatusText({
  status,
  onInstall,
  onDownload
}: {
  status: UpdateStatus
  onInstall: () => void
  onDownload: () => void
}): React.JSX.Element | null {
  switch (status.state) {
    case 'idle':
      return null
    case 'checking':
      return <span className="tag">正在检查…</span>
    case 'none':
      return <span className="tag ok">已是最新</span>
    case 'available':
      return <span className="tag accent">发现 v{status.version}，正在下载</span>
    case 'downloading':
      return (
        <span className="update-progress">
          <span className="update-track">
            <span className="update-fill" style={{ width: `${status.percent}%` }} />
          </span>
          <span className="stat tabular">{Math.round(status.percent)}%</span>
        </span>
      )
    case 'ready':
      return (
        <>
          <span className="tag ok">v{status.version} 已下载</span>
          <button className="btn small primary" onClick={onInstall}>
            <RotateCw size={13} />
            重启安装
          </button>
        </>
      )
    case 'manual':
      return (
        <>
          <span className="tag accent" title="当前构建没有 Apple 开发者证书签名，系统不允许应用内安装">
            发现 v{status.version}
          </span>
          <button className="btn small primary" onClick={onDownload}>
            <HardDriveDownload size={13} />
            下载安装包
          </button>
        </>
      )
    case 'error':
      return (
        <>
          <span className="tag err" title={status.message}>
            {status.message.length > 34 ? `${status.message.slice(0, 34)}…` : status.message}
          </span>
          {status.manualUrl ? (
            <button className="btn small" onClick={onDownload}>
              <HardDriveDownload size={13} />
              手动下载
            </button>
          ) : null}
        </>
      )
  }
}
