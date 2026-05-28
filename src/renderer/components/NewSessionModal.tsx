import React, { useState, useEffect } from 'react'
import { WorkspaceFolder } from '../../shared/types'
import { AGENT_PROVIDERS, AGENT_PROVIDER_LABELS, type AgentProvider } from '../../shared/agent-provider'
import { PresetEditor } from './presets'
import './NewSessionModal.css'

interface Props {
  scanPath: string
  onStart: (folder: WorkspaceFolder, useWorktree: boolean, provider: AgentProvider) => void
  onClose: () => void
}

export function NewSessionModal({ scanPath, onStart, onClose }: Props) {
  const [folders, setFolders] = useState<WorkspaceFolder[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [provider, setProvider] = useState<AgentProvider>('claude')
  const [useWorktree, setUseWorktree] = useState(false)
  const [showSavePreset, setShowSavePreset] = useState(false)
  const [selectedFolder, setSelectedFolder] = useState<WorkspaceFolder | null>(null)

  useEffect(() => {
    window.api.listWorkspaceFolders(scanPath).then((f) => {
      setFolders(f)
      setLoading(false)
    })
  }, [scanPath])

  const handleBrowseFolder = async () => {
    const selected = await window.api.selectFolder()
    if (selected) {
      const name = selected.split('/').filter(Boolean).pop() || selected
      const folder = { name, path: selected } as WorkspaceFolder
      onStart(folder, useWorktree, provider)
    }
  }

  const handleSaveAsPreset = (folder?: WorkspaceFolder) => {
    if (folder) setSelectedFolder(folder)
    setShowSavePreset(true)
  }

  const filtered = folders.filter(
    (f) => !search || f.name.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 500, display: 'flex', flexDirection: 'column' }}>
        <h2 style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          New Session
          <button
            className="btn btn-sm"
            onClick={onClose}
            style={{ fontSize: 16, lineHeight: 1, padding: '2px 8px' }}
          >x</button>
        </h2>
        <div className="new-session-provider-row" role="radiogroup" aria-label="Agent provider">
          {AGENT_PROVIDERS.map((p) => (
            <label key={p} className={`new-session-provider-option${provider === p ? ' active' : ''}`}>
              <input
                type="radio"
                name="session-provider"
                value={p}
                checked={provider === p}
                onChange={() => setProvider(p)}
              />
              {AGENT_PROVIDER_LABELS[p]}
            </label>
          ))}
        </div>
        <input
          className="search-input"
          placeholder="Filter folders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          style={{ width: '100%', marginBottom: 8 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useWorktree}
              onChange={(e) => setUseWorktree(e.target.checked)}
            />
            Create git worktree (recommended for isolation)
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-sm"
              onClick={() => handleSaveAsPreset()}
              style={{ fontSize: 12, whiteSpace: 'nowrap' }}
              title="Save current configuration as a reusable preset"
            >
              Save as Preset
            </button>
            <button
              className="btn btn-sm"
              onClick={handleBrowseFolder}
              style={{ fontSize: 12, whiteSpace: 'nowrap' }}
            >
              Open Folder...
            </button>
          </div>
        </div>
        <div style={{ overflowY: 'auto', maxHeight: '50vh', margin: '0 -24px', padding: '0 24px' }}>
          {loading ? (
            <div style={{ padding: 16, color: 'var(--text-muted)' }}>Loading...</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 16, color: 'var(--text-muted)' }}>No folders found</div>
          ) : (
            filtered.map((folder) => (
              <div
                key={folder.path}
                className="new-session-folder-item"
              >
                <div
                  style={{ flex: 1, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', minWidth: 0 }}
                  onClick={() => onStart(folder, useWorktree, provider)}
                >
                  <span className="new-session-folder-name">{folder.name}</span>
                  <span className="new-session-folder-path">{folder.path}</span>
                </div>
                <button
                  className="new-session-save-preset-btn"
                  onClick={(e) => { e.stopPropagation(); handleSaveAsPreset(folder) }}
                  title="Save as preset"
                >
                  +P
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      {showSavePreset && (
        <PresetEditor
          scanPath={scanPath}
          onSave={async (input) => {
            await window.api.presetCreate(input)
            setShowSavePreset(false)
          }}
          onClose={() => setShowSavePreset(false)}
          prefill={selectedFolder ? {
            projectPath: selectedFolder.path,
            projectName: selectedFolder.name,
            useWorktree,
          } : { useWorktree }}
        />
      )}
    </div>
  )
}
