import { useEffect, useState } from 'react'
import {
  Activity,
  CalendarClock,
  Minimize2,
  Monitor,
  Moon,
  Network,
  Palette,
  ShieldCheck,
  Sun
} from 'lucide-react'
import type { ProxyProbeResult, Settings, ThemeMode } from '@shared/types'
import { Select } from './Select'
import type { SelectOption } from './Select'
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

/** 设置页：代理、定时签到、界面与安全。 */
export function SettingsView(props: Props): React.JSX.Element {
  const { settings } = props
  const [proxyUrl, setProxyUrl] = useState(settings.proxy.url)
  const [probe, setProbe] = useState<ProxyProbeResult | null>(null)
  const [probing, setProbing] = useState(false)
  const [secure, setSecure] = useState<{ encryptionAvailable: boolean; platform: string } | null>(
    null
  )

  useEffect(() => {
    void window.api.app.secureInfo().then(setSecure)
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
        <h1>设置</h1>
        <span className="sub">代理、定时签到与界面</span>
      </div>

      <div className="content">
        <div className="panel">
          <h2>
            <Network size={15} />
            网络代理
          </h2>
          <div className="field">
            <div className="field-label">代理模式</div>
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
              <span className="field-hint">
                部分网络环境下目标站点直连会被重置，此时需要代理。跟随系统会读取 Windows
                注册表 / macOS scutil / 环境变量。
              </span>
            </div>
          </div>

          {settings.proxy.mode === 'manual' && (
            <div className="field">
              <div className="field-label">代理地址</div>
              <div className="field-body">
                <input
                  style={{ width: 320 }}
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
                <span className="field-hint">
                  支持 http:// 与 socks5:// 两种协议；留空等同直连。
                </span>
              </div>
            </div>
          )}

          {settings.proxy.mode !== 'manual' && (
            <div className="field">
              <div className="field-label">连通性</div>
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

        <div className="panel">
          <h2>
            <CalendarClock size={15} />
            定时签到
          </h2>
          <div className="field">
            <div className="field-label">自动签到</div>
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
              <span className="field-hint">
                启用后由主进程在后台执行，不依赖窗口是否打开。
              </span>
            </div>
          </div>
          <div className="field">
            <div className="field-label">执行时间</div>
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
              <span className="field-hint">
                建议设为 08:05 之后：多数站点的奖励周期在北京时间 08:00 切换。
              </span>
            </div>
          </div>
        </div>

        <div className="panel">
          <h2>
            <Palette size={15} />
            界面
          </h2>
          <div className="field">
            <div className="field-label">主题</div>
            <div className="field-body">
              <div className="seg">
                {THEME_OPTIONS.map((t) => {
                  const Icon = t.icon
                  return (
                    <button
                      key={t.key}
                      className={settings.theme === t.key ? 'seg-item active' : 'seg-item'}
                      onClick={() => void props.onChange({ theme: t.key })}
                    >
                      <Icon size={13} />
                      {t.label}
                    </button>
                  )
                })}
              </div>
              <span className="field-hint">跟随系统会随操作系统的深浅色自动切换。</span>
            </div>
          </div>
          <div className="field">
            <div className="field-label">侧栏</div>
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
            <div className="field-label">隐藏站点</div>
            <div className="field-body">
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={settings.hideHiddenSites}
                  onChange={(e) => void props.onChange({ hideHiddenSites: e.target.checked })}
                />
                隐藏的站点不在列表显示
              </label>
              <span className="field-hint">
                关闭后可让已隐藏的站点重新出现在侧栏，账号与数据不会丢失。
              </span>
            </div>
          </div>
          <div className="field">
            <div className="field-label">关闭窗口</div>
            <div className="field-body">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-dim)' }}>
                <Minimize2 size={14} />
                最小化到系统托盘
              </span>
              <span className="field-hint">
                点击窗口关闭按钮后应用会收进托盘，定时签到继续在后台运行；
                在托盘图标上右键选择「退出」才会真正结束应用。
              </span>
            </div>
          </div>
        </div>

        <div className="panel">
          <h2>
            <ShieldCheck size={15} />
            安全
          </h2>
          <div className="field">
            <div className="field-label">凭据加密</div>
            <div className="field-body">
              {secure?.encryptionAvailable ? (
                <span className="tag ok">系统加密可用</span>
              ) : (
                <span className="tag err">系统加密不可用</span>
              )}
              <span className="field-hint">
                会话 Cookie 与访问令牌使用操作系统密钥保护
                {secure?.platform === 'win32' ? '（Windows DPAPI）' : ''}；
                不可用时会拒绝写入，不会降级为明文。
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
