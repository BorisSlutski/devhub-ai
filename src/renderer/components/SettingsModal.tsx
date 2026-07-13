import React, { useState, useEffect, useCallback } from 'react'
import { EnhancerConfig, DEFAULT_ENHANCER_MODEL, DEFAULT_OPENAI_BASE_URL, MODEL_PRICING } from '../../shared/enhancer-types'
import { NotificationSettings } from './NotificationSettings'

interface RtkStatus {
  installed: boolean
  version: string | null
  hookActive: boolean
  path: string | null
}

interface RtkGain {
  totalSaved: number
  savingsPercent: number
  commandCount: number
  raw: string
}

const DEFAULT_MODELS = [
  { id: '', label: 'Default (Sonnet 4.6)', desc: 'Claude picks based on plan' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', desc: 'Latest Sonnet — fast & capable' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6', desc: 'Latest Opus — most capable' },
  { id: 'haiku', label: 'Claude Haiku 3.5', desc: 'Fastest, cheapest' },
]

interface Props {
  currentPath: string
  currentScanDepth: number
  rtkEnabled: boolean
  dangerousMode: boolean
  chatInputEnabled: boolean
  defaultModel: string
  usePtyDaemon?: boolean
  onSave: (newPath: string, scanDepth: number, rtkEnabled: boolean, dangerousMode: boolean, chatInputEnabled: boolean, defaultModel: string, usePtyDaemon: boolean) => void
  onClose: () => void
}

const DEFAULT_SCAN_DEPTH = 50

export function SettingsModal({ currentPath, currentScanDepth, rtkEnabled, dangerousMode, chatInputEnabled, defaultModel, usePtyDaemon = false, onSave, onClose }: Props) {
  const [path, setPath] = useState(currentPath)
  const [scanDepth, setScanDepth] = useState(currentScanDepth)
  const [rtk, setRtk] = useState(rtkEnabled)
  const [dangerous, setDangerous] = useState(dangerousMode)
  const [chatInput, setChatInput] = useState(chatInputEnabled)
  const [model, setModel] = useState(defaultModel)
  const [ptyDaemon, setPtyDaemon] = useState(usePtyDaemon)
  const [updateInfo, setUpdateInfo] = useState<{ status: string; version: string | null; error: string | null } | null>(null)
  const [dangerousConfirm, setDangerousConfirm] = useState('')
  const [showDangerousConfirm, setShowDangerousConfirm] = useState(false)
  const [rtkStatus, setRtkStatus] = useState<RtkStatus | null>(null)
  const [rtkGain, setRtkGain] = useState<RtkGain | null>(null)
  const [rtkLoading, setRtkLoading] = useState(false)
  const [rtkMessage, setRtkMessage] = useState<string | null>(null)

  const [enhancerConfig, setEnhancerConfig] = useState<EnhancerConfig>({ enabled: false, apiKey: '', model: DEFAULT_ENHANCER_MODEL, baseUrl: '' })
  const [enhancerKeyVisible, setEnhancerKeyVisible] = useState(false)
  const [enhancerTotalCost, setEnhancerTotalCost] = useState<{ totalUsd: number; calls: number } | null>(null)
  const [enhancerSaved, setEnhancerSaved] = useState(false)

  const refreshRtkStatus = useCallback(async () => {
    const status = await window.api.rtkDetect()
    setRtkStatus(status)
    if (status.installed) {
      const gain = await window.api.rtkGain()
      setRtkGain(gain)
    }
  }, [])

  useEffect(() => {
    refreshRtkStatus()
  }, [refreshRtkStatus])

  useEffect(() => {
    window.api.enhancerGetConfig?.()
      .then(setEnhancerConfig)
      .catch(() => {})
    window.api.enhancerGetTotalCost?.()
      .then(c => setEnhancerTotalCost({ totalUsd: c.totalUsd, calls: c.calls }))
      .catch(() => {})
  }, [])

  const handleSaveEnhancer = useCallback(async () => {
    await window.api.enhancerSetConfig?.(enhancerConfig)
    setEnhancerSaved(true)
    setTimeout(() => setEnhancerSaved(false), 2000)
  }, [enhancerConfig])

  const handleBrowse = async () => {
    const selected = await window.api.selectFolder()
    if (selected) {
      setPath(selected)
    }
  }

  const handleSave = () => {
    if (path.trim()) {
      onSave(path.trim(), scanDepth, rtk, dangerous, chatInput, model, ptyDaemon)
    }
  }

  const handleCheckUpdates = async () => {
    const status = await window.api.appCheckUpdates()
    setUpdateInfo({ status: status.status, version: status.version, error: status.error })
  }

  const handleToggleDangerous = () => {
    if (!dangerous) {
      setShowDangerousConfirm(true)
      setDangerousConfirm('')
    } else {
      setDangerous(false)
    }
  }

  const handleConfirmDangerous = () => {
    if (dangerousConfirm === 'I understand the risks') {
      setDangerous(true)
      setShowDangerousConfirm(false)
      setDangerousConfirm('')
    }
  }

  const handleToggleRtk = async () => {
    if (!rtkStatus?.installed) return
    setRtkLoading(true)
    setRtkMessage(null)

    if (!rtk) {
      const result = await window.api.rtkEnable()
      if (result.success) {
        setRtk(true)
        setRtkMessage('RTK hook installed. Restart Claude sessions for it to take effect.')
      } else {
        setRtkMessage(`Failed to enable: ${result.output}`)
      }
    } else {
      const result = await window.api.rtkDisable()
      if (result.success) {
        setRtk(false)
        setRtkMessage('RTK hook removed.')
      } else {
        setRtkMessage(`Failed to disable: ${result.output}`)
      }
    }

    setRtkLoading(false)
    await refreshRtkStatus()
  }

  const formatTokens = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return String(n)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <h2>Settings</h2>

        {/* Workspace path */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Workspace Path
          </label>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            The root directory that DevHub-AI scans for projects and folders.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              className="search-input"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/path/to/your/workspace"
              style={{ flex: 1 }}
            />
            <button className="btn btn-sm" onClick={handleBrowse}>
              Browse
            </button>
          </div>
        </div>

        {/* Scan depth */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
            Scan Depth
          </label>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
            How many directory levels deep to search for projects. Set to 1 for immediate children only.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              type="range"
              min={1}
              max={50}
              value={scanDepth}
              onChange={(e) => setScanDepth(parseInt(e.target.value))}
              style={{ flex: 1 }}
            />
            <input
              className="search-input"
              type="number"
              min={1}
              max={50}
              value={scanDepth}
              onChange={(e) => {
                const v = parseInt(e.target.value)
                if (v >= 1 && v <= 50) setScanDepth(v)
              }}
              style={{ width: 60, textAlign: 'center' }}
            />
          </div>
        </div>

        {/* Chat Input Mode section */}
        <div style={{
          marginBottom: 20,
          padding: 14,
          borderRadius: 8,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                Chat Input Bar
              </label>
              <span style={{
                marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 4,
                background: chatInput ? 'var(--green)' : 'var(--text-muted)',
                color: '#000', fontWeight: 600
              }}>
                {chatInput ? 'ON' : 'OFF'}
              </span>
            </div>
            <button
              className={`btn btn-sm ${chatInput ? 'btn-accent' : 'btn-primary'}`}
              onClick={() => setChatInput(!chatInput)}
              style={{ minWidth: 80 }}
            >
              {chatInput ? 'Disable' : 'Enable'}
            </button>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
            Show a Cursor-style input bar below the terminal with mode/model selectors, image upload,
            and context indicator. You can still type directly in the terminal when this is on.
          </p>
        </div>

        {/* Desktop Notifications */}
        <NotificationSettings />

        {/* Default Model */}
        <div style={{
          marginBottom: 20,
          padding: 14,
          borderRadius: 8,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)'
        }}>
          <label style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 6 }}>
            Default Claude Model
          </label>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 10px' }}>
            The model used when starting new Claude sessions. Can be overridden per-session via the chat input bar.
          </p>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12,
              background: 'var(--bg-tertiary, var(--bg-primary))',
              color: 'var(--text-primary)', border: '1px solid var(--border)'
            }}
          >
            {DEFAULT_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} — {m.desc}
              </option>
            ))}
          </select>
        </div>

        {/* RTK section */}
        <div style={{
          marginBottom: 20,
          padding: 14,
          borderRadius: 8,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                RTK — Token Compression
              </label>
              <span style={{
                marginLeft: 8,
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 4,
                background: rtkStatus?.installed ? 'var(--green)' : 'var(--text-muted)',
                color: '#000',
                fontWeight: 600
              }}>
                {rtkStatus?.installed ? `v${rtkStatus.version}` : 'Not installed'}
              </span>
            </div>
            {rtkStatus?.installed && (
              <button
                className={`btn btn-sm ${rtk ? 'btn-accent' : 'btn-primary'}`}
                onClick={handleToggleRtk}
                disabled={rtkLoading}
                style={{ minWidth: 80 }}
              >
                {rtkLoading ? '...' : rtk ? 'Disable' : 'Enable'}
              </button>
            )}
          </div>

          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 10px' }}>
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); window.api.openInBrowser('https://github.com/rtk-ai/rtk') }}
              style={{ color: 'var(--blue, #58a6ff)', textDecoration: 'none' }}
            >RTK (Rust Token Killer)</a> reduces LLM token consumption by 60-90% by compressing
            CLI output before it reaches Claude. Single Rust binary, {'<'}10ms overhead.
          </p>

          {!rtkStatus?.installed && (
            <div style={{
              padding: '8px 10px',
              borderRadius: 6,
              background: 'var(--bg-tertiary, var(--bg-primary))',
              fontSize: 11,
              color: 'var(--text-secondary)',
              fontFamily: 'monospace'
            }}>
              Install via: <strong>brew install rtk</strong>
            </div>
          )}

          {rtkStatus?.installed && rtkGain && rtkGain.commandCount > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 8,
              marginTop: 8
            }}>
              <div style={{
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--bg-tertiary, var(--bg-primary))',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)' }}>
                  {formatTokens(rtkGain.totalSaved)}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>tokens saved</div>
              </div>
              <div style={{
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--bg-tertiary, var(--bg-primary))',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--orange)' }}>
                  {rtkGain.savingsPercent.toFixed(0)}%
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>reduction</div>
              </div>
              <div style={{
                padding: '8px 10px',
                borderRadius: 6,
                background: 'var(--bg-tertiary, var(--bg-primary))',
                textAlign: 'center'
              }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)' }}>
                  {rtkGain.commandCount}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>commands</div>
              </div>
            </div>
          )}

          {rtkMessage && (
            <div style={{
              marginTop: 8,
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 11,
              color: 'var(--text-secondary)',
              background: 'var(--bg-tertiary, var(--bg-primary))'
            }}>
              {rtkMessage}
            </div>
          )}
        </div>

        {/* Prompt Enhancer section */}
        <div style={{
          marginBottom: 20,
          padding: 14,
          borderRadius: 8,
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                Prompt Enhancer
              </label>
              <span style={{
                marginLeft: 8, fontSize: 10, padding: '1px 6px', borderRadius: 4,
                background: enhancerConfig.enabled && enhancerConfig.apiKey ? 'var(--green)' : 'var(--text-muted)',
                color: '#000', fontWeight: 600
              }}>
                {enhancerConfig.enabled && enhancerConfig.apiKey ? 'Active' : 'Off'}
              </span>
            </div>
            <button
              className={`btn btn-sm ${enhancerConfig.enabled ? 'btn-accent' : 'btn-primary'}`}
              onClick={() => {
                const next = { ...enhancerConfig, enabled: !enhancerConfig.enabled }
                setEnhancerConfig(next)
                window.api.enhancerSetConfig?.(next)
              }}
              style={{ minWidth: 80 }}
            >
              {enhancerConfig.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>

          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 10px' }}>
            Improves your prompts before sending to Claude. Uses OpenAI to analyze your prompt with current context
            and suggests a better version. Toggle on/off in the chat input bar. Very cheap — typically &lt;$0.01/session.
          </p>

          {enhancerConfig.enabled && (
            <>
              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  OpenAI API Key
                </label>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    className="search-input"
                    type={enhancerKeyVisible ? 'text' : 'password'}
                    value={enhancerConfig.apiKey}
                    onChange={(e) => setEnhancerConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                    placeholder="sk-..."
                    style={{ flex: 1, fontSize: 12, fontFamily: 'monospace' }}
                  />
                  <button
                    className="btn btn-sm"
                    onClick={() => setEnhancerKeyVisible(!enhancerKeyVisible)}
                    style={{ minWidth: 50, fontSize: 11 }}
                  >
                    {enhancerKeyVisible ? 'Hide' : 'Show'}
                  </button>
                </div>
              </div>

              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  Model
                </label>
                <select
                  value={enhancerConfig.model}
                  onChange={(e) => setEnhancerConfig(prev => ({ ...prev, model: e.target.value }))}
                  style={{
                    width: '100%', padding: '6px 8px', borderRadius: 6, fontSize: 12,
                    background: 'var(--bg-tertiary, var(--bg-primary))',
                    color: 'var(--text-primary)', border: '1px solid var(--border)'
                  }}
                >
                  {Object.entries(MODEL_PRICING).map(([model, pricing]) => (
                    <option key={model} value={model}>
                      {model} — ${pricing.input}/M in, ${pricing.output}/M out
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ marginBottom: 10 }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }}>
                  API Base URL <span style={{ color: 'var(--text-muted)' }}>(optional — for company proxy)</span>
                </label>
                <input
                  className="search-input"
                  value={enhancerConfig.baseUrl}
                  onChange={(e) => setEnhancerConfig(prev => ({ ...prev, baseUrl: e.target.value }))}
                  placeholder={DEFAULT_OPENAI_BASE_URL}
                  style={{ width: '100%', fontSize: 12, fontFamily: 'monospace' }}
                />
                <p style={{ fontSize: 10, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                  Leave empty to use the default OpenAI endpoint. Set to your proxy URL if your company requires it.
                </p>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleSaveEnhancer}
                  style={{ minWidth: 80 }}
                >
                  {enhancerSaved ? 'Saved!' : 'Save'}
                </button>
                {enhancerTotalCost && enhancerTotalCost.calls > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    Total spend: ${enhancerTotalCost.totalUsd.toFixed(4)} ({enhancerTotalCost.calls} calls)
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        {/* Dangerous Mode section */}
        <div style={{
          marginBottom: 20,
          padding: 14,
          borderRadius: 8,
          background: dangerous ? 'rgba(248, 81, 73, 0.08)' : 'var(--bg-secondary)',
          border: dangerous ? '1px solid rgba(248, 81, 73, 0.4)' : '1px solid var(--border)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: dangerous ? '#f85149' : 'var(--text-primary)' }}>
                Dangerous Mode
              </label>
              <span style={{
                marginLeft: 8,
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 4,
                background: dangerous ? '#f85149' : 'var(--text-muted)',
                color: dangerous ? '#fff' : '#000',
                fontWeight: 600
              }}>
                {dangerous ? 'ON' : 'OFF'}
              </span>
            </div>
            <button
              className={`btn btn-sm ${dangerous ? 'btn-danger' : ''}`}
              onClick={handleToggleDangerous}
              style={{ minWidth: 80 }}
            >
              {dangerous ? 'Disable' : 'Enable'}
            </button>
          </div>

          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 4px' }}>
            When enabled, Claude executes commands <strong>without asking for permission</strong>.
            This includes file modifications, deletions, and system commands.
          </p>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0 }}>
            Safe mode (default) requires Claude to ask before executing each action.
          </p>

          {showDangerousConfirm && (
            <div style={{
              marginTop: 12,
              padding: '10px 12px',
              borderRadius: 6,
              background: 'rgba(248, 81, 73, 0.1)',
              border: '1px solid rgba(248, 81, 73, 0.3)'
            }}>
              <p style={{ fontSize: 12, color: '#f85149', margin: '0 0 8px', fontWeight: 600 }}>
                Are you sure? Claude will run commands without confirmation.
              </p>
              <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 8px' }}>
                Type <strong>I understand the risks</strong> to confirm:
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  className="search-input"
                  value={dangerousConfirm}
                  onChange={(e) => setDangerousConfirm(e.target.value)}
                  placeholder="I understand the risks"
                  style={{ flex: 1, fontSize: 12 }}
                  data-testid="dangerous-confirm-input"
                  autoFocus
                />
                <button
                  className="btn btn-sm btn-danger"
                  onClick={handleConfirmDangerous}
                  disabled={dangerousConfirm !== 'I understand the risks'}
                >
                  Confirm
                </button>
                <button
                  className="btn btn-sm"
                  onClick={() => { setShowDangerousConfirm(false); setDangerousConfirm('') }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>Advanced</h3>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={ptyDaemon} onChange={e => setPtyDaemon(e.target.checked)} />
            Use PTY daemon (sessions survive app restart — restart required)
          </label>
        </div>

        <div style={{ marginBottom: 16, padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
          <h3 style={{ fontSize: 13, marginBottom: 8 }}>Updates</h3>
          <button type="button" className="btn btn-sm" onClick={handleCheckUpdates}>Check for updates</button>
          {updateInfo && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              {updateInfo.error || (updateInfo.version ? `Status: ${updateInfo.status} (${updateInfo.version})` : `Status: ${updateInfo.status}`)}
            </p>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-sm btn-primary" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  )
}
