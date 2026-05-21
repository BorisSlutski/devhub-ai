import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql, MySQL } from '@codemirror/lang-sql'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  filterProducers,
  listProducersForBrowse,
  dedupeProducersForBrowse,
  groupProducersByKgb,
  duplicateDbNames,
  shouldShowProducerSubtitle,
} from '../../shared/db-picker'
import './DbWorkbenchView.css'

/* ── Local Types (no shared imports to avoid circular deps) ── */

interface DbProducer {
  name: string
  kgb: string
  producer: string
  dbName: string
  type: 'mysql' | 'mongo'
}

interface QueryResult {
  columns: { name: string; type: string }[]
  rows: any[][]
  rowCount: number
  affectedRows: number
  executionTimeMs: number
  error?: string
  rowCapApplied?: boolean
  truncated?: boolean
}

const QUERY_CLIENT_TIMEOUT_MS = 95_000

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

const TABLES_FETCH_TIMEOUT_MS = 35_000

interface DbSessionWorkspace {
  tables: TableInfo[]
  tablesLoading: boolean
  tablesError: string | null
  expandedTable: string | null
  tableColumns: Record<string, ColumnInfo[]>
  columnsLoading: string | null
  query: string
  result: QueryResult | null
  queryRunning: boolean
  activeResultTab: 'results' | 'messages'
  messages: string[]
}

interface DbSession {
  id: string
  connectionId: string
  tunnelId: string
  kgb: string
  dbName: string
  label: string
  workspace: DbSessionWorkspace
}

function createEmptyWorkspace(): DbSessionWorkspace {
  return {
    tables: [],
    tablesLoading: false,
    tablesError: null,
    expandedTable: null,
    tableColumns: {},
    columnsLoading: null,
    query: '',
    result: null,
    queryRunning: false,
    activeResultTab: 'results',
    messages: [],
  }
}

function createSession(conn: {
  connectionId: string
  tunnelId: string
  kgb: string
  dbName: string
}): DbSession {
  return {
    id: conn.connectionId,
    ...conn,
    label: `${conn.dbName} (${conn.kgb})`,
    workspace: createEmptyWorkspace(),
  }
}

type ConnectPhase =
  | 'idle'
  | 'authenticating'
  | 'tunneling'
  | 'connecting'
  | 'done'

/* ── Helpers ── */

const PHASE_LABELS: Record<ConnectPhase, string> = {
  idle: '',
  authenticating: 'Authenticating with Akeyless...',
  tunneling: 'Opening SSH tunnel...',
  connecting: 'Connecting to MySQL...',
  done: '',
}

/**
 * Extract byte array from a serialized Buffer object.
 * mysql2 Buffers arrive via IPC as either {type:"Buffer",data:[...]} or {"0":n,"1":n,...}.
 * Returns null if the value isn't a recognizable byte buffer.
 */
function bufferToBytes(obj: any): number[] | null {
  if (!obj || typeof obj !== 'object') return null
  // {type:"Buffer", data:[...]}
  if (obj.type === 'Buffer' && Array.isArray(obj.data)) return obj.data
  // {"0":n, "1":n, ...} — numeric-keyed object (16 bytes = GUID, but handle any length)
  const keys = Object.keys(obj)
  if (keys.length >= 1 && keys.every((k) => /^\d+$/.test(k))) {
    const bytes: number[] = []
    for (let i = 0; i < keys.length; i++) {
      const v = obj[String(i)]
      if (typeof v !== 'number' || v < 0 || v > 255) return null
      bytes.push(v)
    }
    return bytes.length > 0 ? bytes : null
  }
  return null
}

/**
 * Format a byte array as a GUID string (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)
 * or plain hex if not exactly 16 bytes.
 */
function formatGuid(bytes: number[]): string {
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0')).join('')
  if (bytes.length === 16) {
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  return hex
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/* ── Component ── */

export function DbWorkbenchView() {
  const [sessions, setSessions] = useState<DbSession[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>('authenticating')
  const [connectError, setConnectError] = useState<string | null>(null)

  const [showPicker, setShowPicker] = useState(false)
  const [producers, setProducers] = useState<DbProducer[]>([])
  const [producersLoading, setProducersLoading] = useState(false)
  const [producerSearch, setProducerSearch] = useState('')
  const [pickerMode, setPickerMode] = useState<'kgb' | 'database'>('kgb')
  const [selectedKgb, setSelectedKgb] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const runQueryRef = useRef<(sqlOverride?: string) => void>(() => {})
  const editorViewRef = useRef<EditorView | null>(null)
  const connectPhaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const queryElapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [queryElapsedSec, setQueryElapsedSec] = useState(0)

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )
  const ws = activeSession?.workspace

  useEffect(() => {
    if (sessions.length > 0 && !activeSessionId) {
      setActiveSessionId(sessions[sessions.length - 1].id)
    }
  }, [sessions, activeSessionId])

  // Restore tabs when the view remounts (e.g. app restart) while main still holds tunnels.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.api.dbListSessions()
      if (cancelled || !res.success || !res.sessions?.length) return
      setSessions((prev) => {
        if (prev.length > 0) return prev
        const restored = res.sessions!.map((s) =>
          createSession({
            connectionId: s.connectionId,
            tunnelId: s.tunnelId,
            kgb: s.kgb,
            dbName: s.dbName,
          }),
        )
        return restored
      })
      setActiveSessionId((prev) => prev ?? res.sessions![res.sessions!.length - 1].connectionId)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const unsubIdle = window.api.onDbIdleDisconnected(({ connectionId }) => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.connectionId !== connectionId)
        setActiveSessionId((activeId) =>
          activeId === connectionId ? (next[next.length - 1]?.id ?? null) : activeId,
        )
        return next
      })
      setConnectError('Connection closed after idle timeout (4 hours). Reconnect to continue.')
    })
    const unsubTunnel =
      typeof window.api.onDbTunnelClosed === 'function'
        ? window.api.onDbTunnelClosed(({ connectionId, reason }) => {
            setSessions((prev) => {
              const next = prev.filter((s) => s.connectionId !== connectionId)
              setActiveSessionId((activeId) =>
                activeId === connectionId ? (next[next.length - 1]?.id ?? null) : activeId,
              )
              return next
            })
            setConnectError(`${reason}. Reconnect to continue.`)
          })
        : () => {}
    return () => {
      unsubIdle()
      unsubTunnel()
    }
  }, [])

  const patchSession = useCallback((sessionId: string, patch: Partial<DbSessionWorkspace>) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === sessionId ? { ...s, workspace: { ...s.workspace, ...patch } } : s,
      ),
    )
  }, [])

  const updateSessionWorkspace = useCallback(
    (
      sessionId: string,
      fn: (ws: DbSessionWorkspace) => Partial<DbSessionWorkspace>,
    ) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, workspace: { ...s.workspace, ...fn(s.workspace) } }
            : s,
        ),
      )
    },
    [],
  )

  useEffect(() => {
    return () => {
      for (const t of connectPhaseTimersRef.current) clearTimeout(t)
      connectPhaseTimersRef.current = []
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
    queryElapsedTimerRef.current = setInterval(() => {
      setQueryElapsedSec((s) => s + 1)
    }, 1000)
  }, [stopQueryElapsedTimer])

  const patchActiveSession = useCallback(
    (patch: Partial<DbSessionWorkspace>) => {
      if (!activeSessionId) return
      patchSession(activeSessionId, patch)
    },
    [activeSessionId, patchSession],
  )

  /* ── Producer Picker ── */

  const loadProducers = useCallback(async (forceRefresh: boolean) => {
    setProducersLoading(true)
    setConnectError(null)
    try {
      const res = await window.api.dbListProducers('mysql', forceRefresh)
      if (!res.success) {
        setConnectError(res.error ?? 'Failed to load databases')
        if (!forceRefresh && producers.length === 0) setProducers([])
      } else {
        setProducers(res.producers ?? [])
        if (res.stale) {
          setConnectError(
            'Using cached database list (Akeyless gateway unavailable). Use Refresh list to retry.',
          )
        }
      }
    } catch (err) {
      setConnectError(`Failed to load databases: ${err instanceof Error ? err.message : String(err)}`)
      if (!forceRefresh && producers.length === 0) setProducers([])
    } finally {
      setProducersLoading(false)
    }
  }, [producers.length])

  const openPicker = useCallback(async () => {
    setShowPicker(true)
    setProducerSearch('')
    setPickerMode('kgb')
    setSelectedKgb(null)
    await loadProducers(false)
  }, [loadProducers])

  useEffect(() => {
    if (showPicker && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [showPicker, producersLoading])

  const kgbTags = useMemo(
    () => [...new Set(producers.map((p) => p.kgb))].sort((a, b) => a.localeCompare(b)),
    [producers],
  )

  const searchActive = producerSearch.trim().length > 0
  const globalSearchMatches = useMemo(
    () => filterProducers(producers, producerSearch),
    [producers, producerSearch],
  )
  const globalSearchGroups = useMemo(
    () => groupProducersByKgb(globalSearchMatches),
    [globalSearchMatches],
  )

  const databaseBrowseList = useMemo(
    () => listProducersForBrowse(producers, producerSearch),
    [producers, producerSearch],
  )
  const databaseBrowseGroups = useMemo(
    () => groupProducersByKgb(databaseBrowseList),
    [databaseBrowseList],
  )
  const databaseBrowseDupes = useMemo(
    () => duplicateDbNames(databaseBrowseList),
    [databaseBrowseList],
  )

  const filteredKgbTags = kgbTags.filter((c) => {
    const q = producerSearch.toLowerCase()
    if (!q) return true
    return c.toLowerCase().includes(q)
  })

  const kgbDatabases = useMemo(() => {
    if (!selectedKgb) return []
    const filtered = producers
      .filter((p) => p.kgb === selectedKgb)
      .filter((p) => {
        const q = producerSearch.toLowerCase()
        if (!q) return true
        return (
          p.dbName.toLowerCase().includes(q) ||
          p.producer.toLowerCase().includes(q)
        )
      })
    return dedupeProducersForBrowse(filtered).sort((a, b) => a.dbName.localeCompare(b.dbName))
  }, [producers, selectedKgb, producerSearch])

  const kgbDupes = useMemo(() => duplicateDbNames(kgbDatabases), [kgbDatabases])

  /* ── Connect / Disconnect ── */

  const handleConnect = useCallback(async (producerName: string) => {
    setShowPicker(false)
    setConnectError(null)
    setIsConnecting(true)
    setConnectPhase('authenticating')

    for (const t of connectPhaseTimersRef.current) clearTimeout(t)
    connectPhaseTimersRef.current = [
      setTimeout(() => setConnectPhase('tunneling'), 5000),
      setTimeout(() => setConnectPhase('connecting'), 12000),
    ]

    const clearPhaseTimers = () => {
      for (const t of connectPhaseTimersRef.current) clearTimeout(t)
      connectPhaseTimersRef.current = []
    }

    try {
      const res = await window.api.dbConnect(producerName)
      clearPhaseTimers()

      if (!res.success || res.error) {
        setIsConnecting(false)
        const errText = res.error ?? 'Connection failed'
        const portExhausted = /No free local ports/i.test(errText)
        setConnectError(
          portExhausted
            ? `${errText} Max ~51 DB tunnels — disconnect a tab first.`
            : errText,
        )
        return
      }

      const newSession = createSession({
        connectionId: res.connectionId!,
        tunnelId: res.tunnelId!,
        kgb: res.kgb!,
        dbName: res.dbName!,
      })
      setSessions((prev) => [...prev, newSession])
      setActiveSessionId(newSession.id)
      setIsConnecting(false)
    } catch (err) {
      clearPhaseTimers()
      setIsConnecting(false)
      const errText = err instanceof Error ? err.message : String(err)
      const portExhausted = /No free local ports/i.test(errText)
      setConnectError(
        portExhausted
          ? `${errText} Max ~51 DB tunnels — disconnect a tab first.`
          : `Connection failed: ${errText}`,
      )
    }
  }, [])

  const handleDisconnect = useCallback(
    async (sessionId: string) => {
      const session = sessions.find((s) => s.id === sessionId)
      if (!session) return
      try {
        await window.api.dbDisconnect(session.connectionId)
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
    async (sessionId: string) => {
      let connectionId: string | null = null
      setSessions((prev) => {
        const session = prev.find((s) => s.id === sessionId)
        connectionId = session?.connectionId ?? null
        return prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                workspace: { ...s.workspace, tablesLoading: true, tablesError: null },
              }
            : s,
        )
      })
      if (!connectionId) {
        patchSession(sessionId, {
          tablesLoading: false,
          tablesError: 'No active connection for this tab',
        })
        return
      }

      const failTables = (errMsg: string) => {
        updateSessionWorkspace(sessionId, (ws) => ({
          tables: [],
          tablesLoading: false,
          tablesError: errMsg,
          messages: [...ws.messages, errMsg],
          activeResultTab: 'messages',
        }))
      }

      try {
        const res = await Promise.race([
          window.api.dbListTables(connectionId),
          new Promise<{ success: false; tables: []; error: string }>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Timed out after ${TABLES_FETCH_TIMEOUT_MS / 1000}s`)),
              TABLES_FETCH_TIMEOUT_MS,
            )
          }),
        ])
        if (!res.success) {
          failTables(res.error ?? 'Unknown error')
        } else {
          patchSession(sessionId, {
            tables: res.tables ?? [],
            tablesLoading: false,
            tablesError: null,
          })
        }
      } catch (err) {
        failTables(err instanceof Error ? err.message : String(err))
      }
    },
    [patchSession, updateSessionWorkspace],
  )

  const activeTablesLength = activeSession?.workspace.tables.length ?? 0
  const activeTablesLoading = activeSession?.workspace.tablesLoading ?? false

  useEffect(() => {
    if (!activeSessionId) return
    if (activeTablesLength > 0 || activeTablesLoading) return
    void fetchTables(activeSessionId)
  }, [activeSessionId, activeTablesLength, activeTablesLoading, fetchTables])

  /* ── Expand Table (describe) ── */

  const toggleTable = useCallback(
    async (tableName: string) => {
      if (!activeSessionId) return
      let connectionId: string | null = null
      let skipFetch = true
      setSessions((prev) => {
        const session = prev.find((s) => s.id === activeSessionId)
        if (!session) return prev
        connectionId = session.connectionId
        if (session.workspace.expandedTable === tableName) {
          skipFetch = true
          return prev.map((s) =>
            s.id === activeSessionId
              ? { ...s, workspace: { ...s.workspace, expandedTable: null } }
              : s,
          )
        }
        if (session.workspace.tableColumns[tableName]) {
          skipFetch = true
          return prev.map((s) =>
            s.id === activeSessionId
              ? { ...s, workspace: { ...s.workspace, expandedTable: tableName } }
              : s,
          )
        }
        skipFetch = false
        return prev.map((s) =>
          s.id === activeSessionId
            ? { ...s, workspace: { ...s.workspace, expandedTable: tableName } }
            : s,
        )
      })
      if (!connectionId || skipFetch) return

      patchActiveSession({ columnsLoading: tableName })
      try {
        const res = await window.api.dbDescribeTable(connectionId, tableName)
        if (!res.success) {
          updateSessionWorkspace(activeSessionId, (w) => ({
            columnsLoading: null,
            messages: [
              ...w.messages,
              `Error describing ${tableName}: ${res.error ?? 'Unknown error'}`,
            ],
            activeResultTab: 'messages',
          }))
        } else {
          updateSessionWorkspace(activeSessionId, (w) => ({
            columnsLoading: null,
            tableColumns: { ...w.tableColumns, [tableName]: res.columns ?? [] },
          }))
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        updateSessionWorkspace(activeSessionId, (w) => ({
          columnsLoading: null,
          messages: [...w.messages, `Error describing ${tableName}: ${errMsg}`],
          activeResultTab: 'messages',
        }))
      }
    },
    [activeSessionId, patchActiveSession, updateSessionWorkspace],
  )

  const handleTableClick = useCallback(
    (tableName: string) => {
      patchActiveSession({ query: `SELECT * FROM \`${tableName}\` LIMIT 100;` })
    },
    [patchActiveSession],
  )

  /* ── Run Query ── */

  const runQuery = useCallback(
    async (sqlOverride?: string) => {
      if (!activeSessionId) return
      let connectionId: string | null = null
      let sql = ''
      setSessions((prev) => {
        const session = prev.find((s) => s.id === activeSessionId)
        if (!session) return prev
        connectionId = session.connectionId
        sql = (sqlOverride ?? session.workspace.query).trim()
        if (!sql || session.workspace.queryRunning) {
          connectionId = null
          return prev
        }
        return prev.map((s) =>
          s.id === activeSessionId
            ? {
                ...s,
                workspace: {
                  ...s.workspace,
                  queryRunning: true,
                  result: null,
                  activeResultTab: 'results',
                },
              }
            : s,
        )
      })
      if (!connectionId || !sql) return

      startQueryElapsedTimer()
      try {
        const res = await Promise.race([
          window.api.dbExecuteQuery(connectionId, sql),
          new Promise<QueryResult>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Query timed out after ${QUERY_CLIENT_TIMEOUT_MS / 1000}s`)),
              QUERY_CLIENT_TIMEOUT_MS,
            )
          }),
        ])
        stopQueryElapsedTimer()
        if (res.error) {
          const msgs = [`Error: ${res.error}`]
          if (/timed out|lost|closed|ECONNRESET/i.test(res.error)) {
            msgs.push('Connection may be dead — disconnect and reconnect.')
          }
          updateSessionWorkspace(activeSessionId, (w) => ({
            queryRunning: false,
            result: res,
            messages: [...w.messages, ...msgs],
            activeResultTab: 'messages',
          }))
          if (/timed out|lost|closed|ECONNRESET/i.test(res.error)) {
            setConnectError('Connection lost or query timed out. Reconnect to continue.')
          }
        } else {
          const notes: string[] = []
          if (res.rowCapApplied) {
            notes.push('Auto-added LIMIT 10001 (query had no LIMIT — avoids slow full table scans over SSH).')
          }
          if (res.truncated) {
            notes.push('Showing first 10,000 rows (more may exist — add a narrower WHERE or LIMIT).')
          }
          updateSessionWorkspace(activeSessionId, (w) => ({
            queryRunning: false,
            result: res,
            messages: notes.length > 0 ? [...w.messages, ...notes] : w.messages,
          }))
        }
      } catch (err) {
        stopQueryElapsedTimer()
        const errMsg = err instanceof Error ? err.message : String(err)
        updateSessionWorkspace(activeSessionId, (w) => ({
          queryRunning: false,
          result: null,
          messages: [...w.messages, `Query failed: ${errMsg}`],
          activeResultTab: 'messages',
        }))

        if (/ECONNRESET|EPIPE|lost|closed|timeout/i.test(errMsg)) {
          setConnectError('Connection lost or query timed out. Reconnect to continue.')
          void handleDisconnect(activeSessionId)
        }
      }
    },
    [
      activeSessionId,
      patchSession,
      updateSessionWorkspace,
      handleDisconnect,
      startQueryElapsedTimer,
      stopQueryElapsedTimer,
    ],
  )

  runQueryRef.current = runQuery

  const cmExtensions = useMemo(
    () => [
      sql({ dialect: MySQL }),
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
              runQueryRef.current(selected || undefined)
              return true
            },
          },
        ]),
      ),
    ],
    [],
  )

  function renderProducerRow(p: DbProducer, dupes: Set<string>, showKgbInSubtitle: boolean) {
    const showSubtitle = shouldShowProducerSubtitle(p, dupes) || showKgbInSubtitle
    return (
      <button
        key={p.name}
        className="dbw-picker-item"
        onClick={() => handleConnect(p.name)}
      >
        <span className="dbw-picker-item-text">
          <span className="dbw-picker-db-name">{p.dbName}</span>
          {showSubtitle && (
            <span className="dbw-picker-db-sub">
              {showKgbInSubtitle ? `${p.kgb} · ${p.producer}` : p.producer}
            </span>
          )}
        </span>
      </button>
    )
  }

  function renderPickerModal() {
    const showingDatabases = pickerMode === 'kgb' && selectedKgb !== null
    const showingGlobalSearch =
      pickerMode === 'kgb' && searchActive && !showingDatabases
    const showingDatabaseBrowse = pickerMode === 'database'
    const globalDupes = duplicateDbNames(globalSearchMatches)

    return (
      <div className="modal-overlay" onClick={() => setShowPicker(false)}>
        <div className="dbw-picker-modal" onClick={(e) => e.stopPropagation()}>
          <h2>
            {showingDatabases ? (
              <>
                <button
                  className="dbw-picker-back"
                  onClick={() => { setSelectedKgb(null); setProducerSearch('') }}
                  title="Back to KGB tags"
                >
                  &#8592;
                </button>
                {selectedKgb}
              </>
            ) : showingGlobalSearch ? (
              'Search Results'
            ) : showingDatabaseBrowse ? (
              'Browse databases'
            ) : (
              'Select KGB tag'
            )}
          </h2>

          <div className="dbw-picker-mode-tabs">
            <button
              type="button"
              className={`dbw-picker-mode-tab ${pickerMode === 'kgb' ? 'active' : ''}`}
              onClick={() => {
                setPickerMode('kgb')
                setSelectedKgb(null)
              }}
            >
              By KGB
            </button>
            <button
              type="button"
              className={`dbw-picker-mode-tab ${pickerMode === 'database' ? 'active' : ''}`}
              onClick={() => {
                setPickerMode('database')
                setSelectedKgb(null)
              }}
            >
              By database
            </button>
          </div>

          <input
            ref={searchInputRef}
            className="form-input dbw-picker-search"
            type="text"
            placeholder={
              showingDatabaseBrowse
                ? 'Search database name, producer, or KGB tag...'
                : showingDatabases
                  ? 'Search databases in this KGB...'
                  : 'Search KGB tags or database names...'
            }
            value={producerSearch}
            onChange={(e) => setProducerSearch(e.target.value)}
          />

          {connectError && (
            <div className="dbw-error-banner" style={{ margin: '0 0 8px' }}>
              <span className="dbw-error-icon">!</span>
              <span>{connectError}</span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={producersLoading}
                onClick={() => void loadProducers(true)}
              >
                Retry
              </button>
            </div>
          )}

          <div className="dbw-picker-toolbar">
            <button
              type="button"
              className="btn btn-sm"
              disabled={producersLoading}
              onClick={() => void loadProducers(true)}
              title="Fetch latest list from Akeyless (can be slow)"
            >
              Refresh list
            </button>
          </div>

          <div className="dbw-picker-list">
            {producersLoading ? (
              <div className="dbw-picker-loading">
                <div className="dbw-connecting-spinner dbw-spinner-sm" />
                <span>Loading available databases...</span>
              </div>
            ) : showingDatabaseBrowse ? (
              databaseBrowseList.length === 0 ? (
                <div className="dbw-picker-empty">
                  {searchActive
                    ? `No results for "${producerSearch}"`
                    : 'No databases available'}
                </div>
              ) : (
                databaseBrowseGroups.map(({ kgb, producers: group }) => (
                  <div key={kgb} className="dbw-picker-group">
                    <div className="dbw-picker-group-label">{kgb}</div>
                    {group.map((p) => renderProducerRow(p, databaseBrowseDupes, true))}
                  </div>
                ))
              )
            ) : showingGlobalSearch ? (
              globalSearchMatches.length === 0 ? (
                <div className="dbw-picker-empty">
                  {`No results for "${producerSearch}"`}
                </div>
              ) : (
                globalSearchGroups.map(({ kgb, producers: group }) => (
                  <div key={kgb} className="dbw-picker-group">
                    <div className="dbw-picker-group-label">{kgb}</div>
                    {group.map((p) => renderProducerRow(p, globalDupes, true))}
                  </div>
                ))
              )
            ) : !showingDatabases ? (
              filteredKgbTags.length === 0 ? (
                <div className="dbw-picker-empty">
                  {kgbTags.length === 0
                    ? 'No KGB tags available'
                    : `No results for "${producerSearch}"`}
                </div>
              ) : (
                filteredKgbTags.map((kgb) => {
                  const count = producers.filter((p) => p.kgb === kgb).length
                  return (
                    <button
                      key={kgb}
                      className="dbw-picker-item"
                      onClick={() => { setSelectedKgb(kgb); setProducerSearch('') }}
                    >
                      <span className="dbw-picker-db-name">{kgb}</span>
                      <span className="dbw-picker-db-count">
                        {count} database{count !== 1 ? 's' : ''}
                      </span>
                    </button>
                  )
                })
              )
            ) : kgbDatabases.length === 0 ? (
              <div className="dbw-picker-empty">
                {`No results for "${producerSearch}"`}
              </div>
            ) : (
              kgbDatabases.map((p) => renderProducerRow(p, kgbDupes, false))
            )}
          </div>

          <div className="modal-actions">
            <button className="btn" onClick={() => setShowPicker(false)}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ── Render: Not Connected ── */

  if (sessions.length === 0 && !isConnecting) {
    return (
      <div className="dbw-view">
        <div className="dbw-toolbar">
          <h2 className="dbw-title">DB Workbench</h2>
        </div>

        <div className="dbw-welcome">
          {connectError && (
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
          <h3 className="dbw-welcome-title">Connect to a Database</h3>
          <p className="dbw-welcome-desc">
            Browse tables, run SQL queries, and explore results in a MySQL Workbench-like interface.
          </p>
          <button className="btn btn-primary" onClick={openPicker}>
            Connect to Database
          </button>
        </div>

        {showPicker && renderPickerModal()}
      </div>
    )
  }

  /* ── Render: Connecting ── */

  if (sessions.length === 0 && isConnecting) {
    return (
      <div className="dbw-view">
        <div className="dbw-toolbar">
          <h2 className="dbw-title">DB Workbench</h2>
        </div>

        <div className="dbw-welcome">
          <div className="dbw-connecting-spinner" />
          <h3 className="dbw-welcome-title">{PHASE_LABELS[connectPhase]}</h3>
          <p className="dbw-welcome-desc">This can take 10-30 seconds depending on Akeyless authentication.</p>

          <div className="dbw-connect-phases">
            <div className={`dbw-phase ${connectPhase === 'authenticating' ? 'active' : connectPhase === 'tunneling' || connectPhase === 'connecting' ? 'done' : ''}`}>
              <span className="dbw-phase-dot" />
              <span>Authenticating with Akeyless</span>
            </div>
            <div className={`dbw-phase ${connectPhase === 'tunneling' ? 'active' : connectPhase === 'connecting' ? 'done' : ''}`}>
              <span className="dbw-phase-dot" />
              <span>Opening SSH tunnel</span>
            </div>
            <div className={`dbw-phase ${connectPhase === 'connecting' ? 'active' : ''}`}>
              <span className="dbw-phase-dot" />
              <span>Connecting to MySQL</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  /* ── Render: Connected ── */


  function renderNullCell() {
    return <span className="dbw-null">NULL</span>
  }

  function renderCellValue(value: any) {
    if (value === null || value === undefined) return renderNullCell()
    if (typeof value === 'object') {
      // mysql2 serializes BINARY/VARBINARY (GUIDs) as {type:"Buffer",data:[...]} or {"0":n,"1":n,...}
      const bytes = bufferToBytes(value)
      if (bytes) return formatGuid(bytes)
      return JSON.stringify(value)
    }
    return String(value)
  }

  return (
    <div className="dbw-view">
      {/* ── Toolbar ── */}
      <div className="dbw-toolbar">
        <div className="dbw-toolbar-left">
          <button className="btn btn-sm" type="button" onClick={openPicker}>
            + Add connection
          </button>
          {activeSession && <span className="dbw-conn-label">{activeSession.label}</span>}
          <span className="dbw-conn-status">
            <span className="dbw-conn-dot" />
            {sessions.length} connected
          </span>
        </div>
        <div className="dbw-toolbar-right">
          {activeSessionId && (
            <>
              <button
                className="btn btn-sm btn-danger"
                type="button"
                onClick={() => void handleDisconnect(activeSessionId)}
              >
                Disconnect
              </button>
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => void fetchTables(activeSessionId)}
              >
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

      {showPicker && renderPickerModal()}

      {isConnecting && (
        <div className="dbw-connecting-overlay">
          <div className="dbw-connecting-card">
            <div className="dbw-connecting-spinner" />
            <span>{PHASE_LABELS[connectPhase]}</span>
          </div>
        </div>
      )}

      <div className="dbw-main">
        <div className="dbw-session-tabs" role="tablist" aria-label="Database connections">
          {sessions.map((s) => (
            <div key={s.id} className="dbw-session-tab-wrap">
              <button
                type="button"
                role="tab"
                aria-selected={s.id === activeSessionId}
                className={`dbw-session-tab ${s.id === activeSessionId ? 'active' : ''}`}
                onClick={() => setActiveSessionId(s.id)}
                title={s.label}
              >
                <span className="dbw-session-tab-label">{s.dbName}</span>
                <span className="dbw-session-tab-sub">{s.kgb}</span>
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
          <button
            type="button"
            className="dbw-session-tab dbw-session-tab-add"
            onClick={openPicker}
            title="Add connection"
          >
            +
          </button>
        </div>

        <div className="dbw-workspace">
        <div className="dbw-sidebar">
          <div className="dbw-sidebar-header">
            <span className="dbw-sidebar-title">{activeSession?.dbName ?? ''}</span>
            <span className="dbw-sidebar-count">
              {ws?.tablesLoading && (ws?.tables.length ?? 0) > 0
                ? 'Refreshing…'
                : `${ws?.tables.length ?? 0} table${(ws?.tables.length ?? 0) !== 1 ? 's' : ''}`}
            </span>
          </div>

          <div className="dbw-sidebar-list">
            {ws?.tablesError ? (
              <div className="dbw-sidebar-error">
                <div>{ws.tablesError}</div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => activeSessionId && void fetchTables(activeSessionId)}
                >
                  Retry
                </button>
              </div>
            ) : ws?.tablesLoading && (ws?.tables.length ?? 0) === 0 ? (
              <div className="dbw-sidebar-loading">Loading tables...</div>
            ) : (ws?.tables.length ?? 0) === 0 ? (
              <div className="dbw-sidebar-empty">
                {ws?.tablesLoading ? 'Loading tables...' : 'No tables found'}
              </div>
            ) : (
              ws!.tables.map((t) => {
                const isExpanded = ws!.expandedTable === t.name
                const cols = ws!.tableColumns[t.name]
                const isLoadingCols = ws!.columnsLoading === t.name

                return (
                  <div key={t.name} className="dbw-table-node">
                    <div className="dbw-table-row">
                      <button
                        className={`dbw-table-expand ${isExpanded ? 'expanded' : ''}`}
                        onClick={() => toggleTable(t.name)}
                        title="Show columns"
                      >
                        &#9656;
                      </button>
                      <button
                        className="dbw-table-name"
                        onClick={() => handleTableClick(t.name)}
                        title={`SELECT * FROM ${t.name} LIMIT 100`}
                      >
                        {t.name}
                      </button>
                      {t.type === 'VIEW' && <span className="dbw-table-badge">VIEW</span>}
                    </div>

                    {isExpanded && (
                      <div className="dbw-columns-list">
                        {isLoadingCols ? (
                          <div className="dbw-col-loading">Loading...</div>
                        ) : cols ? (
                          cols.map((col) => (
                            <div key={col.name} className="dbw-col-row">
                              <span className={`dbw-col-key ${col.key === 'PRI' ? 'pk' : col.key === 'MUL' ? 'idx' : ''}`}>
                                {col.key === 'PRI' ? '\u{1D4C}' : col.key === 'MUL' ? '\u25CB' : '\u2500'}
                              </span>
                              <span className="dbw-col-name">{col.name}</span>
                              <span className="dbw-col-type">{col.type}</span>
                            </div>
                          ))
                        ) : null}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </div>
        </div>

        {/* ── Right Panel ── */}
        <div className="dbw-right">
          {/* ── SQL Editor ── */}
          <div className="dbw-editor-panel">
            <div className="dbw-editor-toolbar">
              <span className="dbw-editor-label">SQL Editor</span>
              <span className="dbw-editor-hint">
                <kbd className="kbd">&#8984;</kbd>
                <span className="kbd-plus">+</span>
                <kbd className="kbd">Enter</kbd>
                <span className="dbw-hint-text">to run</span>
              </span>
              <button
                className="btn btn-sm btn-primary dbw-run-btn"
                type="button"
                onClick={() => void runQuery()}
                disabled={!activeSession || ws?.queryRunning || !ws?.query.trim()}
              >
                {ws?.queryRunning ? 'Running...' : 'Run \u25B6'}
              </button>
            </div>
            <div className="dbw-editor-wrapper">
              <CodeMirror
                value={ws?.query ?? ''}
                onChange={(val) => patchActiveSession({ query: val })}
                extensions={cmExtensions}
                theme="dark"
                height="100%"
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: false,
                  autocompletion: true,
                  highlightActiveLine: true,
                  bracketMatching: true,
                  closeBrackets: true,
                }}
              />
            </div>
          </div>

          {/* ── Results Panel ── */}
          <div className="dbw-results-panel">
            <div className="dbw-results-toolbar">
              <div className="dbw-results-tabs">
                <button
                  type="button"
                  className={`dbw-results-tab ${ws?.activeResultTab === 'results' ? 'active' : ''}`}
                  onClick={() => patchActiveSession({ activeResultTab: 'results' })}
                >
                  Results
                </button>
                <button
                  type="button"
                  className={`dbw-results-tab ${ws?.activeResultTab === 'messages' ? 'active' : ''}`}
                  onClick={() => patchActiveSession({ activeResultTab: 'messages' })}
                >
                  Messages
                  {(ws?.messages.length ?? 0) > 0 && (
                    <span className="dbw-msg-count">{ws!.messages.length}</span>
                  )}
                </button>
              </div>
              {ws?.activeResultTab === 'results' && ws.result && !ws.result.error && (
                <span className="dbw-results-meta">
                  {ws.result.rowCount} row{ws.result.rowCount !== 1 ? 's' : ''}
                  {' \u00B7 '}
                  {formatMs(ws.result.executionTimeMs)}
                  {ws.result.affectedRows > 0 && ` \u00B7 ${ws.result.affectedRows} affected`}
                </span>
              )}
              {ws?.activeResultTab === 'messages' && (ws?.messages.length ?? 0) > 0 && (
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => patchActiveSession({ messages: [] })}
                >
                  Clear
                </button>
              )}
            </div>

            <div className="dbw-results-content">
              {ws?.activeResultTab === 'results' ? (
                ws.queryRunning ? (
                  <div className="dbw-results-loading">
                    <div className="dbw-connecting-spinner dbw-spinner-sm" />
                    <span>
                      Executing query
                      {queryElapsedSec > 0 ? ` (${queryElapsedSec}s)` : '…'}
                    </span>
                    <span className="dbw-results-loading-hint">
                      Over SSH tunnels large scans can take up to 90s. Add LIMIT for faster results.
                    </span>
                  </div>
                ) : ws.result?.error ? (
                  <div className="dbw-results-error">
                    <span className="dbw-error-icon">!</span>
                    <pre>{ws.result.error}</pre>
                  </div>
                ) : ws.result && ws.result.columns.length > 0 ? (
                  <div className="dbw-table-scroll">
                    <table className="dbw-results-table">
                      <thead>
                        <tr>
                          <th className="dbw-row-num">#</th>
                          {ws.result.columns.map((col) => (
                            <th key={col.name}>
                              <span className="dbw-th-name">{col.name}</span>
                              <span className="dbw-th-type">{col.type}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {ws.result.rows.map((row, ri) => (
                          <tr key={ri}>
                            <td className="dbw-row-num">{ri + 1}</td>
                            {row.map((cell, ci) => (
                              <td key={ci}>{renderCellValue(cell)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : ws.result && ws.result.affectedRows > 0 ? (
                  <div className="dbw-results-message-ok">
                    Query OK, {ws.result.affectedRows} row{ws.result.affectedRows !== 1 ? 's' : ''} affected
                    ({formatMs(ws.result.executionTimeMs)})
                  </div>
                ) : !ws.result ? (
                  <div className="dbw-results-empty">
                    Run a query to see results here
                  </div>
                ) : (
                  <div className="dbw-results-empty">
                    Query returned no rows ({formatMs(ws.result.executionTimeMs)})
                  </div>
                )
              ) : (
                <div className="dbw-messages-list">
                  {(ws?.messages.length ?? 0) === 0 ? (
                    <div className="dbw-results-empty">No messages</div>
                  ) : (
                    ws!.messages.map((msg, i) => (
                      <div
                        key={i}
                        className={`dbw-message-item ${/^Error|^Query failed/i.test(msg) ? 'error' : ''}`}
                      >
                        {msg}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
