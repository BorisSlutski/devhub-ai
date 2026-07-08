import React, { useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react'
import { sql, StandardSQL } from '@codemirror/lang-sql'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import './DbWorkbenchView.css'
import { DbSessionWorkspacePanel } from './DbSessionWorkspacePanel'
import { StatusDot } from './StatusDot'

/* ── Local Types ── */

interface QueryResult {
  columns: { name: string; type: string }[]
  rows: any[][]
  rowCount: number
  affectedRows: number
  executionTimeMs: number
  error?: string
  truncated?: boolean
}

interface TableInfo {
  name: string
  type: 'TABLE' | 'VIEW'
  engine: string | null
  rows: number | null
  comment: string
}

interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  key: string
  defaultValue: string | null
  extra: string
}

const QUERY_CLIENT_TIMEOUT_MS = 95_000
const CANCEL_CLIENT_TIMEOUT_MS = 30_000
const TABLE_PREVIEW_LIMIT = 25
const RESULTS_DISPLAY_CAP = 250
const TABLES_FETCH_TIMEOUT_MS = 50_000

interface TrinoSessionWorkspace {
  tables: TableInfo[]
  tablesLoading: boolean
  tablesError: string | null
  expandedTable: string | null
  tableColumns: Record<string, ColumnInfo[]>
  columnsLoading: string | null
  columnsError: Record<string, string>
  query: string
  result: QueryResult | null
  queryRunning: boolean
  activeResultTab: 'results' | 'messages'
  messages: string[]
}

interface TrinoSession {
  id: string
  connectionId: string
  server: string
  catalog: string
  schema: string
  user: string
  label: string
  connected: boolean
  workspace: TrinoSessionWorkspace
}

function createEmptyWorkspace(): TrinoSessionWorkspace {
  return {
    tables: [],
    tablesLoading: false,
    tablesError: null,
    expandedTable: null,
    tableColumns: {},
    columnsLoading: null,
    columnsError: {},
    query: '',
    result: null,
    queryRunning: false,
    activeResultTab: 'results',
    messages: [],
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function renderCellValue(value: unknown) {
  if (value === null || value === undefined) return <span className="dbw-null">NULL</span>
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

interface ConnectFormState {
  server: string
  catalog: string
  schema: string
  user: string
  password: string
}

const EMPTY_FORM: ConnectFormState = { server: '', catalog: '', schema: '', user: '', password: '' }
const LAST_CONNECTION_STORAGE_KEY = 'devhub-ai-trino-last-connection'

function loadLastConnection(): Pick<ConnectFormState, 'server' | 'catalog' | 'schema' | 'user'> | null {
  try {
    const raw = localStorage.getItem(LAST_CONNECTION_STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveLastConnection(form: Pick<ConnectFormState, 'server' | 'catalog' | 'schema' | 'user'>): void {
  try {
    localStorage.setItem(LAST_CONNECTION_STORAGE_KEY, JSON.stringify(form))
  } catch {
    // best effort — non-critical convenience feature
  }
}

/* ── Component ── */

export function TrinoWorkbenchView() {
  const [sessions, setSessions] = useState<TrinoSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [showConnectForm, setShowConnectForm] = useState(false)
  const [form, setForm] = useState<ConnectFormState>(EMPTY_FORM)
  const [presets, setPresets] = useState<{ label: string; server: string }[]>([])
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)

  const runQueryRef = useRef<(sessionId: string, sqlOverride?: string) => void>(() => {})
  const fetchTablesRef = useRef<(sessionId: string, forceRefresh?: boolean) => void>(() => {})
  const queryRunIdRef = useRef(0)
  const sessionsRef = useRef<TrinoSession[]>([])
  sessionsRef.current = sessions
  const editorViewRef = useRef<EditorView | null>(null)
  const queryElapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [queryElapsedSec, setQueryElapsedSec] = useState(0)

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )

  useEffect(() => {
    void window.api.trinoServerPresets().then((res) => {
      if (res.success) setPresets(res.presets)
    })
  }, [])

  useEffect(() => {
    if (sessions.length > 0 && !activeSessionId) {
      setActiveSessionId(sessions[sessions.length - 1].id)
    }
  }, [sessions, activeSessionId])

  useEffect(() => {
    return () => {
      if (queryElapsedTimerRef.current) clearInterval(queryElapsedTimerRef.current)
    }
  }, [])

  const stopQueryElapsedTimer = useCallback(() => {
    if (queryElapsedTimerRef.current) {
      clearInterval(queryElapsedTimerRef.current)
      queryElapsedTimerRef.current = null
    }
    setQueryElapsedSec(0)
  }, [])

  const startQueryElapsedTimer = useCallback(() => {
    stopQueryElapsedTimer()
    setQueryElapsedSec(0)
    queryElapsedTimerRef.current = setInterval(() => setQueryElapsedSec((s) => s + 1), 1000)
  }, [stopQueryElapsedTimer])

  const patchSession = useCallback((sessionId: string, patch: Partial<TrinoSessionWorkspace>) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, workspace: { ...s.workspace, ...patch } } : s)),
    )
  }, [])

  const updateSessionWorkspace = useCallback(
    (sessionId: string, fn: (ws: TrinoSessionWorkspace) => Partial<TrinoSessionWorkspace>) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, workspace: { ...s.workspace, ...fn(s.workspace) } } : s)),
      )
    },
    [],
  )

  /* ── Connect / Disconnect ── */

  const openConnectForm = useCallback(() => {
    setConnectError(null)
    const last = loadLastConnection()
    const base = presets.length > 0 ? { ...EMPTY_FORM, server: presets[0].server } : EMPTY_FORM
    setForm(last ? { ...base, ...last, password: '' } : base)
    setShowConnectForm(true)
  }, [presets])

  const handleConnect = useCallback(async () => {
    if (!form.server.trim()) {
      setConnectError('Server is required')
      return
    }
    setConnectError(null)
    setIsConnecting(true)
    const connectionId = `trino-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    try {
      const res = await window.api.trinoConnect(
        connectionId,
        form.server.trim(),
        form.catalog.trim(),
        form.schema.trim(),
        form.user.trim(),
        form.password,
      )
      if (!res.success) {
        setConnectError(res.error ?? 'Connection failed')
        setIsConnecting(false)
        return
      }
      saveLastConnection({
        server: form.server.trim(),
        catalog: form.catalog.trim(),
        schema: form.schema.trim(),
        user: form.user.trim(),
      })
      const newSession: TrinoSession = {
        id: connectionId,
        connectionId,
        server: form.server.trim(),
        catalog: form.catalog.trim(),
        schema: form.schema.trim(),
        user: form.user.trim(),
        label: `${form.catalog || form.server}${form.schema ? `.${form.schema}` : ''}`,
        connected: true,
        workspace: createEmptyWorkspace(),
      }
      if (form.catalog && form.schema) {
        newSession.workspace = { ...newSession.workspace, tablesLoading: true }
      }
      setSessions((prev) => [...prev, newSession])
      setActiveSessionId(newSession.id)
      setShowConnectForm(false)
      setIsConnecting(false)
      if (form.catalog && form.schema) {
        queueMicrotask(() => void fetchTablesRef.current(newSession.id))
      }
    } catch (err) {
      setIsConnecting(false)
      setConnectError(`Connection failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [form])

  const handleDisconnect = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return
      try {
        await window.api.trinoDisconnect(session.connectionId)
      } catch {
        // Best effort
      }
      const next = sessions.filter((s) => s.id !== sessionId)
      setSessions(next)
      if (activeSessionId === sessionId) {
        setActiveSessionId(next[next.length - 1]?.id ?? null)
      }
    },
    [sessions, activeSessionId],
  )

  /* ── Fetch Tables ── */

  const fetchTables = useCallback(
    async (sessionId: string, forceRefresh = false) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return
      if (!session.catalog || !session.schema) {
        patchSession(sessionId, {
          tablesLoading: false,
          tablesError: 'No catalog/schema set on this connection.',
        })
        return
      }

      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, workspace: { ...s.workspace, tablesLoading: true, tablesError: null } } : s)),
      )

      try {
        const res = await Promise.race([
          window.api.trinoListTables(session.connectionId, session.catalog, session.schema),
          new Promise<{ success: false; tables: []; error: string }>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Timed out after ${TABLES_FETCH_TIMEOUT_MS / 1000}s`)),
              TABLES_FETCH_TIMEOUT_MS,
            )
          }),
        ])
        if (!res.success) {
          patchSession(sessionId, { tablesLoading: false, tablesError: res.error ?? 'Failed to load tables' })
        } else {
          patchSession(sessionId, { tables: res.tables ?? [], tablesLoading: false, tablesError: null })
        }
      } catch (err) {
        patchSession(sessionId, {
          tablesLoading: false,
          tablesError: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [patchSession],
  )

  fetchTablesRef.current = fetchTables

  const selectSessionTab = useCallback((sessionId: string) => {
    startTransition(() => setActiveSessionId(sessionId))
  }, [])

  /* ── Expand Table (describe) ── */

  const fetchTableColumnsForSession = useCallback(
    async (sessionId: string, connectionId: string, tableName: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      try {
        const res = await window.api.trinoDescribeTable(
          connectionId,
          tableName,
          session?.catalog,
          session?.schema,
        )
        if (!res.success) {
          const errMsg = res.error ?? 'Unknown error'
          updateSessionWorkspace(sessionId, (w) => ({
            columnsLoading: w.columnsLoading === tableName ? null : w.columnsLoading,
            columnsError: { ...w.columnsError, [tableName]: errMsg },
          }))
        } else {
          updateSessionWorkspace(sessionId, (w) => {
            const { [tableName]: _removed, ...restErrors } = w.columnsError
            return {
              columnsLoading: w.columnsLoading === tableName ? null : w.columnsLoading,
              tableColumns: { ...w.tableColumns, [tableName]: res.columns ?? [] },
              columnsError: restErrors,
            }
          })
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        updateSessionWorkspace(sessionId, (w) => ({
          columnsLoading: w.columnsLoading === tableName ? null : w.columnsLoading,
          columnsError: { ...w.columnsError, [tableName]: errMsg },
        }))
      }
    },
    [updateSessionWorkspace],
  )

  const toggleTableForSession = useCallback(
    async (sessionId: string, tableName: string) => {
      let connectionId: string | null = null
      let skipFetch = true
      setSessions((prev) => {
        const session = prev.find((s) => s.id === sessionId)
        if (!session) return prev
        connectionId = session.connectionId
        if (session.workspace.expandedTable === tableName) {
          return prev.map((s) => (s.id === sessionId ? { ...s, workspace: { ...s.workspace, expandedTable: null } } : s))
        }
        if (session.workspace.tableColumns[tableName]) {
          return prev.map((s) => (s.id === sessionId ? { ...s, workspace: { ...s.workspace, expandedTable: tableName } } : s))
        }
        skipFetch = false
        return prev.map((s) =>
          s.id === sessionId
            ? { ...s, workspace: { ...s.workspace, expandedTable: tableName, columnsLoading: tableName } }
            : s,
        )
      })
      if (!connectionId || skipFetch) return
      void fetchTableColumnsForSession(sessionId, connectionId, tableName)
    },
    [fetchTableColumnsForSession],
  )

  const retryColumnsForSession = useCallback(
    (sessionId: string, tableName: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return
      patchSession(sessionId, { expandedTable: tableName })
      void fetchTableColumnsForSession(sessionId, session.connectionId, tableName)
    },
    [fetchTableColumnsForSession, patchSession],
  )

  const handleTableClickForSession = useCallback(
    (sessionId: string, tableName: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (session?.workspace.queryRunning) {
        updateSessionWorkspace(sessionId, (w) => ({
          messages: [...w.messages, 'A query is still running — Cancel or wait.'],
          activeResultTab: 'messages',
        }))
        return
      }
      const qualified = session ? `${session.catalog}.${session.schema}.${tableName}` : tableName
      const previewSql = `SELECT * FROM ${qualified} LIMIT ${TABLE_PREVIEW_LIMIT};`
      patchSession(sessionId, { query: previewSql, expandedTable: tableName })
      if (session) void fetchTableColumnsForSession(sessionId, session.connectionId, tableName)
      void runQueryRef.current(sessionId, previewSql)
    },
    [patchSession, updateSessionWorkspace, fetchTableColumnsForSession],
  )

  /* ── Run Query ── */

  const runQueryForSession = useCallback(
    async (sessionId: string, sqlOverride?: string) => {
      let connectionId: string | null = null
      let statement = ''
      let skippedBecauseRunning = false
      const runId = ++queryRunIdRef.current
      setSessions((prev) => {
        const session = prev.find((s) => s.id === sessionId)
        if (!session) return prev
        connectionId = session.connectionId
        statement = (sqlOverride ?? session.workspace.query).trim()
        if (!statement || session.workspace.queryRunning) {
          if (statement && session.workspace.queryRunning) skippedBecauseRunning = true
          connectionId = null
          return prev
        }
        return prev.map((s) =>
          s.id === sessionId
            ? { ...s, workspace: { ...s.workspace, queryRunning: true, result: null, activeResultTab: 'results' } }
            : s,
        )
      })
      if (!connectionId || !statement) {
        if (skippedBecauseRunning) {
          updateSessionWorkspace(sessionId, (w) => ({
            messages: [...w.messages, 'A query is still running — Cancel or wait.'],
            activeResultTab: 'messages',
          }))
        }
        return
      }

      startQueryElapsedTimer()
      try {
        const res = await Promise.race([
          window.api.trinoExecuteQuery(connectionId, statement),
          new Promise<QueryResult>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Query timed out after ${QUERY_CLIENT_TIMEOUT_MS / 1000}s`)),
              QUERY_CLIENT_TIMEOUT_MS,
            )
          }),
        ])
        if (runId !== queryRunIdRef.current) return
        stopQueryElapsedTimer()
        if (res.error) {
          updateSessionWorkspace(sessionId, (w) => ({
            queryRunning: false,
            result: res,
            messages: [...w.messages, `Error: ${res.error}`],
            activeResultTab: 'messages',
          }))
        } else {
          const notes: string[] = []
          if (res.truncated) notes.push('Showing first 10,000 rows (more may exist — add a narrower WHERE or LIMIT).')
          updateSessionWorkspace(sessionId, (w) => ({
            queryRunning: false,
            result: res,
            messages: notes.length > 0 ? [...w.messages, ...notes] : w.messages,
          }))
        }
      } catch (err) {
        if (runId !== queryRunIdRef.current) return
        stopQueryElapsedTimer()
        const errMsg = err instanceof Error ? err.message : String(err)
        updateSessionWorkspace(sessionId, (w) => ({
          queryRunning: false,
          result: null,
          messages: [...w.messages, `Query failed: ${errMsg}`],
          activeResultTab: 'messages',
        }))
      } finally {
        if (runId !== queryRunIdRef.current) {
          updateSessionWorkspace(sessionId, (w) => (w.queryRunning ? { queryRunning: false } : {}))
        }
      }
    },
    [updateSessionWorkspace, startQueryElapsedTimer, stopQueryElapsedTimer],
  )

  runQueryRef.current = runQueryForSession

  const cancelQueryForSession = useCallback(
    async (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session?.workspace.queryRunning) return
      const connectionId = session.connectionId
      queryRunIdRef.current += 1
      stopQueryElapsedTimer()
      updateSessionWorkspace(sessionId, () => ({ queryRunning: false }))
      try {
        const res = await Promise.race([
          window.api.trinoCancelQuery(connectionId),
          new Promise<{ success: boolean; error?: string }>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Cancel timed out after ${CANCEL_CLIENT_TIMEOUT_MS / 1000}s`)),
              CANCEL_CLIENT_TIMEOUT_MS,
            )
          }),
        ])
        updateSessionWorkspace(sessionId, (w) => ({
          messages: [...w.messages, res.success ? 'Query cancelled.' : `Cancel failed: ${res.error ?? 'Unknown error'}`],
          activeResultTab: 'messages',
        }))
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        updateSessionWorkspace(sessionId, (w) => ({
          messages: [...w.messages, `Cancel failed: ${errMsg}`],
          activeResultTab: 'messages',
        }))
      }
    },
    [stopQueryElapsedTimer, updateSessionWorkspace],
  )

  const cmExtensions = useMemo(
    () => [
      sql({ dialect: StandardSQL }),
      EditorView.theme({
        '&': { backgroundColor: 'var(--bg-primary)', fontSize: '13px' },
        '.cm-content': { fontFamily: "'SF Mono', 'Menlo', monospace" },
        '.cm-gutters': {
          backgroundColor: 'var(--bg-secondary)',
          borderRight: '1px solid var(--border)',
          color: 'var(--text-muted)',
        },
        '.cm-activeLine': { backgroundColor: 'rgba(88,166,255,0.06)' },
        '.cm-activeLineGutter': { backgroundColor: 'rgba(88,166,255,0.08)' },
        '.cm-cursor': { borderLeftColor: 'var(--accent)' },
        '.cm-selectionBackground': { backgroundColor: 'rgba(88,166,255,0.18) !important' },
      }),
      EditorView.updateListener.of((update) => {
        if (update.view) editorViewRef.current = update.view
      }),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              const { from, to } = view.state.selection.main
              const selected = view.state.sliceDoc(from, to).trim()
              if (activeSessionId) runQueryRef.current(activeSessionId, selected || undefined)
              return true
            },
          },
        ]),
      ),
    ],
    [activeSessionId],
  )

  function renderConnectForm() {
    return (
      <div className="modal-overlay" onClick={() => setShowConnectForm(false)}>
        <div className="dbw-picker-modal" onClick={(e) => e.stopPropagation()}>
          <h2>Connect to Trino</h2>

          {connectError && (
            <div className="dbw-error-banner" style={{ margin: '0 0 8px' }}>
              <span className="dbw-error-icon">!</span>
              <span>{connectError}</span>
            </div>
          )}

          <label className="dbw-picker-filter" style={{ display: 'block', marginBottom: 8 }}>
            <span>Server</span>
            <input
              className="form-input"
              list="trino-server-presets"
              value={form.server}
              onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))}
              placeholder="https://trino.wixprod.net:443"
            />
            <datalist id="trino-server-presets">
              {presets.map((p) => (
                <option key={p.server} value={p.server}>
                  {p.label}
                </option>
              ))}
            </datalist>
          </label>

          <label className="dbw-picker-filter" style={{ display: 'block', marginBottom: 8 }}>
            <span>Catalog</span>
            <input
              className="form-input"
              value={form.catalog}
              onChange={(e) => setForm((f) => ({ ...f, catalog: e.target.value }))}
              placeholder="e.g. hive"
            />
          </label>

          <label className="dbw-picker-filter" style={{ display: 'block', marginBottom: 8 }}>
            <span>Schema</span>
            <input
              className="form-input"
              value={form.schema}
              onChange={(e) => setForm((f) => ({ ...f, schema: e.target.value }))}
              placeholder="e.g. default"
            />
          </label>

          <label className="dbw-picker-filter" style={{ display: 'block', marginBottom: 8 }}>
            <span>Username</span>
            <input
              className="form-input"
              value={form.user}
              onChange={(e) => setForm((f) => ({ ...f, user: e.target.value }))}
              placeholder="you@wix.com"
            />
          </label>

          <label className="dbw-picker-filter" style={{ display: 'block', marginBottom: 8 }}>
            <span>Password</span>
            <input
              className="form-input"
              type="password"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </label>

          <div className="modal-actions">
            <button className="btn" onClick={() => setShowConnectForm(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" disabled={isConnecting} onClick={() => void handleConnect()}>
              {isConnecting ? 'Connecting...' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ── Render: Not Connected ── */

  if (sessions.length === 0) {
    return (
      <div className="dbw-view">
        <div className="dbw-toolbar">
          <h2 className="dbw-title">Trino Workbench</h2>
        </div>

        <div className="dbw-welcome">
          {connectError && !showConnectForm && (
            <div className="dbw-error-banner">
              <span className="dbw-error-icon">!</span>
              <span>{connectError}</span>
              <button className="dbw-error-dismiss" onClick={() => setConnectError(null)}>
                Dismiss
              </button>
            </div>
          )}
          <div className="dbw-welcome-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
              <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
          </div>
          <h3 className="dbw-welcome-title">Connect to Trino</h3>
          <p className="dbw-welcome-desc">
            Run SQL against a Trino coordinator directly over HTTPS — no SSH tunnel required.
          </p>
          <button className="btn btn-primary" onClick={openConnectForm}>
            Connect to Trino
          </button>
        </div>

        {showConnectForm && renderConnectForm()}
      </div>
    )
  }

  /* ── Render: Connected ── */

  return (
    <div className="dbw-view">
      <div className="dbw-toolbar">
        <div className="dbw-toolbar-left">
          <button className="btn btn-sm" type="button" onClick={openConnectForm}>
            + Add connection
          </button>
          {activeSession && <span className="dbw-conn-label">{activeSession.label}</span>}
          <span className="dbw-conn-status">
            <StatusDot
              status={activeSession?.workspace.queryRunning ? 'running' : 'idle'}
              title={activeSession?.workspace.queryRunning ? 'Query running' : 'Connected'}
            />
            {sessions.length} connected
          </span>
        </div>
        <div className="dbw-toolbar-right">
          {activeSessionId && activeSession && (
            <>
              <button className="btn btn-sm btn-danger" type="button" onClick={() => void handleDisconnect(activeSessionId)}>
                Disconnect
              </button>
              <button className="btn btn-sm" type="button" onClick={() => void fetchTables(activeSessionId, true)}>
                Refresh
              </button>
            </>
          )}
        </div>
      </div>

      {connectError && (
        <div className="dbw-error-banner">
          <span className="dbw-error-icon">!</span>
          <span>{connectError}</span>
          <button type="button" className="dbw-error-dismiss" onClick={() => setConnectError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showConnectForm && renderConnectForm()}

      <div className="dbw-main">
        <div className="dbw-session-tabs" role="tablist" aria-label="Trino connections">
          {sessions.map((s) => (
            <div key={s.id} className="dbw-session-tab-wrap">
              <button
                type="button"
                role="tab"
                aria-selected={s.id === activeSessionId}
                className={`dbw-session-tab ${s.id === activeSessionId ? 'active' : ''}`}
                onClick={() => selectSessionTab(s.id)}
                title={s.label}
              >
                <span className="dbw-session-tab-label">{s.catalog || s.server}</span>
                <span className="dbw-session-tab-sub">{s.schema}</span>
              </button>
              <button
                type="button"
                className="dbw-session-tab-close"
                onClick={() => void handleDisconnect(s.id)}
                title={`Disconnect ${s.label}`}
                aria-label={`Disconnect ${s.label}`}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" className="dbw-session-tab dbw-session-tab-add" onClick={openConnectForm} title="Add connection">
            +
          </button>
        </div>

        <div className="dbw-workspace">
          {sessions.map((s) => (
            <DbSessionWorkspacePanel
              key={s.id}
              sessionId={s.id}
              dbName={s.catalog ? `${s.catalog}.${s.schema}` : s.server}
              workspace={s.workspace}
              isActive={s.id === activeSessionId}
              queryElapsedSec={s.id === activeSessionId ? queryElapsedSec : 0}
              tablePreviewLimit={TABLE_PREVIEW_LIMIT}
              resultsDisplayCap={RESULTS_DISPLAY_CAP}
              cmExtensions={cmExtensions}
              formatMs={formatMs}
              renderCellValue={renderCellValue}
              onQueryChange={(query) => patchSession(s.id, { query })}
              onRunQuery={(sqlOverride) => void runQueryForSession(s.id, sqlOverride)}
              onCancelQuery={() => void cancelQueryForSession(s.id)}
              onFetchTables={() => void fetchTables(s.id, true)}
              onToggleTable={(tableName) => void toggleTableForSession(s.id, tableName)}
              onRetryColumns={(tableName) => retryColumnsForSession(s.id, tableName)}
              onTableClick={(tableName) => handleTableClickForSession(s.id, tableName)}
              onActiveResultTab={(tab) => patchSession(s.id, { activeResultTab: tab })}
              onClearMessages={() => patchSession(s.id, { messages: [] })}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
