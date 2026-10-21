import { useState } from 'react'
import type { CheckinMode, Site } from '@shared/types'
import { Modal } from './Modal'
import { Seg } from './Seg'
import { MODE_LABEL } from '../lib/format'

interface Props {
  site: Site
  onClose: () => void
  onSubmit: (siteId: string, patch: { name: string; baseUrl: string; mode: CheckinMode }) => void
}

const MODES: CheckinMode[] = ['BUTTON', 'RELOGIN', 'LOGIN_GRANT', 'WEB_ONLY']

/**
 * 编辑站点：名称、地址与签到方式。
 *
 * 修改地址不会重新探测站点形态（协议、人机验证配置保持原值），
 * 站点大改时建议移除后重新添加。
 */
export function EditSiteDialog({ site, onClose, onSubmit }: Props): React.JSX.Element {
  const [name, setName] = useState(site.name)
  const [baseUrl, setBaseUrl] = useState(site.baseUrl)
  const [mode, setMode] = useState<CheckinMode>(site.mode)

  const urlValid = /^https?:\/\//i.test(baseUrl.trim())
  const canSubmit = name.trim().length > 0 && urlValid

  const submit = (): void => {
    if (!canSubmit) return
    onSubmit(site.id, {
      name: name.trim(),
      baseUrl: baseUrl.trim().replace(/\/+$/, ''),
      mode
    })
  }

  return (
    <Modal
      title={`编辑站点 · ${site.name}`}
      onClose={onClose}
      onSubmit={submit}
      submitDisabled={!canSubmit}
    >
      <div className="modal-field">
        <label className="modal-label">站点名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 My Relay" />
      </div>

      <div className="modal-field">
        <label className="modal-label">站点地址</label>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com"
        />
        {!urlValid && baseUrl.trim() !== '' && (
          <div className="modal-error">地址必须以 http:// 或 https:// 开头</div>
        )}
      </div>

      <div className="modal-field">
        <label className="modal-label">签到方式</label>
        <Seg
          value={mode}
          items={MODES.map((m) => ({ key: m, label: MODE_LABEL[m] }))}
          onChange={setMode}
          ariaLabel="签到方式"
        />
      </div>

      <div className="hint">修改地址不会重新探测站点协议与人机验证配置；站点形态大改时建议移除后重新添加。</div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          取消
        </button>
        <button className="btn primary" disabled={!canSubmit} onClick={submit}>
          保存
        </button>
      </div>
    </Modal>
  )
}
