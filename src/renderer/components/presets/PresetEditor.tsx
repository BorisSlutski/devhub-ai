import React, { useState, useEffect } from 'react'
import type { SessionPreset, SessionPresetCreate } from '../../../shared/ipc-types'
import type { WorkspaceFolder } from '../../../shared/types'
import { SESSION_ACCENT_COLORS } from '../../../shared/session-ui'

interface Props {
  preset?: SessionPreset | null
  scanPath: string
  onSave: (input: SessionPresetCreate) => void
  onClose: () => void
  /** Pre-fill from current session configuration */
  prefill?: Partial<SessionPresetCreate>
}

const EMOJI_OPTIONS = [
  '>', '!', '~', '#', '$', '%', '@', '&', '*', '+',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'T', 'X',
]

const MODEL_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
]

export function PresetEditor({ preset, scanPath, onSave, onClose, prefill }: Props) {
  const [name, setName] = useState(preset?.name || prefill?.name || '')
  const [icon, setIcon] = useState(preset?.icon || prefill?.icon || '')
  const [projectPath, setProjectPath] = useState(preset?.projectPath || prefill?.projectPath || '')
  const [projectName, setProjectName] = useState(preset?.projectName || prefill?.projectName || '')
  const [useWorktree, setUseWorktree] = useState(preset?.useWorktree ?? prefill?.useWorktree ?? false)
  const [dangerousMode, setDangerousMode] = useState(preset?.dangerousMode ?? prefill?.dangerousMode ?? false)
  const [model, setModel] = useState(preset?.model || prefill?.model || '')
  const [initialCommands, setInitialCommands] = useState(
    (preset?.initialCommands || prefill?.initialCommands || []).join('\n')
  )
  const [pinned, setPinned] = useState(preset?.pinned ?? prefill?.pinned ?? false)
  const [nickname, setNickname] = useState(preset?.nickname || prefill?.nickname || '')
  const [accentColor, setAccentColor] = useState(preset?.accentColor || prefill?.accentColor || 'blue')
  const [claudeArgs, setClaudeArgs] = useState(preset?.claudeArgs || prefill?.claudeArgs || '')
  const [envVarsText, setEnvVarsText] = useState(
    Object.entries(preset?.envVars || prefill?.envVars || {}).map(([k, v]) => `${k}=${v}`).join('\n')
  )

  const [folders, setFolders] = useState<WorkspaceFolder[]>([])
  const [folderSearch, setFolderSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [errors, setErrors] = useState<Record<string, string>>({})

  useEffect(() => {
    window.api.listWorkspaceFolders(scanPath).then((f) => {
      setFolders(f)
      setLoading(false)
    })
  }, [scanPath])

  const filteredFolders = folders.filter(
    (f) => !folderSearch || f.name.toLowerCase().includes(folderSearch.toLowerCase())
  )

  const validate = (): boolean => {
    const errs: Record<string, string> = {}
    if (!name.trim()) errs.name = 'Name is required'
    if (!projectPath) errs.project = 'Project is required'
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleSubmit = () => {
    if (!validate()) return
    const cmds = initialCommands
      .split('\n')
      .map(c => c.trim())
      .filter(c => c.length > 0)
    const envVars: Record<string, string> = {}
    for (const line of envVarsText.split('\n')) {
      const t = line.trim()
      if (!t || !t.includes('=')) continue
      const eq = t.indexOf('=')
      envVars[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    onSave({
      name: name.trim(),
      icon: icon || undefined,
      projectPath,
      projectName,
      useWorktree,
      dangerousMode,
      model: model || undefined,
      initialCommands: cmds.length > 0 ? cmds : undefined,
      pinned,
      nickname: nickname.trim() || undefined,
      accentColor: accentColor || undefined,
      claudeArgs: claudeArgs.trim() || undefined,
      envVars: Object.keys(envVars).length > 0 ? envVars : undefined,
    })
  }

  const selectProject = (folder: WorkspaceFolder) => {
    setProjectPath(folder.path)
    setProjectName(folder.name)
    setFolderSearch('')
    setErrors(prev => {
      const { project, ...rest } = prev
      return rest
    })
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preset-editor-modal" onClick={(e) => e.stopPropagation()}>
        <h2 className="preset-editor-title">
          {preset ? 'Edit Preset' : 'Create Preset'}
          <button className="btn btn-sm" onClick={onClose} style={{ fontSize: 16, lineHeight: 1, padding: '2px 8px' }}>
            x
          </button>
        </h2>

        <div className="preset-editor-form">
          {/* Name + Icon row */}
          <div className="preset-field-row">
            <div className="preset-field" style={{ flex: 1 }}>
              <label className="preset-label">Name *</label>
              <input
                className="preset-input"
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setErrors(prev => { const { name: _, ...rest } = prev; return rest }) }}
                placeholder="e.g., Backend Debug"
                autoFocus
              />
              {errors.name && <span className="preset-error">{errors.name}</span>}
            </div>
            <div className="preset-field" style={{ width: 100 }}>
              <label className="preset-label">Nickname</label>
              <input className="preset-input" type="text" value={nickname} onChange={e => setNickname(e.target.value)} placeholder="Optional" />
            </div>
            <div className="preset-field" style={{ width: 90 }}>
              <label className="preset-label">Color</label>
              <select className="preset-input" value={accentColor} onChange={e => setAccentColor(e.target.value)}>
                {SESSION_ACCENT_COLORS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
            </div>
            <div className="preset-field" style={{ width: 80 }}>
              <label className="preset-label">Icon</label>
              <div className="preset-icon-picker">
                <div className="preset-icon-current" title="Pick an icon">
                  {icon || '-'}
                </div>
                <div className="preset-icon-grid">
                  <button
                    className={`preset-icon-option ${!icon ? 'selected' : ''}`}
                    onClick={() => setIcon('')}
                  >-</button>
                  {EMOJI_OPTIONS.map((e) => (
                    <button
                      key={e}
                      className={`preset-icon-option ${icon === e ? 'selected' : ''}`}
                      onClick={() => setIcon(e)}
                    >{e}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Project selection */}
          <div className="preset-field">
            <label className="preset-label">Project *</label>
            {projectPath ? (
              <div className="preset-project-selected">
                <span className="preset-project-name">{projectName}</span>
                <span className="preset-project-path">{projectPath}</span>
                <button className="preset-project-change" onClick={() => { setProjectPath(''); setProjectName('') }}>
                  Change
                </button>
              </div>
            ) : (
              <>
                <input
                  className="preset-input"
                  type="text"
                  value={folderSearch}
                  onChange={(e) => setFolderSearch(e.target.value)}
                  placeholder="Search projects..."
                />
                <div className="preset-folder-list">
                  {loading ? (
                    <div className="preset-folder-empty">Loading...</div>
                  ) : filteredFolders.length === 0 ? (
                    <div className="preset-folder-empty">No projects found</div>
                  ) : (
                    filteredFolders.slice(0, 20).map((f) => (
                      <div
                        key={f.path}
                        className="preset-folder-item"
                        onClick={() => selectProject(f)}
                      >
                        <span className="preset-folder-name">{f.name}</span>
                        <span className="preset-folder-path">{f.path}</span>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
            {errors.project && <span className="preset-error">{errors.project}</span>}
          </div>

          {/* Toggles */}
          <div className="preset-toggles">
            <label className="preset-toggle">
              <input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} />
              <span>Create git worktree</span>
            </label>
            <label className="preset-toggle">
              <input type="checkbox" checked={dangerousMode} onChange={(e) => setDangerousMode(e.target.checked)} />
              <span>Dangerous mode</span>
              {dangerousMode && <span className="preset-warning">Claude will execute commands without asking</span>}
            </label>
            <label className="preset-toggle">
              <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
              <span>Pin to quick-launch bar</span>
            </label>
          </div>

          <div className="preset-field">
            <label className="preset-label">Claude extra args</label>
            <input className="preset-input" type="text" value={claudeArgs} onChange={e => setClaudeArgs(e.target.value)} placeholder="e.g. --verbose" />
          </div>

          <div className="preset-field">
            <label className="preset-label">Environment variables</label>
            <textarea className="preset-input" rows={3} value={envVarsText} onChange={e => setEnvVarsText(e.target.value)} placeholder="KEY=value (one per line)" />
          </div>

          {/* Model */}
          <div className="preset-field">
            <label className="preset-label">Model</label>
            <select
              className="preset-select"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>

          {/* Initial commands */}
          <div className="preset-field">
            <label className="preset-label">
              Initial Commands
              <span className="preset-label-hint">(one per line, run after session starts)</span>
            </label>
            <textarea
              className="preset-textarea"
              value={initialCommands}
              onChange={(e) => setInitialCommands(e.target.value)}
              placeholder="npm run dev&#10;echo 'Ready!'"
              rows={3}
            />
          </div>
        </div>

        <div className="preset-editor-actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit}>
            {preset ? 'Save Changes' : 'Create Preset'}
          </button>
        </div>
      </div>
    </div>
  )
}
