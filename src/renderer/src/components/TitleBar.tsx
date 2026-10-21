import iconUrl from '../../../../resources/brand.png'

interface Props {
  collapsed: boolean
  version?: string
  /** 存在可用新版本时在版本号旁显示 new 徽标。 */
  hasUpdate: boolean
}

/**
 * 自绘标题条（magpie 风格）：品牌行顶到窗口最上沿，与侧栏同宽同底色，
 * 中间整条是窗口拖拽区；最小化/最大化/关闭由系统提供
 * （Windows 窗口控制覆叠 / macOS 红绿灯），不自绘按钮。
 *
 * 副标题不再写死宣传语，改为版本号：一眼知道当前跑的是哪个版本，
 * 后台发现新版本时追加 new 徽标。
 */
export function TitleBar(props: Props): React.JSX.Element {
  return (
    <div className="titlebar">
      <div className={props.collapsed ? 'titlebar-brand collapsed' : 'titlebar-brand'}>
        <div className="brand">
          <img className="brand-mark" src={iconUrl} alt="" aria-hidden="true" />
          <div className="brand-text">
            <div className="brand-name">AutoSign</div>
            {props.version && <span className="brand-ver">v{props.version}</span>}
            {props.hasUpdate && <span className="badge-new">new</span>}
          </div>
        </div>
      </div>
      <div className="titlebar-drag" />
    </div>
  )
}
