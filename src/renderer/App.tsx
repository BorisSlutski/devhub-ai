import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { useAppState } from './hooks/useAppState'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useGridNavigation } from './hooks/useGridNavigation'
import { useClaudeSessions } from './hooks/useClaudeSessions'
import { Sidebar } from './components/Sidebar'
import { ProjectCard } from './components/ProjectCard'
import { EditProjectModal } from './components/EditProjectModal'
import { LogPanel } from './components/LogPanel'
import { FoldersView } from './components/FoldersView'
import { ClaudeSessionsView } from './components/ClaudeSessionsView'
import { NewSessionModal } from './components/NewSessionModal'
import { ShortcutsHelp } from './components/ShortcutsHelp'
import { SettingsModal } from './components/SettingsModal'
import { Toast } from './components/Toast'
import { AgentsView } from './components/AgentsView'
import { DbWorkbenchView } from './components/DbWorkbenchView'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Skeleton } from './components/Skeleton'
import { Project } from '../shared/types'

type TabId = 'launchpad' | 'folders' | 'claude' | 'agents' | 'db-access'

export function App() {
  const {
    state,
    statuses,
    logs,
    systemRunningMap,
    loaded,
    persist,
    scanWorkspace,
    updateProject,
    removeProject,
    startProject,
    stopProject,
    killSystemPortProcess,
    bulkHideProjects,
    bulkRemoveProjects,
    refreshSystemPorts
  } = useAppState()

  const [activeTab, setActiveTab] = useState<TabId>('launchpad')
  const [search, setSearch] = useState('')
  const [activeFilter, setActiveFilter] = useState('all')
  const [editingProject, setEditingProject] = useState<Project | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [waitingClaudeIds, setWaitingClaudeIds] = useState<string[]>([])
  const hydratedRef = useRef(false)

  const handleWaitingSessionsChange = useCallback((ids: string[]) => {
    setWaitingClaudeIds(prev => (prev.length === ids.length && prev.every((v, i) => v === ids[i]) ? prev : ids))
  }, [])

  // Hydrate activeTab + selectedProjectId once from persisted state
  useEffect(() => {
    if (!loaded || hydratedRef.current) return
    hydratedRef.current = true
    if (state.activeTab) setActiveTab(state.activeTab)
    if (state.selectedProjectId) setSelectedProjectId(state.selectedProjectId)
  }, [loaded, state.activeTab, state.selectedProjectId])

  // Persist navigation state when it changes (after initial hydration)
  useEffect(() => {
    if (!loaded || !hydratedRef.current) return
    if (state.activeTab === activeTab && state.selectedProjectId === selectedProjectId) return
    persist({ ...state, activeTab, selectedProjectId })
  }, [activeTab, selectedProjectId, loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const [scanning, setScanning] = useState(false)
  const [bulkSelection, setBulkSelection] = useState<Set<string>>(new Set())
  const [bulkMode, setBulkMode] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' | 'error' } | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>(() => {
    return (localStorage.getItem('devhub-ai-theme') as 'dark' | 'light' | 'system') || 'dark'
  })

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('devhub-ai-theme', theme)
  }, [theme])

  const {
    sessions: claudeSessions,
    lastCreatedSessionId: lastCreatedClaudeSessionId,
    startSession: handleStartClaudeSession,
    resumeSession: handleResumeClaudeSession,
    openPipelineSession: handleOpenPipelineSession,
    resumeFromHistory: handleResumeFromHistory,
    closeSession: handleCloseClaudeSession,
    launchPreset: handleLaunchPreset,
  } = useClaudeSessions({
    dangerousMode: state.dangerousMode ?? false,
    defaultModel: state.defaultModel,
    onSessionActivated: () => setActiveTab('claude'),
    onNewSessionModalClosed: () => setShowNewSession(false),
  })

  const searchRef = useRef<HTMLInputElement>(null)

  const showToast = useCallback((message: string, type: 'info' | 'success' | 'error' = 'info') => {
    setToast({ message, type })
  }, [])

  // Keyboard shortcuts
  useKeyboardShortcuts({
    onSearch: () => {
      if (activeTab === 'launchpad') {
        searchRef.current?.focus()
      }
    },
    onTab1: () => setActiveTab('launchpad'),
    onTab2: () => setActiveTab('folders'),
    onTab3: () => setActiveTab('claude'),
    onTab4: () => setActiveTab('agents'),
    onEscape: () => {
      // Don't close modals if user is typing in an input inside the modal
      const active = document.activeElement as HTMLElement | null
      const isTypingInModal = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') && active.closest('.modal')
      if (isTypingInModal) {
        (active as HTMLElement).blur()
        return
      }
      if (showHelp) { setShowHelp(false); return }
      if (editingProject) { setEditingProject(null); return }
      if (bulkMode) { setBulkMode(false); setBulkSelection(new Set()); return }
      if (search) { setSearch(''); return }
      searchRef.current?.blur()
    },
    onHelp: () => setShowHelp(true)
  })

  // Branch state: { projectId -> { current, branches } }
  const [branchMap, setBranchMap] = useState<Map<string, { current: string | null; branches: string[] }>>(new Map())

  const refreshBranches = useCallback(async (projects?: Project[]) => {
    const list = projects ?? state.projects
    const visible = list.filter(p => !p.hidden)

    // Process in batches of 5 to avoid spawning hundreds of git processes
    const BATCH = 5
    const results: (readonly [string, { current: string | null; branches: string[] }])[] = []
    for (let i = 0; i < visible.length; i += BATCH) {
      const batch = visible.slice(i, i + BATCH)
      const batchResults = await Promise.all(
        batch.map(async (p) => {
          try {
            const info = await window.api.listBranches(p.path)
            return [p.id, info] as const
          } catch {
            return [p.id, { current: null, branches: [] as string[] }] as const
          }
        })
      )
      results.push(...batchResults)
    }
    setBranchMap(new Map(results))
  }, [state.projects])

  useEffect(() => {
    if (loaded && state.projects.length > 0) {
      refreshBranches()
    }
  }, [loaded]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCheckoutBranch = useCallback(async (projectId: string, branch: string) => {
    const project = state.projects.find(p => p.id === projectId)
    if (!project) return
    const result = await window.api.checkoutBranch(project.path, branch)
    if (result.success) {
      setBranchMap(prev => {
        const next = new Map(prev)
        const existing = next.get(projectId)
        next.set(projectId, { current: branch, branches: existing?.branches ?? [branch] })
        return next
      })
      showToast(`Switched to ${branch}`, 'success')
    } else {
      showToast(result.error || 'Failed to switch branch', 'error')
    }
  }, [state.projects, showToast])

  const handleScan = useCallback(async () => {
    console.log('[App] handleScan triggered')
    setScanning(true)
    try {
      const count = await scanWorkspace()
      console.log('[App] handleScan complete — new projects:', count)
      refreshSystemPorts()
      refreshBranches()
      if (count > 0) {
        showToast(`Found ${count} new project${count > 1 ? 's' : ''}`, 'success')
      } else {
        showToast('No new projects found', 'info')
      }
    } catch (err) {
      console.error('[App] handleScan error:', err)
    } finally {
      setScanning(false)
    }
  }, [scanWorkspace, refreshSystemPorts, refreshBranches, showToast])

  const filteredProjects = useMemo(() => {
    let projects = state.projects

    switch (activeFilter) {
      case 'all':
        projects = projects.filter((p) => !p.hidden)
        break
      case 'running':
        projects = projects.filter((p) => statuses.has(p.id))
        break
      case 'system-running':
        projects = projects.filter((p) => systemRunningMap.has(p.id))
        break
      case 'hidden':
        projects = projects.filter((p) => p.hidden)
        break
      case 'untagged':
        projects = projects.filter((p) => !p.hidden && p.tags.length === 0)
        break
      case 'no-command':
        projects = projects.filter((p) => !p.hidden && !p.runCommand)
        break
      default:
        if (activeFilter.startsWith('tag:')) {
          const tag = activeFilter.slice(4)
          projects = projects.filter((p) => !p.hidden && p.tags.includes(tag))
        }
    }

    if (search) {
      const q = search.toLowerCase()
      projects = projects.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.path.toLowerCase().includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)) ||
          p.techStack.some((t) => t.toLowerCase().includes(q))
      )
    }

    return projects
  }, [state.projects, activeFilter, search, statuses, systemRunningMap])

  const runningCount = statuses.size
  const systemRunningCount = systemRunningMap.size
  const noCommandCount = state.projects.filter((p) => !p.hidden && !p.runCommand).length

  const selectedProject = state.projects.find((p) => p.id === selectedProjectId) || null
  const selectedLogs = selectedProjectId ? logs.get(selectedProjectId) || [] : []

  const handleOpenBrowser = (projectId: string) => {
    const project = state.projects.find((p) => p.id === projectId)
    const status = statuses.get(projectId)
    if (status?.port) {
      window.api.openInBrowser(`http://localhost:${status.port}`)
    } else if (project && systemRunningMap.has(project.id)) {
      window.api.openInBrowser(`http://localhost:${systemRunningMap.get(project.id)!.port}`)
    }
  }

  const handleCardClick = (projectId: string) => {
    if (bulkMode) {
      setBulkSelection((prev) => {
        const next = new Set(prev)
        if (next.has(projectId)) next.delete(projectId)
        else next.add(projectId)
        return next
      })
    } else {
      setSelectedProjectId(projectId)
    }
  }

  const { gridProps, focusedIndex } = useGridNavigation({
    itemCount: filteredProjects.length,
    enabled: activeTab === 'launchpad' && !bulkMode,
    onSelect: (index) => handleCardClick(filteredProjects[index].id),
  })

  const handleBulkHide = () => {
    const count = bulkSelection.size
    bulkHideProjects([...bulkSelection])
    setBulkSelection(new Set())
    setBulkMode(false)
    showToast(`Hidden ${count} project${count > 1 ? 's' : ''}`, 'success')
  }

  const handleBulkRemove = () => {
    const count = bulkSelection.size
    bulkRemoveProjects([...bulkSelection])
    setBulkSelection(new Set())
    setBulkMode(false)
    showToast(`Removed ${count} project${count > 1 ? 's' : ''}`, 'success')
  }

  const handleChooseWorkspace = useCallback(async () => {
    const selected = await window.api.selectFolder()
    if (selected) {
      persist({ ...state, scanPath: selected, workspaceChosen: true })
    }
  }, [state, persist])

  const handleAcceptDefault = useCallback(() => {
    persist({ ...state, workspaceChosen: true })
  }, [state, persist])

  if (!loaded) {
    return (
      <div className="skeleton-app-loading">
        <div className="skeleton-titlebar">
          <Skeleton width={80} height={14} />
        </div>
        <div className="skeleton-tabs">
          <Skeleton width={80} height={14} />
          <Skeleton width={80} height={14} />
          <Skeleton width={60} height={14} />
          <Skeleton width={60} height={14} />
        </div>
        <div className="skeleton-body">
          <div className="skeleton-sidebar">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} height={28} style={{ marginBottom: 8 }} />
            ))}
          </div>
          <div className="skeleton-grid">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton-card">
                <Skeleton width="60%" height={16} />
                <Skeleton width="40%" height={12} />
                <Skeleton height={12} />
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <Skeleton width={50} height={18} borderRadius={12} />
                  <Skeleton width={40} height={18} borderRadius={12} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (!state.workspaceChosen && state.projects.length === 0) {
    return (
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        height: '100vh', background: 'var(--bg-primary)', color: 'var(--text-primary)',
        padding: 40, textAlign: 'center', gap: 24,
      }}>
        <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em' }}>
          <span style={{ opacity: 0.4, marginRight: 8 }}>DHAI</span>DevHub-AI
        </div>
        <p style={{ fontSize: 14, color: 'var(--text-secondary)', maxWidth: 420, lineHeight: 1.6 }}>
          Choose the root folder that contains your projects.
          DevHub-AI will scan it for repositories and workspaces.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, width: '100%', maxWidth: 340 }}>
          <button
            className="btn btn-primary"
            onClick={handleChooseWorkspace}
            style={{
              width: '100%', padding: '12px 24px', fontSize: 14, fontWeight: 600,
              borderRadius: 8, cursor: 'pointer',
            }}
          >
            Choose Workspace Folder
          </button>
          {state.scanPath && (
            <button
              className="btn"
              onClick={handleAcceptDefault}
              style={{
                width: '100%', padding: '10px 24px', fontSize: 13,
                background: 'transparent', border: '1px solid var(--border-primary)',
                color: 'var(--text-secondary)', borderRadius: 8, cursor: 'pointer',
              }}
            >
              Use default: {state.scanPath}
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="titlebar">
        <span className="titlebar-logo">DHAI</span>
        DevHub-AI
        <div className="theme-switcher">
          <button className={`theme-btn ${theme === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')} title="Light mode">☀</button>
          <button className={`theme-btn ${theme === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')} title="Dark mode">☾</button>
          <button className={`theme-btn ${theme === 'system' ? 'active' : ''}`} onClick={() => setTheme('system')} title="Auto (system)">◐</button>
          <button
            className="theme-btn"
            onClick={() => setShowSettings(true)}
            title="Settings"
            style={{ marginLeft: 8 }}
          >
            ⚙
          </button>
        </div>
        <span className="titlebar-shortcut-hint" onClick={() => setShowHelp(true)}>
          <kbd>?</kbd> shortcuts
        </span>
      </div>

      <div className="tabs-bar">
        <div
          className={`tab ${activeTab === 'launchpad' ? 'active' : ''}`}
          onClick={() => setActiveTab('launchpad')}
        >
          Launchpad
          {runningCount > 0 && <span style={{ marginLeft: 6, color: 'var(--green)', fontSize: 11 }}>{runningCount}</span>}
        </div>
        <div
          className={`tab ${activeTab === 'folders' ? 'active' : ''}`}
          onClick={() => setActiveTab('folders')}
        >
          All Folders
        </div>
        <div
          className={`tab ${activeTab === 'claude' ? 'active' : ''}`}
          onClick={() => setActiveTab('claude')}
          title={waitingClaudeIds.length > 0 ? `${waitingClaudeIds.length} session(s) waiting for input` : undefined}
        >
          Claude
          {waitingClaudeIds.length > 0 && (
            <span
              className="tab-waiting-dot"
              aria-label={`${waitingClaudeIds.length} waiting`}
            >
              {waitingClaudeIds.length > 1 ? waitingClaudeIds.length : ''}
            </span>
          )}
          {claudeSessions.length > 0 && waitingClaudeIds.length === 0 && (
            <span style={{ marginLeft: 6, color: 'var(--orange)', fontSize: 11 }}>{claudeSessions.length}</span>
          )}
        </div>
        <div
          className={`tab ${activeTab === 'agents' ? 'active' : ''}`}
          onClick={() => setActiveTab('agents')}
        >
          Agents
        </div>
        <div
          className={`tab ${activeTab === 'db-access' ? 'active' : ''}`}
          onClick={() => setActiveTab('db-access')}
        >
          DB Access
        </div>
      </div>

      {/* DB Access is always mounted so connection state survives tab switches */}
      <div style={{
        display: activeTab === 'db-access' ? 'flex' : 'none',
        flex: 1,
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <ErrorBoundary name="DB Access">
          <DbWorkbenchView />
        </ErrorBoundary>
      </div>

      {activeTab === 'db-access' ? null : activeTab === 'agents' ? (
        <ErrorBoundary name="Agents">
          <AgentsView />
        </ErrorBoundary>
      ) : activeTab === 'claude' ? (
        <ErrorBoundary name="Claude Sessions">
          <ClaudeSessionsView
            sessions={claudeSessions}
            lastCreatedSessionId={lastCreatedClaudeSessionId}
            rtkEnabled={state.rtkEnabled ?? false}
            chatInputEnabled={state.chatInputEnabled ?? true}
            scanPath={state.scanPath}
            onNewSession={() => setShowNewSession(true)}
            onCloseSession={handleCloseClaudeSession}
            onResumeSession={handleResumeClaudeSession}
            onResumeFromHistory={handleResumeFromHistory}
            onOpenPipelineSession={handleOpenPipelineSession}
            onLaunchPreset={handleLaunchPreset}
            onWaitingSessionsChange={handleWaitingSessionsChange}
          />
        </ErrorBoundary>
      ) : activeTab === 'folders' ? (
        <ErrorBoundary name="Folders">
          <FoldersView
            scanPath={state.scanPath}
            onStartClaudeSession={(folder, useWorktree) => {
              handleStartClaudeSession(folder, useWorktree)
            }}
          />
        </ErrorBoundary>
      ) : (
        <ErrorBoundary name="Launchpad">
          {state.projects.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-text">No projects yet. Scan your workspace to get started.</div>
              <button className="btn btn-primary" onClick={handleScan} disabled={scanning}>
                {scanning ? 'Scanning...' : 'Scan ~/Workspace'}
              </button>
            </div>
          ) : (
            <>
              <div className="search-bar">
                <input
                  ref={searchRef}
                  className="search-input"
                  placeholder="Search projects...  (Cmd+K)"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <button
                  className={`btn btn-sm ${bulkMode ? 'btn-accent' : ''}`}
                  onClick={() => { setBulkMode(!bulkMode); setBulkSelection(new Set()) }}
                >
                  {bulkMode ? 'Exit Select' : 'Select'}
                </button>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                  {filteredProjects.length} projects
                </span>
              </div>

              {bulkMode && (
                <div className="bulk-bar">
                  <span className="bulk-bar-text">
                    <strong>{bulkSelection.size}</strong> selected
                  </span>
                  <button className="btn btn-sm" onClick={() => setBulkSelection(new Set(filteredProjects.map((p) => p.id)))}>All</button>
                  <button className="btn btn-sm" onClick={() => setBulkSelection(new Set())}>None</button>
                  <div style={{ flex: 1 }} />
                  <button className="btn btn-sm" onClick={handleBulkHide} disabled={bulkSelection.size === 0}>
                    Hide Selected
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={handleBulkRemove} disabled={bulkSelection.size === 0}>
                    Remove Selected
                  </button>
                </div>
              )}

              <div className="app-layout">
                <Sidebar
                  projects={state.projects}
                  tags={state.tags}
                  activeFilter={activeFilter}
                  runningCount={runningCount}
                  systemRunningCount={systemRunningCount}
                  noCommandCount={noCommandCount}
                  onFilterChange={setActiveFilter}
                  onScan={handleScan}
                />
                <div className="main-content">
                  <div className={`projects-grid ${focusedIndex >= 0 ? 'keyboard-active' : ''}`} {...gridProps}>
                    {filteredProjects.length === 0 ? (
                      <div className="empty-state">
                        <div className="empty-state-text">No projects match your filter.</div>
                      </div>
                    ) : (
                      filteredProjects.map((project, index) => (
                        <ProjectCard
                          key={project.id}
                          keyboardFocused={focusedIndex === index}
                          project={project}
                          status={statuses.get(project.id)}
                          systemPortInfo={systemRunningMap.get(project.id)}
                          selected={bulkSelection.has(project.id)}
                          currentBranch={branchMap.get(project.id)?.current ?? null}
                          branches={branchMap.get(project.id)?.branches ?? []}
                          onStart={() => startProject(project)}
                          onStop={() => stopProject(project.id)}
                          onEdit={() => setEditingProject(project)}
                          onRemove={() => { removeProject(project.id); showToast(`Removed ${project.name}`, 'success') }}
                          onSelect={() => handleCardClick(project.id)}
                          onOpenBrowser={() => handleOpenBrowser(project.id)}
                          onKillSystemProcess={(pid) => killSystemPortProcess(pid)}
                          onCheckoutBranch={(branch) => handleCheckoutBranch(project.id, branch)}
                          onStartClaude={() => handleStartClaudeSession({ name: project.name, path: project.path, modifiedAt: '', gitBranch: null }, false)}
                        />
                      ))
                    )}
                  </div>
                  <LogPanel
                    projectName={selectedProject?.name ?? null}
                    logs={selectedLogs}
                  />
                </div>
              </div>
            </>
          )}
        </ErrorBoundary>
      )}

      {editingProject && (
        <EditProjectModal
          project={editingProject}
          onSave={(updated) => {
            updateProject(updated)
            setEditingProject(null)
            showToast(`Saved ${updated.name}`, 'success')
          }}
          onClose={() => setEditingProject(null)}
          onDelete={(id) => {
            removeProject(id)
            setEditingProject(null)
          }}
        />
      )}

      {showNewSession && (
        <NewSessionModal
          scanPath={state.scanPath}
          onStart={handleStartClaudeSession}
          onClose={() => setShowNewSession(false)}
        />
      )}

      {showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)} />}

      {showSettings && (
        <SettingsModal
          currentPath={state.scanPath}
          currentScanDepth={state.scanDepth ?? 50}
          rtkEnabled={state.rtkEnabled ?? false}
          dangerousMode={state.dangerousMode ?? false}
          chatInputEnabled={state.chatInputEnabled ?? true}
          defaultModel={state.defaultModel ?? ''}
          onSave={(newPath, scanDepth, rtkEnabled, dangerousMode, chatInputEnabled, defaultModel) => {
            persist({ ...state, scanPath: newPath, scanDepth, rtkEnabled, dangerousMode, chatInputEnabled, defaultModel })
            setShowSettings(false)
          }}
          onClose={() => setShowSettings(false)}
        />
      )}

      {toast && (
        <Toast
          message={toast.message}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}
    </>
  )
}
