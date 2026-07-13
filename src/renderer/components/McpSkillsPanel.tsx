import React, { useState, useEffect, useCallback } from 'react'
import { importMcpDefinition } from '../../shared/mcp-import'
import './McpSkillsPanel.css'

interface McpServer {
  name: string
  type: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfigGroup {
  scope: string
  path: string
  servers: Record<string, any>
}

interface Skill {
  name: string
  scope: string
  path: string
  description: string
}

interface Props {
  projectPath: string
  onClose: () => void
}

type Tab = 'mcp' | 'skills'
type AddMode = 'form' | 'json' | 'mcp-s'

interface EditingServer {
  originalName: string
  name: string
  type: 'http' | 'stdio'
  url: string
  command: string
  args: string
  env: string
  scope: string
  configPath: string
  isNew: boolean
}

export function McpSkillsPanel({ projectPath, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('mcp')
  const [configs, setConfigs] = useState<McpConfigGroup[]>([])
  const [skills, setSkills] = useState<Skill[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<EditingServer | null>(null)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [skillContent, setSkillContent] = useState<{ path: string; content: string } | null>(null)
  const [statuses, setStatuses] = useState<Record<string, 'ok' | 'error' | 'warning' | 'unknown'>>({})
  const [addMode, setAddMode] = useState<AddMode | null>(null)
  const [jsonScope, setJsonScope] = useState<'user' | 'project'>('user')
  const [jsonContent, setJsonContent] = useState('')
  const [jsonPath, setJsonPath] = useState('')
  const [mcpSPaste, setMcpSPaste] = useState('')
  const [mcpSPreview, setMcpSPreview] = useState<string | null>(null)
  const [mcpSWarnings, setMcpSWarnings] = useState<string[]>([])
  const [mcpSMergeScope, setMcpSMergeScope] = useState<'user' | 'project'>('user')

  const refreshStatuses = useCallback(async () => {
    try {
      const result = await window.api.mcpCheckStatus()
      if (result && typeof result === 'object') {
        setStatuses(result)
      }
    } catch (err) {
      console.error('[MCP-PANEL] mcpCheckStatus failed:', err)
    }
  }, [])

  const refresh = useCallback(async () => {
    setLoading(true)
    const [mcpConfigs, skillsList] = await Promise.all([
      window.api.mcpGetConfig(projectPath),
      window.api.skillsList(projectPath),
    ])
    setConfigs(mcpConfigs)
    setSkills(skillsList)
    setLoading(false)
    refreshStatuses()
  }, [projectPath, refreshStatuses])

  useEffect(() => { refresh() }, [refresh])

  // Poll MCP status every 30s while MCP tab is active
  useEffect(() => {
    if (tab !== 'mcp') return
    const interval = setInterval(refreshStatuses, 30000)
    return () => clearInterval(interval)
  }, [tab, refreshStatuses])

  const allServers = configs.flatMap(cfg =>
    Object.entries(cfg.servers).map(([name, server]) => ({
      name,
      scope: cfg.scope,
      configPath: cfg.path,
      type: (server.url ? 'http' : 'stdio') as 'http' | 'stdio',
      url: server.url || '',
      command: server.command || '',
      args: server.args || [],
      env: server.env || {},
    }))
  )

  const handleEdit = useCallback((srv: typeof allServers[0]) => {
    setAddMode('form')
    setEditing({
      originalName: srv.name,
      name: srv.name,
      type: srv.type,
      url: srv.url,
      command: srv.command,
      args: (srv.args || []).join(' '),
      env: Object.entries(srv.env || {}).map(([k, v]) => `${k}=${v}`).join('\n'),
      scope: srv.scope,
      configPath: srv.configPath,
      isNew: false,
    })
  }, [])

  const getConfigPathForScope = useCallback((scope: 'user' | 'project') => {
    return scope === 'user'
      ? (configs.find(c => c.scope === 'user')?.path ?? '')
      : (configs.find(c => c.scope === 'project')?.path ?? `${projectPath}/.mcp.json`)
  }, [configs, projectPath])

  const handleAddNew = useCallback((scope: 'user' | 'project') => {
    setAddMode('form')
    const configPath = getConfigPathForScope(scope)
    setEditing({
      originalName: '',
      name: '',
      type: 'stdio',
      url: '',
      command: 'npx',
      args: '-y @package/name',
      env: '',
      scope,
      configPath,
      isNew: true,
    })
  }, [getConfigPathForScope])

  const openJsonEditor = useCallback(async (scope: 'user' | 'project') => {
    setAddMode('json')
    setJsonScope(scope)
    setEditing(null)
    setSaveMsg(null)
    const path = getConfigPathForScope(scope)
    setJsonPath(path)
    const result = await window.api.mcpReadRawFile(path)
    if (result.success && result.content != null) {
      setJsonContent(result.content)
    } else {
      setJsonContent('{\n  "mcpServers": {}\n}\n')
      if (result.error) setSaveMsg(`Error: ${result.error}`)
    }
  }, [getConfigPathForScope])

  const handleSaveJson = useCallback(async () => {
    if (!jsonPath) return
    setSaveMsg(null)
    const result = await window.api.mcpSaveRawFile(jsonPath, jsonContent)
    if (result.success) {
      setSaveMsg('Saved')
      setAddMode(null)
      refresh()
    } else {
      setSaveMsg(`Error: ${result.error}`)
    }
  }, [jsonPath, jsonContent, refresh])

  const openMcpSImport = useCallback(() => {
    setAddMode('mcp-s')
    setEditing(null)
    setMcpSPaste('')
    setMcpSPreview(null)
    setMcpSWarnings([])
    setSaveMsg(null)
  }, [])

  const handleMcpSPreview = useCallback(() => {
    setSaveMsg(null)
    try {
      const { servers, warnings } = importMcpDefinition(mcpSPaste)
      setMcpSPreview(JSON.stringify(servers, null, 2))
      setMcpSWarnings(warnings)
    } catch (err) {
      setMcpSPreview(null)
      setMcpSWarnings([])
      setSaveMsg(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [mcpSPaste])

  const handleMcpSImport = useCallback(async () => {
    setSaveMsg(null)
    try {
      const { servers, warnings } = importMcpDefinition(mcpSPaste)
      const path = getConfigPathForScope(mcpSMergeScope)
      const result = await window.api.mcpMergeServers(path, servers, 'merge')
      if (result.success) {
        setSaveMsg(warnings.length ? `Saved (${warnings.join('; ')})` : 'Imported')
        setAddMode(null)
        refresh()
      } else {
        setSaveMsg(`Error: ${result.error}`)
      }
    } catch (err) {
      setSaveMsg(`Error: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [mcpSPaste, mcpSMergeScope, getConfigPathForScope, refresh])

  const cancelAddMode = useCallback(() => {
    setAddMode(null)
    setMcpSPreview(null)
    setSaveMsg(null)
  }, [])

  const handleSave = useCallback(async () => {
    if (!editing || !editing.name.trim()) return
    setSaveMsg(null)

    const cfg = configs.find(c => c.path === editing.configPath)
    const servers = cfg ? { ...cfg.servers } : {}

    if (!editing.isNew && editing.originalName !== editing.name) {
      delete servers[editing.originalName]
    }

    const serverObj: any = {}
    if (editing.type === 'http') {
      serverObj.type = 'http'
      serverObj.url = editing.url
    } else {
      serverObj.command = editing.command
      serverObj.args = editing.args.trim() ? editing.args.trim().split(/\s+/) : []
      if (editing.env.trim()) {
        serverObj.env = {}
        for (const line of editing.env.split('\n')) {
          const eq = line.indexOf('=')
          if (eq > 0) {
            serverObj.env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
          }
        }
      }
    }

    servers[editing.name.trim()] = serverObj

    const result = await window.api.mcpSaveConfig(editing.configPath, servers)
    if (result.success) {
      setSaveMsg('Saved')
      setEditing(null)
      setAddMode(null)
      refresh()
    } else {
      setSaveMsg(`Error: ${result.error}`)
    }
  }, [editing, configs, refresh])

  const handleDelete = useCallback(async () => {
    if (!editing || editing.isNew) return
    const cfg = configs.find(c => c.path === editing.configPath)
    if (!cfg) return

    const servers = { ...cfg.servers }
    delete servers[editing.originalName]

    const result = await window.api.mcpSaveConfig(editing.configPath, servers)
    if (result.success) {
      setEditing(null)
      refresh()
    }
  }, [editing, configs, refresh])

  const handleViewSkill = useCallback(async (skill: Skill) => {
    const result = await window.api.readFile(skill.path)
    if (result.content) {
      setSkillContent({ path: skill.path, content: result.content })
    }
  }, [])

  return (
    <div className="mcp-panel">
      <div className="mcp-panel-header">
        <div className="mcp-panel-tabs">
          <button
            className={`mcp-panel-tab ${tab === 'mcp' ? 'active' : ''}`}
            onClick={() => { setTab('mcp'); setEditing(null); setSkillContent(null); setAddMode(null) }}
          >
            MCP Servers
          </button>
          <button
            className={`mcp-panel-tab ${tab === 'skills' ? 'active' : ''}`}
            onClick={() => { setTab('skills'); setEditing(null); setSkillContent(null) }}
          >
            Skills & Commands
          </button>
        </div>
        <button className="coach-close-btn" onClick={onClose} title="Close">×</button>
      </div>

      {loading ? (
        <div className="mcp-empty">Loading...</div>
      ) : tab === 'mcp' ? (
        <div className="mcp-content">
          {addMode === 'json' ? (
            <div className="mcp-editor">
              <div className="mcp-editor-title">Edit MCP JSON</div>
              <label className="mcp-label">Config file</label>
              <div className="mcp-type-switch">
                <button type="button" className={`mcp-type-btn ${jsonScope === 'user' ? 'active' : ''}`} onClick={() => openJsonEditor('user')}>User (~/.claude.json)</button>
                <button type="button" className={`mcp-type-btn ${jsonScope === 'project' ? 'active' : ''}`} onClick={() => openJsonEditor('project')}>Project (.mcp.json)</button>
              </div>
              {jsonPath ? <div className="mcp-json-path" title={jsonPath}>{jsonPath}</div> : null}
              <textarea className="mcp-input mcp-json-editor" value={jsonContent} onChange={(e) => setJsonContent(e.target.value)} spellCheck={false} />
              <div className="mcp-editor-actions">
                <button type="button" className="btn btn-sm" onClick={cancelAddMode}>Cancel</button>
                <div style={{ flex: 1 }} />
                <button type="button" className="btn btn-sm btn-primary" onClick={handleSaveJson}>Save JSON</button>
              </div>
              {saveMsg ? <div className={`mcp-save-msg ${saveMsg.startsWith('Error') ? 'error' : ''}`}>{saveMsg}</div> : null}
            </div>
          ) : addMode === 'mcp-s' ? (
            <div className="mcp-editor">
              <div className="mcp-editor-title">Import from MCP-S Connect</div>
              <p className="mcp-hint">Paste a toolkit URL from <a href="https://mcp-s-connect.wewix.net/" target="_blank" rel="noreferrer">mcp-s-connect.wewix.net</a> (e.g. …/toolkits/you@wix.com:premium-de/view), a gateway URL, or JSON with mcpServers.</p>
              <textarea className="mcp-input mcp-textarea" value={mcpSPaste} onChange={(e) => { setMcpSPaste(e.target.value); setMcpSPreview(null) }} placeholder="https://mcp-s-connect.wewix.net/toolkits/you@wix.com:premium-de/view" rows={4} />
              <div className="mcp-editor-actions" style={{ marginTop: 8 }}><button type="button" className="btn btn-sm" onClick={handleMcpSPreview}>Preview</button></div>
              {mcpSPreview ? (<><label className="mcp-label">Will add / merge</label><pre className="mcp-skill-content mcp-preview-json">{mcpSPreview}</pre></>) : null}
              {mcpSWarnings.length > 0 ? <div className="mcp-save-msg">{mcpSWarnings.join('; ')}</div> : null}
              <label className="mcp-label">Save into</label>
              <div className="mcp-type-switch">
                <button type="button" className={`mcp-type-btn ${mcpSMergeScope === 'user' ? 'active' : ''}`} onClick={() => setMcpSMergeScope('user')}>User</button>
                <button type="button" className={`mcp-type-btn ${mcpSMergeScope === 'project' ? 'active' : ''}`} onClick={() => setMcpSMergeScope('project')}>Project</button>
              </div>
              <div className="mcp-editor-actions">
                <button type="button" className="btn btn-sm" onClick={cancelAddMode}>Cancel</button>
                <div style={{ flex: 1 }} />
                <button type="button" className="btn btn-sm btn-primary" onClick={handleMcpSImport} disabled={!mcpSPaste.trim()}>Merge into config</button>
              </div>
              {saveMsg ? <div className={`mcp-save-msg ${saveMsg.startsWith('Error') ? 'error' : ''}`}>{saveMsg}</div> : null}
            </div>
          ) : editing ? (
            <div className="mcp-editor">
              <div className="mcp-editor-title">
                {editing.isNew ? 'Add MCP Server' : `Edit: ${editing.originalName}`}
              </div>

              <label className="mcp-label">Name</label>
              <input
                className="mcp-input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="my-server"
              />

              <label className="mcp-label">Type</label>
              <div className="mcp-type-switch">
                <button
                  className={`mcp-type-btn ${editing.type === 'stdio' ? 'active' : ''}`}
                  onClick={() => setEditing({ ...editing, type: 'stdio' })}
                >
                  Stdio (local)
                </button>
                <button
                  className={`mcp-type-btn ${editing.type === 'http' ? 'active' : ''}`}
                  onClick={() => setEditing({ ...editing, type: 'http' })}
                >
                  HTTP (remote)
                </button>
              </div>

              {editing.type === 'http' ? (
                <>
                  <label className="mcp-label">URL</label>
                  <input
                    className="mcp-input"
                    value={editing.url}
                    onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                    placeholder="https://api.example.com/mcp/"
                  />
                </>
              ) : (
                <>
                  <label className="mcp-label">Command</label>
                  <input
                    className="mcp-input"
                    value={editing.command}
                    onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                    placeholder="npx"
                  />
                  <label className="mcp-label">Arguments <span className="mcp-label-hint">space-separated</span></label>
                  <input
                    className="mcp-input"
                    value={editing.args}
                    onChange={(e) => setEditing({ ...editing, args: e.target.value })}
                    placeholder="-y @package/server-name"
                  />
                  <label className="mcp-label">Environment <span className="mcp-label-hint">KEY=value, one per line</span></label>
                  <textarea
                    className="mcp-input mcp-textarea"
                    value={editing.env}
                    onChange={(e) => setEditing({ ...editing, env: e.target.value })}
                    placeholder="API_KEY=your-key&#10;DEBUG=true"
                    rows={3}
                  />
                </>
              )}

              <label className="mcp-label">Scope</label>
              <div className="mcp-scope-badge">{editing.scope}</div>

              <div className="mcp-editor-actions">
                {!editing.isNew && (
                  <button className="btn btn-sm btn-danger" onClick={handleDelete}>Delete</button>
                )}
                <div style={{ flex: 1 }} />
                <button className="btn btn-sm" onClick={() => { setEditing(null); setAddMode(null) }}>Cancel</button>
                <button
                  className="btn btn-sm btn-primary"
                  onClick={handleSave}
                  disabled={!editing.name.trim()}
                >
                  Save
                </button>
              </div>
              {saveMsg && (
                <div className={`mcp-save-msg ${saveMsg.startsWith('Error') ? 'error' : ''}`}>
                  {saveMsg}
                </div>
              )}
            </div>
          ) : (
            <>
              {allServers.length === 0 ? (
                <div className="mcp-empty">
                  <div style={{ fontSize: 18, marginBottom: 8 }}>&#9881;</div>
                  <div>No MCP servers configured.</div>
                  <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                    Add servers to extend Claude with external tools.
                  </div>
                </div>
              ) : (
                <div className="mcp-list">
                  {allServers.map((srv) => {
                    const status = statuses[srv.name]
                    const statusLabel = status === 'ok' ? 'Connected'
                      : status === 'warning' ? 'Auth needed'
                      : status === 'error' ? 'Failed'
                      : 'Checking...'
                    return (
                      <div key={srv.name + srv.scope} className="mcp-card" onClick={() => handleEdit(srv)}>
                        <div className="mcp-card-row">
                          <span className="mcp-card-name">
                            <span
                              className={`mcp-status-dot ${status || 'checking'}`}
                              title={statusLabel}
                            />
                            {srv.name}
                          </span>
                          <span className="mcp-card-status-group">
                            <span className={`mcp-status-label ${status || 'checking'}`}>{statusLabel}</span>
                            <span className={`mcp-badge ${srv.scope}`}>{srv.scope}</span>
                          </span>
                        </div>
                        <div className="mcp-card-detail">
                          {srv.type === 'http' ? (
                            <span className="mcp-card-type">HTTP &middot; {srv.url}</span>
                          ) : (
                            <span className="mcp-card-type">
                              {srv.command} {srv.args.join(' ')}
                            </span>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="mcp-add-row">
                <button className="btn btn-sm" onClick={refreshStatuses} title="Refresh status">
                  Refresh
                </button>
                <div style={{ flex: 1 }} />
                <button type="button" className="btn btn-sm" onClick={() => openJsonEditor('user')}>
                  Edit JSON
                </button>
                <button type="button" className="btn btn-sm" onClick={openMcpSImport}>
                  MCP-S Connect
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => handleAddNew('project')}>
                  + Project
                </button>
                <button type="button" className="btn btn-sm" onClick={() => handleAddNew('user')}>
                  + User
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="mcp-content">
          {skillContent ? (
            <div className="mcp-skill-view">
              <div className="mcp-editor-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="btn btn-sm" onClick={() => setSkillContent(null)}>← Back</button>
                <span>{skillContent.path.split('/').pop()}</span>
              </div>
              <pre className="mcp-skill-content">{skillContent.content}</pre>
            </div>
          ) : skills.length === 0 ? (
            <div className="mcp-empty">
              <div style={{ fontSize: 18, marginBottom: 8 }}>&#9733;</div>
              <div>No skills or custom commands found.</div>
              <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                Add .md files to .claude/commands/ or create skills in .claude/skills/
              </div>
            </div>
          ) : (
            <div className="mcp-list">
              {skills.map((skill) => (
                <div
                  key={skill.name + skill.scope}
                  className="mcp-card"
                  onClick={() => handleViewSkill(skill)}
                >
                  <div className="mcp-card-row">
                    <span className="mcp-card-name">{skill.name}</span>
                    <span className={`mcp-badge ${skill.scope}`}>{skill.scope}</span>
                  </div>
                  {skill.description && (
                    <div className="mcp-card-detail">{skill.description.slice(0, 120)}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
