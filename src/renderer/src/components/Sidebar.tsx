import {
  Eye,
  Globe,
  KeyRound,
  LayoutGrid,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScrollText,
  Settings
} from 'lucide-react'
import type { Site } from '@shared/types'
import type { ViewKey } from '../App'
import { useSiteIcon } from '../lib/useSiteIcon'

interface Props {
  sites: Site[]
  visibleSites: Site[]
  settings: { sidebarCollapsed: boolean }
  view: ViewKey
  onViewChange: (v: ViewKey) => void
  /** 当前选中的站点；null 表示「全部站点」。侧栏据此高亮并过滤主视图。 */
  activeSiteId: string | null
  onSelectSite: (siteId: string | null) => void
  onToggleCollapse: () => void
  onToggleSiteHidden: (siteId: string, hidden: boolean) => void
  onShowAllHidden: () => void
  onAddSite: () => void
}

/** 账号健康度：任一账号额度读取失败即红，未登录即灰。 */
function siteTone(site: Site): 'ok' | 'warn' | 'err' | '' {
  if (site.accounts.length === 0) return ''
  const now = Date.now()
  const failed = site.accounts.some(
    (a) => a.lastStatus && !a.lastStatus.ok && now - a.lastStatus.at < 86_400_000
  )
  if (failed) return 'err'
  const pending = site.accounts.some((a) => !a.lastStatus)
  if (pending) return 'warn'
  return 'ok'
}

/** 侧栏里单个站点的图标：抓到就用站点 logo，抓不到回退地球图标。 */
function SiteIcon({ site }: { site: Site }): React.JSX.Element {
  const icon = useSiteIcon(site.baseUrl)
  if (icon) return <img className="nav-site-icon" src={icon} alt="" aria-hidden="true" />
  return <Globe size={15} />
}

/**
 * 左侧站点菜单。
 *
 * 两种隐藏方式并存：
 *   1. 整栏折叠为图标条（collapsed）
 *   2. 单个站点隐藏（hidden），可在「显示全部」里一次恢复
 */
export function Sidebar(props: Props): React.JSX.Element {
  const { settings, view, visibleSites, sites } = props
  const collapsed = settings.sidebarCollapsed
  const hiddenCount = sites.filter((s) => s.hidden).length

  return (
    <aside className={collapsed ? 'sidebar collapsed' : 'sidebar'}>
      <div className="sidebar-scroll">
        <div className="section-head">
          <span>站点</span>
          <button onClick={props.onAddSite} title="添加站点">
            <Plus size={12} />
            <span>添加</span>
          </button>
        </div>

        <button
          className={view === 'sites' && !props.activeSiteId ? 'nav-item active' : 'nav-item'}
          onClick={() => {
            props.onViewChange('sites')
            props.onSelectSite(null)
          }}
          title="全部站点"
        >
          <span className="nav-icon">
            <LayoutGrid size={16} />
          </span>
          <span className="nav-label">全部站点</span>
          {sites.length > 0 && <span className="nav-count">{sites.length}</span>}
        </button>

        {visibleSites.map((site) => {
          const tone = siteTone(site)
          const active = view === 'sites' && props.activeSiteId === site.id
          return (
            <button
              key={site.id}
              className={active ? 'nav-item active' : 'nav-item'}
              onClick={() => {
                props.onViewChange('sites')
                props.onSelectSite(site.id)
              }}
              title={site.name}
            >
              <span className="nav-icon">
                <SiteIcon site={site} />
                {tone && <span className={`nav-dot ${tone}`} />}
              </span>
              <span className="nav-label">{site.name}</span>
              {site.accounts.length > 0 && (
                <span className="nav-count">{site.accounts.length}</span>
              )}
            </button>
          )
        })}

        {visibleSites.length === 0 && !collapsed && (
          <div className="hint sidebar-hint">
            还没有站点，点击上方「添加」。
          </div>
        )}

        <div className="section-head">
          <span>系统</span>
        </div>

        <button
          className={view === 'credentials' ? 'nav-item active' : 'nav-item'}
          onClick={() => props.onViewChange('credentials')}
          title="账号"
        >
          <span className="nav-icon">
            <KeyRound size={16} />
          </span>
          <span className="nav-label">账号</span>
        </button>
        <button
          className={view === 'logs' ? 'nav-item active' : 'nav-item'}
          onClick={() => props.onViewChange('logs')}
          title="运行日志"
        >
          <span className="nav-icon">
            <ScrollText size={16} />
          </span>
          <span className="nav-label">运行日志</span>
        </button>
        <button
          className={view === 'settings' ? 'nav-item active' : 'nav-item'}
          onClick={() => props.onViewChange('settings')}
          title="设置"
        >
          <span className="nav-icon">
            <Settings size={16} />
          </span>
          <span className="nav-label">设置</span>
        </button>

        {hiddenCount > 0 && (
          <button className="nav-item" onClick={props.onShowAllHidden} title="显示全部已隐藏站点">
            <span className="nav-icon">
              <Eye size={16} />
            </span>
            <span className="nav-label">显示全部（{hiddenCount}）</span>
          </button>
        )}
      </div>

      <div className="sidebar-foot">
        <button
          className="nav-item"
          onClick={props.onToggleCollapse}
          title={collapsed ? '展开侧栏' : '折叠侧栏'}
          aria-label={collapsed ? '展开侧栏' : '折叠侧栏'}
        >
          <span className="nav-icon">
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </span>
          <span className="nav-label">{collapsed ? '展开侧栏' : '折叠侧栏'}</span>
        </button>
      </div>
    </aside>
  )
}
