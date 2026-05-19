import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { SessionSplitPane } from './split-pane'
import { FileExplorer } from './FileExplorer'
import { FileViewer } from './FileViewer'
import { ChangesView } from './ChangesView'
import { SearchView } from './SearchView'
import { BrowserView } from './BrowserView'
import { PipelineView } from './PipelineView'
import { SessionInfoBar } from './SessionInfoBar'
import { ChatInputBar } from './ChatInputBar'
import { McpSkillsPanel } from './McpSkillsPanel'
import { ResourceBadge } from './ResourceBadge'
import { ResourcePanel } from './ResourcePanel'
import { useResourceMonitor } from '../hooks/useResourceMonitor'
import { WorkspaceInitProgress } from './WorkspaceInitProgress'
import { PresetBar, PresetList } from './presets'
import { SummariesPanel } from './SummariesPanel'
import './ClaudeSessionsView.css'

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

interface Session {
  id: string
  folderName: string
  folderPath: string
  worktreePath: string | null
  branchName: string | null
  exited?: boolean
  claudeSessionId?: string | null
  dangerousMode?: boolean
  pendingRecap?: boolean
  title?: string
  initializing?: boolean
}

interface HistoryRecord {
  claudeSessionId: string
  folderName: string
  folderPath: string
  dirName: string
  isWorktree: boolean
  branchHint: string | null
  worktreePath: string | null
  mtime: number
  size: number
  title?: string | null
  keywords?: string[]
  messageCount?: number
}

interface Props {
  sessions: Session[]
  lastCreatedSessionId?: string | null
  rtkEnabled: boolean
  chatInputEnabled: boolean
  scanPath: string
  onNewSession: () => void
  onCloseSession: (sessionId: string) => void
  onResumeSession: (sessionId: string) => void
  onResumeFromHistory: (claudeSessionId: string, folderName: string, folderPath: string, worktreePath?: string | null) => void
  onOpenPipelineSession?: (folderName: string, folderPath: string, worktreePath: string) => void
  onLaunchPreset?: (presetId: string) => void
  /** Fires whenever the set of waiting-for-input session ids changes. */
  onWaitingSessionsChange?: (waitingIds: string[]) => void
}

type SidePanel = 'none' | 'files' | 'file-view' | 'changes' | 'search' | 'browser' | 'pipeline' | 'mcp' | 'history' | 'resources' | 'presets' | 'summaries'

export function ClaudeSessionsView({ sessions, lastCreatedSessionId, rtkEnabled, chatInputEnabled, scanPath, onNewSession, onCloseSession, onResumeSession, onResumeFromHistory, onOpenPipelineSession, onLaunchPreset, onWaitingSessionsChange }: Props) {
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [sidePanel, setSidePanel] = useState<SidePanel>('none')
  const [viewingFile, setViewingFile] = useState<string | null>(null)
  const [viewingLine, setViewingLine] = useState<number | undefined>(undefined)
  const [sideWidth, setSideWidth] = useState(350)
  const [waitingSessions, setWaitingSessions] = useState<Set<string>>(new Set())
  const [rtkDisabledSessions, setRtkDisabledSessions] = useState<Set<string>>(new Set())
  const [rtkAvailable, setRtkAvailable] = useState(false)
  const [sessionTitles, setSessionTitles] = useState<Map<string, string>>(new Map())
  const { snapshot: resourceSnapshot, getSessionMetrics, isLoading: resourceLoading } = useResourceMonitor()
  const dragging = useRef(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const splitPaneToolbarRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!rtkEnabled) { setRtkAvailable(false); return }
    window.api.rtkDetect().then(status => setRtkAvailable(status.installed))
  }, [rtkEnabled])


  const handleToggleRtk = useCallback(async (sessionId: string) => {
    const currentlyDisabled = rtkDisabledSessions.has(sessionId)
    const newDisabled = !currentlyDisabled
    await window.api.rtkSessionToggle(sessionId, newDisabled)
    setRtkDisabledSessions(prev => {
      const next = new Set(prev)
      if (newDisabled) next.add(sessionId)
      else next.delete(sessionId)
      return next
    })
  }, [rtkDisabledSessions])

  const recapSentRef = useRef<Set<string>>(new Set())

  // Bubble the waiting set up to the App so the Claude tab can show an indicator
  useEffect(() => {
    onWaitingSessionsChange?.([...waitingSessions])
  }, [waitingSessions, onWaitingSessionsChange])

  const handleWaitingChange = useCallback((sessionId: string, waiting: boolean) => {
    setWaitingSessions(prev => {
      const next = new Set(prev)
      if (waiting) {
        next.add(sessionId)
      } else {
        next.delete(sessionId)
      }
      return next
    })

    // Auto-send recap prompt when a resumed session becomes idle (ready for input)
    if (waiting && !recapSentRef.current.has(sessionId)) {
      const session = sessions.find(s => s.id === sessionId)
      if (session?.pendingRecap) {
        recapSentRef.current.add(sessionId)
        setTimeout(() => {
          const recapPrompt = 'Give me a brief recap of this conversation: what was the goal, what was done, what\'s the current state, and what are the next steps (if any). Be concise — bullet points are fine.'
          window.api.ptyWrite(sessionId, recapPrompt + '\r')
        }, 500)
      }
    }
  }, [sessions])

  // Auto-switch to a newly created session
  useEffect(() => {
    if (lastCreatedSessionId && sessions.find(s => s.id === lastCreatedSessionId)) {
      setActiveSessionId(lastCreatedSessionId)
    }
  }, [lastCreatedSessionId, sessions])

  useEffect(() => {
    if (sessions.length === 0) {
      setActiveSessionId(null)
      return
    }
    if (activeSessionId && sessions.find(s => s.id === activeSessionId)) return

    // Prefer the persisted active session id (survives restart), then fall back
    // to matching by claudeSessionId, then to the last session.
    let cancelled = false
    const pick = async () => {
      let resolved: string | null = null
      try {
        const savedActiveId = await window.api.activeSessionsGetActiveId()
        if (savedActiveId && sessions.find(s => s.id === savedActiveId)) {
          resolved = savedActiveId
        }
      } catch { /* ignore */ }
      if (!resolved) {
        const savedClaudeId = localStorage.getItem('devhub-ai-last-active-claude-session')
        const preferred = savedClaudeId
          ? sessions.find(s => s.claudeSessionId === savedClaudeId)
          : null
        resolved = preferred?.id ?? sessions[sessions.length - 1].id
      }
      if (!cancelled) setActiveSessionId(resolved)
    }
    pick()
    return () => { cancelled = true }
  }, [sessions, activeSessionId])

  // Track session titles from first user message sent via ChatInputBar
  // (terminal output parsing is unreliable — it captures escape codes and garbage)
  useEffect(() => {
    // Cleanup placeholder — no PTY listener needed; titles come from handleChatSend
    const unsub = () => {}

    return unsub
  }, [sessions])

  const handleSelectSession = useCallback((id: string) => {
    setActiveSessionId(id)
    // Persist the active session — by PTY id (direct lookup across restarts) and by
    // claudeSessionId as a fallback for sessions that were recreated.
    window.api.activeSessionsSetActiveId(id)
    const session = sessions.find(s => s.id === id)
    if (session?.claudeSessionId) {
      localStorage.setItem('devhub-ai-last-active-claude-session', session.claudeSessionId)
    }
    setViewingFile(null)
    if (sidePanel === 'file-view') setSidePanel('files')
  }, [sidePanel, sessions])

  const handleClose = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onCloseSession(sessionId)
  }, [onCloseSession])

  const activeSession = sessions.find(s => s.id === activeSessionId)
  const sessionRoot = activeSession?.worktreePath || activeSession?.folderPath || ''

  const handleFileSelect = useCallback((filePath: string, line?: number) => {
    setViewingFile(filePath)
    setViewingLine(line)
    setSidePanel('file-view')
  }, [])

  const toggleFiles = useCallback(() => {
    setSidePanel(prev => {
      if (prev === 'files' || prev === 'file-view' || prev === 'changes') return 'search'
      if (prev === 'search') return 'none'
      return 'files'
    })
    setViewingFile(null)
  }, [])

  const handleShowChanges = useCallback(() => {
    setSidePanel('changes')
    setViewingFile(null)
  }, [])

  const toggleBrowser = useCallback(() => {
    setSidePanel(prev => prev === 'browser' ? 'none' : 'browser')
    setViewingFile(null)
  }, [])

  const togglePipeline = useCallback(() => {
    setSidePanel(prev => prev === 'pipeline' ? 'none' : 'pipeline')
    setViewingFile(null)
  }, [])


  const toggleMcp = useCallback(() => {
    setSidePanel(prev => prev === 'mcp' ? 'none' : 'mcp')
    setViewingFile(null)
  }, [])

  const toggleResources = useCallback(() => {
    setSidePanel(prev => prev === 'resources' ? 'none' : 'resources')
    setViewingFile(null)
  }, [])

  const togglePresets = useCallback(() => {
    setSidePanel(prev => prev === 'presets' ? 'none' : 'presets')
    setViewingFile(null)
  }, [])

  const toggleSummaries = useCallback(() => {
    setSidePanel(prev => prev === 'summaries' ? 'none' : 'summaries')
    setViewingFile(null)
  }, [])

  const handleLaunchPreset = useCallback((preset: import('../../shared/ipc-types').SessionPreset) => {
    onLaunchPreset?.(preset.id)
  }, [onLaunchPreset])

  // Session history panel
  const [historyRecords, setHistoryRecords] = useState<HistoryRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historySearch, setHistorySearch] = useState('')

  const toggleHistory = useCallback(async () => {
    if (sidePanel === 'history') {
      setSidePanel('none')
      return
    }
    setSidePanel('history')
    setViewingFile(null)
    setHistoryLoading(true)
    try {
      const activeSession = sessions.find(s => s.id === activeSessionId) || sessions[0]
      if (activeSession) {
        const records: HistoryRecord[] = (await window.api.sessionHistoryScan(activeSession.folderPath, activeSession.folderName))
          .map((r: any) => ({
            claudeSessionId: r.claudeSessionId,
            folderName: r.folderName,
            folderPath: r.folderPath,
            dirName: r.dirName,
            isWorktree: r.isWorktree,
            branchHint: r.branchHint,
            worktreePath: r.worktreePath || null,
            mtime: r.mtime,
            size: r.size,
            title: null,
            keywords: [],
            messageCount: 0,
          }))
        setHistoryRecords(records)
        // Load titles + keywords in background
        for (let i = 0; i < Math.min(records.length, 50); i++) {
          const rec = records[i]
          window.api.sessionHistoryTitle(rec.claudeSessionId, rec.dirName)
            .then(info => {
              if (info) {
                setHistoryRecords(prev => prev.map(r =>
                  r.claudeSessionId === rec.claudeSessionId
                    ? { ...r, title: info.title, keywords: info.keywords, messageCount: info.messageCount }
                    : r
                ))
              }
            })
            .catch(() => {})
        }
      } else {
        setHistoryRecords([])
      }
    } catch { setHistoryRecords([]) }
    setHistoryLoading(false)
  }, [sidePanel, sessions, activeSessionId])

  const sessionNameMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of sessions) {
      map.set(s.id, sessionTitles.get(s.id) || s.folderName)
    }
    return map
  }, [sessions, sessionTitles])

  const filteredHistory = useMemo(() => {
    if (!historySearch.trim()) return historyRecords
    const q = historySearch.toLowerCase().trim()
    return historyRecords.filter(r => {
      if (r.title?.toLowerCase().includes(q)) return true
      if (r.keywords?.some(k => k.toLowerCase().includes(q))) return true
      if (r.branchHint?.toLowerCase().includes(q)) return true
      if (r.folderName?.toLowerCase().includes(q)) return true
      if (r.claudeSessionId?.includes(q)) return true
      return false
    })
  }, [historyRecords, historySearch])

  const handleChatSend = useCallback((text: string) => {
    if (!activeSessionId) return
    // Only wrap in bracketed paste if multi-line; otherwise send plain text + \r
    const escaped = text.includes('\n')
      ? `\x1b[200~${text}\x1b[201~`
      : text
    window.api.ptyWrite(activeSessionId, escaped + '\r')

    // Update session title from first non-command message — extract a short summary
    if (!text.startsWith('/') && text.trim().length > 5 && !sessionTitles.has(activeSessionId)) {
      const raw = text.trim()
      // Take the first sentence or line, whichever is shorter
      const firstLine = raw.split('\n')[0].trim()
      const firstSentence = firstLine.split(/[.!?]\s/)[0].trim()
      const short = firstSentence.length < firstLine.length ? firstSentence : firstLine
      const title = short.length > 45 ? short.slice(0, 42) + '...' : short
      setSessionTitles(prev => {
        const next = new Map(prev)
        next.set(activeSessionId, title)
        return next
      })
    }
  }, [activeSessionId, sessionTitles])

  const handleChatImageUpload = useCallback(async (file: File) => {
    if (!activeSessionId) return
    const buffer = await file.arrayBuffer()
    const result = await window.api.saveTempImage({
      name: file.name,
      data: Array.from(new Uint8Array(buffer)),
      sessionId: activeSessionId,
    })
    if (result.path) {
      window.api.ptyWrite(activeSessionId, result.path)
    }
  }, [activeSessionId])

  // Drag resize logic
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    const startX = e.clientX
    const startWidth = sideWidth

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = startX - ev.clientX
      const newWidth = Math.max(200, Math.min(800, startWidth + delta))
      setSideWidth(newWidth)
    }
    const onUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [sideWidth])

  if (sessions.length === 0) {
    return (
      <div className="claude-sessions-empty">
        <div className="claude-sessions-empty-text">
          No active Claude sessions.
        </div>
        <div className="claude-sessions-empty-hint">
          Click "Claude" on any folder in the All Folders tab to start a session,
          or use the button below.
        </div>
        <button className="btn btn-primary" onClick={onNewSession}>
          New Claude Session
        </button>
        <PresetBar
          scanPath={scanPath}
          onLaunchPreset={handleLaunchPreset}
          onShowAllPresets={togglePresets}
        />
      </div>
    )
  }

  return (
    <div className="claude-sessions claude-sessions-horizontal">
      {/* Vertical sidebar */}
      <div className="claude-sessions-sidebar">
        <div className="sidebar-header">
          <span className="sidebar-header-label">Sessions</span>
          <button
            className="sidebar-new-btn"
            onClick={onNewSession}
            title="New Claude session"
          >+</button>
        </div>
        <PresetBar
          scanPath={scanPath}
          onLaunchPreset={handleLaunchPreset}
          onShowAllPresets={togglePresets}
        />
        <div className="sidebar-session-list">
          {sessions.map((session) => {
            const isActive = activeSessionId === session.id
            const isWaiting = waitingSessions.has(session.id) && !session.exited
            const isExited = !!session.exited
            const isInitializing = !!session.initializing
            return (
              <div
                key={session.id}
                className={`sidebar-session-card ${isActive ? 'active' : ''} ${isExited ? 'exited' : ''} ${isWaiting ? 'waiting' : ''}`}
                onClick={() => handleSelectSession(session.id)}
              >
                <div className="sidebar-card-row1">
                  <span className={`sidebar-status-dot ${isExited ? 'exited' : isWaiting ? 'waiting' : 'active'}`} />
                  <span className="sidebar-card-name" title={sessionTitles.get(session.id) || session.folderName}>
                    {sessionTitles.get(session.id) || session.folderName}
                  </span>
                  <button
                    className="sidebar-card-close"
                    onClick={(e) => handleClose(session.id, e)}
                    title="Close session"
                  >
                    ×
                  </button>
                </div>
                {sessionTitles.get(session.id) && (
                  <span className="sidebar-card-project">{session.folderName}</span>
                )}
                {session.branchName && (
                  <div className="sidebar-card-branch">
                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0, opacity: 0.5 }}>
                      <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z"/>
                    </svg>
                    {session.branchName.replace('devhub-ai/claude-', '').slice(0, 20)}
                  </div>
                )}
                <div className="sidebar-card-badges">
                  {!isExited && (
                    <ResourceBadge
                      metrics={getSessionMetrics(session.id)}
                      isLoading={resourceLoading}
                    />
                  )}
                  {isInitializing && (
                    <span className="sidebar-badge-thinking">
                      Setting up
                      <span className="thinking-dots">
                        <span /><span /><span />
                      </span>
                    </span>
                  )}
                  {!isExited && !isWaiting && !isInitializing && (
                    <span className="sidebar-badge-thinking">
                      Thinking
                      <span className="thinking-dots">
                        <span /><span /><span />
                      </span>
                    </span>
                  )}
                  {session.dangerousMode && (
                    <span className="sidebar-badge-unsafe" title="Dangerous mode">UNSAFE</span>
                  )}
                  {isWaiting && (
                    <span className="sidebar-badge-waiting">Waiting</span>
                  )}
                  {isExited && session.claudeSessionId && (
                    <button
                      className="sidebar-badge-resume"
                      onClick={(e) => { e.stopPropagation(); onResumeSession(session.id) }}
                      title="Resume session"
                    >
                      Resume
                    </button>
                  )}
                  {isExited && !session.claudeSessionId && (
                    <span className="sidebar-badge-exited">Ended</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Main area (toolbar + info bar + terminal) */}
      <div className="claude-main-area">
        <div className="claude-toolbar-row">
          <div className="claude-toolbar-icons">
            <button className={`claude-tb-icon ${sidePanel === 'history' ? 'active' : ''}`} onClick={toggleHistory} title="Session History">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM2.5 8a5.5 5.5 0 1 1 11 0 5.5 5.5 0 0 1-11 0zM8 5a.5.5 0 0 1 .5.5V8l2 1a.5.5 0 0 1-.5.87l-2.25-1.25A.5.5 0 0 1 7.5 8V5.5A.5.5 0 0 1 8 5z"/></svg>
            </button>
            <button className={`claude-tb-icon ${sidePanel === 'summaries' ? 'active' : ''}`} onClick={toggleSummaries} title="Session Summaries">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 0h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2zm0 1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H4zm1 2h6v1H5V3zm0 2.5h6v1H5v-1zM5 8h6v1H5V8zm0 2.5h4v1H5v-1z"/></svg>
            </button>
            <button className={`claude-tb-icon ${sidePanel === 'mcp' ? 'active' : ''}`} onClick={toggleMcp} title="MCP & Skills">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M5 1a2 2 0 0 0-2 2v1H2a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h1v4a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9h1a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-1V3a2 2 0 0 0-2-2H5zm0 1h6a1 1 0 0 1 1 1v1H4V3a1 1 0 0 1 1-1zM2 5h12v3H2V5zm3 5h2v1H5v-1zm4 0h2v1H9v-1z"/></svg>
            </button>
            <button className={`claude-tb-icon ${sidePanel === 'resources' ? 'active' : ''}`} onClick={toggleResources} title="Resource Monitor">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1 13V3h1v8.293l3.146-3.147a.5.5 0 0 1 .708 0L8 10.293l4.146-4.147a.5.5 0 0 1 .708.708l-4.5 4.5a.5.5 0 0 1-.708 0L5.5 9.207 2.707 12H5v1H1zm13-10v7h-1V4.707L9.854 7.854a.5.5 0 0 1-.708-.708l3.5-3.5a.5.5 0 0 1 .708 0L14 3z"/></svg>
            </button>
            <span className="claude-tb-sep" />
            <button className={`claude-tb-icon ${sidePanel === 'files' || sidePanel === 'file-view' || sidePanel === 'changes' || sidePanel === 'search' ? 'active' : ''}`} onClick={toggleFiles} title="Files & Search">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 2A1.5 1.5 0 0 0 0 3.5v2h3.5A1.5 1.5 0 0 1 5 7v.5h6V7a1.5 1.5 0 0 1 1.5-1.5H16v-2A1.5 1.5 0 0 0 14.5 2h-5l-1-1h-7zM0 7v5.5A1.5 1.5 0 0 0 1.5 14h13a1.5 1.5 0 0 0 1.5-1.5V7h-3.5a.5.5 0 0 0-.5.5V9H5V7.5a.5.5 0 0 0-.5-.5H0z"/></svg>
            </button>
            <button className={`claude-tb-icon ${sidePanel === 'browser' ? 'active' : ''}`} onClick={toggleBrowser} title="Browser Preview">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8zm8-6.5a6.5 6.5 0 0 0-5.58 3.18L5.5 8l-3.08 3.32A6.5 6.5 0 0 0 8 14.5 6.5 6.5 0 0 0 8 1.5zm.5 1.04V5h3.04A5.51 5.51 0 0 0 8.5 2.54zM12.46 6H8.5v2h4a5.48 5.48 0 0 0 0-2zM12.46 9H8.5v2h3.04a5.48 5.48 0 0 0 .92-2zM8.5 12v2.46A5.51 5.51 0 0 0 11.54 12H8.5z"/></svg>
            </button>
            <button className={`claude-tb-icon ${sidePanel === 'pipeline' ? 'active' : ''}`} onClick={togglePipeline} title="CI Pipeline">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6 2a.5.5 0 0 1 .47.33L10 11.44l1.53-3.82A.5.5 0 0 1 12 7.33h3.5a.5.5 0 0 1 0 1H12.3l-1.83 4.58a.5.5 0 0 1-.94 0L6 3.56l-1.53 3.82A.5.5 0 0 1 4 7.67H.5a.5.5 0 0 1 0-1h3.2L5.53 2.1A.5.5 0 0 1 6 2z"/></svg>
            </button>
            <span className="claude-tb-sep" />
            <div ref={splitPaneToolbarRef} className="claude-toolbar-icons" />
          </div>
        </div>
        {activeSession && (
          <SessionInfoBar
            folderName={activeSession.folderName}
            folderPath={activeSession.folderPath}
            worktreePath={activeSession.worktreePath}
            branchName={activeSession.branchName}
            rtkAvailable={rtkAvailable}
            rtkDisabled={rtkDisabledSessions.has(activeSession.id)}
            onToggleRtk={() => handleToggleRtk(activeSession.id)}
            onShowDiff={handleShowChanges}
            onShowFiles={toggleFiles}
          />
        )}
        <div className="claude-sessions-body" ref={bodyRef}>
          <div className="claude-sessions-terminal">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`claude-session-terminal-wrapper ${chatInputEnabled ? 'with-chat-input' : ''}`}
              style={{ display: activeSessionId === session.id ? 'flex' : 'none', flex: 1, minHeight: 0 }}
            >
              {session.initializing ? (
                <WorkspaceInitProgress
                  sessionId={session.id}
                  onReady={() => {
                    // Progress will transition automatically when pty-create completes
                  }}
                  onCancel={() => onCloseSession(session.id)}
                  onRetry={() => {
                    // Close and re-trigger session creation
                    onCloseSession(session.id)
                    onNewSession()
                  }}
                />
              ) : (
                <>
                  {session.dangerousMode && activeSessionId === session.id && (
                    <div style={{
                      height: 3,
                      background: 'linear-gradient(90deg, #f85149, #da3633)',
                      flexShrink: 0
                    }} title="Dangerous mode — Claude executes commands without asking permission" />
                  )}
                  <SessionSplitPane
                    sessionId={session.id}
                    active={activeSessionId === session.id}
                    onWaitingChange={(waiting) => handleWaitingChange(session.id, waiting)}
                    toolbarRef={splitPaneToolbarRef}
                    onNewSession={onNewSession}
                  />
                  {chatInputEnabled && activeSessionId === session.id && !session.exited && (
                    <ChatInputBar
                      sessionId={session.id}
                      rootPath={session.worktreePath || session.folderPath}
                      onSend={handleChatSend}
                      onImageUpload={handleChatImageUpload}
                      disabled={session.exited}
                    />
                  )}
                  {session.exited && activeSessionId === session.id && (
                    <div className="claude-session-exited-overlay">
                      <div className="claude-session-exited-msg">Session ended</div>
                      {session.claudeSessionId && (
                        <button
                          className="btn btn-primary"
                          onClick={() => onResumeSession(session.id)}
                        >
                          Resume Session
                        </button>
                      )}
                      <button
                        className="btn btn-sm"
                        onClick={() => onCloseSession(session.id)}
                        style={{ marginTop: 8 }}
                      >
                        Close
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
        {sidePanel === 'presets' && (
          <>
            <div className="side-resize-handle" onMouseDown={onDragStart} />
            <div className="claude-sessions-side" style={{ width: sideWidth }}>
              <PresetList
                scanPath={scanPath}
                onLaunchPreset={handleLaunchPreset}
                onClose={() => setSidePanel('none')}
              />
            </div>
          </>
        )}
        {sidePanel !== 'none' && sidePanel !== 'presets' && activeSession && (
          <>
            <div className="side-resize-handle" onMouseDown={onDragStart} />
            <div className="claude-sessions-side" style={{ width: sideWidth }}>
              {sidePanel === 'summaries' ? (
                <SummariesPanel
                  projectName={activeSession.folderName}
                  projectPath={activeSession.worktreePath || activeSession.folderPath}
                  sessionId={activeSession.id}
                  claudeSessionId={activeSession.claudeSessionId ?? null}
                  onClose={() => setSidePanel('none')}
                  onResumeSession={onResumeFromHistory}
                />
              ) : sidePanel === 'resources' ? (
                <ResourcePanel
                  snapshot={resourceSnapshot}
                  isLoading={resourceLoading}
                  sessionNames={sessionNameMap}
                  onClose={() => setSidePanel('none')}
                />
              ) : sidePanel === 'history' ? (
                <div className="mcp-panel">
                  <div className="mcp-panel-header">
                    <div className="mcp-panel-tabs">
                      <span className="mcp-panel-tab active">
                        History ({filteredHistory.length}{historySearch ? ` / ${historyRecords.length}` : ''})
                      </span>
                    </div>
                    <button className="coach-close-btn" onClick={() => setSidePanel('none')} title="Close">×</button>
                  </div>
                  <div className="history-search-wrap">
                    <input
                      className="history-search-input"
                      type="text"
                      placeholder="Search sessions by title, keyword, branch..."
                      value={historySearch}
                      onChange={e => setHistorySearch(e.target.value)}
                      autoFocus
                    />
                    {historySearch && (
                      <button className="history-search-clear" onClick={() => setHistorySearch('')}>×</button>
                    )}
                  </div>
                  <div className="mcp-content">
                    {historyLoading ? (
                      <div className="mcp-empty">Scanning sessions...</div>
                    ) : filteredHistory.length === 0 ? (
                      <div className="mcp-empty">
                        <div style={{ fontSize: 18, marginBottom: 8 }}>&#128337;</div>
                        <div>{historySearch ? 'No sessions match your search.' : 'No sessions found for this project.'}</div>
                        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                          {historySearch
                            ? 'Try different keywords or clear the search.'
                            : 'Conversations from the main branch and worktrees appear here.'}
                        </div>
                      </div>
                    ) : (
                      <div className="mcp-list">
                        {filteredHistory.map((rec) => {
                          const isActive = sessions.some(s => s.claudeSessionId === rec.claudeSessionId && !s.exited)
                          const ago = formatTimeAgo(rec.mtime)
                          const msgCount = rec.messageCount || 0
                          return (
                            <div
                              key={rec.claudeSessionId}
                              className={`mcp-card history-card ${isActive ? 'active-session' : ''}`}
                              onClick={() => {
                                if (!isActive) {
                                  onResumeFromHistory(rec.claudeSessionId, rec.folderName, rec.folderPath, rec.worktreePath)
                                }
                              }}
                              style={{ cursor: isActive ? 'default' : 'pointer' }}
                            >
                              <div className="history-card-title">
                                {rec.title || `Session ${rec.claudeSessionId.slice(0, 8)}`}
                              </div>
                              <div className="history-card-meta">
                                <span>{ago}</span>
                                {msgCount > 0 && <span> · {msgCount} msgs</span>}
                                {rec.branchHint && <span> · {rec.branchHint.slice(0, 25)}</span>}
                                {isActive && <span className="history-badge-active">Active</span>}
                                {!isActive && rec.isWorktree && <span className="history-badge-wt">WT</span>}
                              </div>
                              {rec.keywords && rec.keywords.length > 0 && (
                                <div className="history-card-keywords">
                                  {rec.keywords.slice(0, 5).map(k => (
                                    <span
                                      key={k}
                                      className="history-keyword"
                                      onClick={(e) => { e.stopPropagation(); setHistorySearch(k) }}
                                    >{k}</span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : sidePanel === 'mcp' ? (
                <McpSkillsPanel
                  projectPath={activeSession.worktreePath || activeSession.folderPath}
                  onClose={() => setSidePanel('none')}
                />
              ) : sidePanel === 'pipeline' ? (
                <PipelineView
                  folderName={activeSession.folderName}
                  folderPath={activeSession.folderPath}
                  onClose={() => setSidePanel('none')}
                  onOpenSession={onOpenPipelineSession}
                />
              ) : sidePanel === 'browser' ? (
                <BrowserView
                  sessionId={activeSession.id}
                  onClose={() => setSidePanel('none')}
                />
              ) : sidePanel === 'search' ? (
                <SearchView
                  rootPath={sessionRoot}
                  onFileSelect={handleFileSelect}
                  onClose={() => setSidePanel('none')}
                />
              ) : sidePanel === 'changes' && activeSession.worktreePath ? (
                <ChangesView
                  worktreePath={activeSession.worktreePath}
                  onClose={() => setSidePanel('files')}
                />
              ) : sidePanel === 'file-view' && viewingFile ? (
                <FileViewer
                  filePath={viewingFile}
                  scrollToLine={viewingLine}
                  onClose={() => { setSidePanel('files'); setViewingFile(null); setViewingLine(undefined) }}
                />
              ) : (
                <FileExplorer
                  rootPath={sessionRoot}
                  onFileSelect={handleFileSelect}
                  onShowChanges={handleShowChanges}
                  hasWorktree={!!activeSession.worktreePath}
                />
              )}
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  )
}
