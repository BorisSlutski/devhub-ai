import React, { useState, useEffect, useCallback, useRef, useMemo, startTransition } from 'react'
import { sql, MySQL } from '@codemirror/lang-sql'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import {
  filterProducers,
  listProducersForBrowse,
  dedupeProducersForBrowse,
  groupProducersByCluster,
  producerCluster,
  parseProducerPathFields,
  applyProducerBrowseFilters,
  duplicateDbNames,
  shouldShowProducerSubtitle,
} from '../../shared/db-picker'
import { normalizeSqlSingleQuotedTableIds } from '../../shared/sql-ident-normalize'
import { parseStarSelectPreview } from '../../shared/sql-star-preview'
import { shouldApplyDescribeResult } from '../db-columns-describe'
import './DbWorkbenchView.css'
import { DbSessionWorkspacePanel } from './DbSessionWorkspacePanel'
import { StatusDot } from './StatusDot'

/* ── Local Types (no shared imports to avoid circular deps) ── */

interface DbProducer {
  name: string
  kgb: string
  cluster: string
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
  tunnelOptimized?: boolean
}

const CANCEL_CLIENT_TIMEOUT_MS = 30_000
/** Slightly above main-process EXEC_QUERY_TIMEOUT_MS so the UI never sticks on "Running". */
const QUERY_CLIENT_TIMEOUT_MS = 95_000
const TABLE_PREVIEW_LIMIT = 25
/** Cap rendered result rows so tab switches stay fast with large result sets. */
const RESULTS_DISPLAY_CAP = 250

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

const TABLES_FETCH_TIMEOUT_MS = 50_000
const COLUMNS_DESCRIBE_TIMEOUT_MS = 50_000

/** Survives Vite HMR — avoids refetching 145 tables on every hot reload. */
const hmrTablesCache = new Map<string, TableInfo[]>()
const tablesFetchInflight = new Map<string, Promise<void>>()

function applyTablesForConnection(
  setSessions: React.Dispatch<React.SetStateAction<DbSession[]>>,
  connectionId: string,
  tables: TableInfo[],
  tablesError: string | null,
) {
  hmrTablesCache.set(connectionId, tables)
  setSessions((prev) =>
    prev.map((s) =>
      s.connectionId === connectionId
        ? {
            ...s,
            workspace: {
              ...s.workspace,
              tables,
              tablesLoading: false,
              tablesError,
            },
          }
        : s,
    ),
  )
}

function failTablesForConnection(
  setSessions: React.Dispatch<React.SetStateAction<DbSession[]>>,
  connectionId: string,
  errMsg: string,
) {
  setSessions((prev) =>
    prev.map((s) =>
      s.connectionId === connectionId
        ? {
            ...s,
            workspace: {
              ...s.workspace,
              tables: [],
              tablesLoading: false,
              tablesError: errMsg,
              messages: [...s.workspace.messages, errMsg],
              activeResultTab: 'messages',
            },
          }
        : s,
    ),
  )
}

interface DbSessionWorkspace {
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

interface DbSession {
  id: string
  connectionId: string
  tunnelId: string
  kgb: string
  cluster: string
  dbName: string
  producerName: string
  label: string
  /** False when akeyless SSH tunnel process exited. */
  tunnelAlive: boolean
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
    columnsError: {},
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
  producerName?: string
  cluster?: string
}): DbSession {
  const cluster =
    conn.cluster ??
    (conn.producerName ? parseProducerPathFields(conn.producerName).cluster : '')
  return {
    id: conn.connectionId,
    ...conn,
    producerName: conn.producerName ?? '',
    cluster,
    label: cluster ? `${conn.dbName} · ${cluster}` : conn.dbName,
    tunnelAlive: true,
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

function renderNullCell() {
  return <span className="dbw-null">NULL</span>
}

function renderCellValue(value: unknown) {
  if (value === null || value === undefined) return renderNullCell()
  if (typeof value === 'object') {
    const bytes = bufferToBytes(value)
    if (bytes) return formatGuid(bytes)
    return JSON.stringify(value)
  }
  return String(value)
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
  const [pickerMode, setPickerMode] = useState<'cluster' | 'database'>('cluster')
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null)
  const [filterCluster, setFilterCluster] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  const runQueryRef = useRef<(sessionId: string, sqlOverride?: string) => void>(() => {})
  const fetchTablesRef = useRef<(sessionId: string, forceRefresh?: boolean) => void>(() => {})
  const fetchTableColumnsRef = useRef<
    (sessionId: string, connectionId: string, tableName: string) => void
  >(() => {})
  const queryRunIdRef = useRef(0)
  /** True while renderer awaits dbExecuteQuery — cleared on HMR dispose / completion. */
  const queryIpcInFlightRef = useRef(false)
  const columnsDescribeGenRef = useRef<Map<string, number>>(new Map())
  const tablesFetchGenRef = useRef<Map<string, number>>(new Map())
  const sessionsRef = useRef<DbSession[]>([])
  sessionsRef.current = sessions
  const activeSessionIdRef = useRef<string | null>(null)
  activeSessionIdRef.current = activeSessionId
  const editorViewRef = useRef<EditorView | null>(null)
  const connectPhaseTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  const queryElapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const [queryElapsedSec, setQueryElapsedSec] = useState(0)

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  )

  useEffect(() => {
    if (sessions.length > 0 && !activeSessionId) {
      setActiveSessionId(sessions[sessions.length - 1].id)
    }
  }, [sessions, activeSessionId])

  useEffect(() => {
    if (!activeSessionId) return
    if (sessions.some((s) => s.id === activeSessionId)) return
    setActiveSessionId(sessions[sessions.length - 1]?.id ?? null)
  }, [sessions, activeSessionId])

  // Restore tabs when the view remounts (e.g. app restart) while main still holds tunnels.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.api.dbListSessions()
      if (cancelled || !res.success || !res.sessions?.length) return
      setSessions((prev) => {
        if (prev.length > 0) return prev
        const restored = res.sessions!.map((s) => {
          const session = createSession({
            connectionId: s.connectionId,
            tunnelId: s.tunnelId,
            kgb: s.kgb,
            dbName: s.dbName,
            producerName: s.producerName,
          })
          const cachedTables = hmrTablesCache.get(s.connectionId)
          if (cachedTables?.length) {
            session.workspace = { ...session.workspace, tables: cachedTables }
          } else {
            session.workspace = { ...session.workspace, tablesLoading: true }
          }
          return session
        })
        return restored
      })
      setActiveSessionId((prev) => prev ?? res.sessions![res.sessions!.length - 1].connectionId)
      queueMicrotask(() => {
        for (const s of res.sessions!) {
          if (!hmrTablesCache.get(s.connectionId)?.length) {
            void fetchTablesRef.current(s.connectionId)
          }
        }
      })
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // If main already listed tables (or HMR preserved cache) but React state is stale, hydrate.
  useEffect(() => {
    const stuck = sessions.some(
      (s) => s.workspace.tablesLoading && s.workspace.tables.length === 0,
    )
    if (!stuck) return
    setSessions((prev) => {
      let changed = false
      const next = prev.map((s) => {
        const cached = hmrTablesCache.get(s.connectionId)
        if (cached?.length && s.workspace.tables.length === 0) {
          changed = true
          return {
            ...s,
            workspace: {
              ...s.workspace,
              tables: cached,
              tablesLoading: false,
              tablesError: null,
            },
          }
        }
        return s
      })
      return changed ? next : prev
    })
  }, [sessions])

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

  // HMR: orphaned IPC promises leave queryRunning=true with no main work in flight.
  useEffect(() => {
    if (!import.meta.hot) return
    const dispose = () => {
      queryIpcInFlightRef.current = false
      queryRunIdRef.current += 1
    }
    import.meta.hot.dispose(dispose)
    return () => import.meta.hot?.dispose(dispose)
  }, [])

  useEffect(() => {
    const staleRunning = sessions.some(
      (s) => s.workspace.queryRunning && !queryIpcInFlightRef.current,
    )
    if (!staleRunning) return
    queryRunIdRef.current += 1
    stopQueryElapsedTimer()
    setSessions((prev) =>
      prev.map((s) =>
        s.workspace.queryRunning
          ? { ...s, workspace: { ...s.workspace, queryRunning: false } }
          : s,
      ),
    )
    void window.api.dbListSessions().then((res) => {
      for (const s of res.sessions ?? []) {
        void window.api.dbCancelQuery(s.connectionId).catch(() => undefined)
      }
    })
  }, [sessions, stopQueryElapsedTimer])

  // Full remount (not fast refresh): same stale Running cleanup once on load.
  useEffect(() => {
    const stuck = sessionsRef.current.some((s) => s.workspace.queryRunning)
    if (!stuck) return
    queryRunIdRef.current += 1
    queryIpcInFlightRef.current = false
    stopQueryElapsedTimer()
    setSessions((prev) =>
      prev.map((s) =>
        s.workspace.queryRunning
          ? { ...s, workspace: { ...s.workspace, queryRunning: false } }
          : s,
      ),
    )
    void window.api.dbListSessions().then((res) => {
      for (const s of res.sessions ?? []) {
        void window.api.dbCancelQuery(s.connectionId).catch(() => undefined)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only
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

  const abortInFlightQueryForConnection = useCallback(
    (connectionId: string) => {
      queryRunIdRef.current += 1
      queryIpcInFlightRef.current = false
      stopQueryElapsedTimer()
      setSessions((prev) =>
        prev.map((s) =>
          s.connectionId === connectionId && s.workspace.queryRunning
            ? { ...s, workspace: { ...s.workspace, queryRunning: false } }
            : s,
        ),
      )
    },
    [stopQueryElapsedTimer],
  )

  useEffect(() => {
    const unsubIdle = window.api.onDbIdleDisconnected(({ connectionId }) => {
      abortInFlightQueryForConnection(connectionId)
      hmrTablesCache.delete(connectionId)
      tablesFetchInflight.delete(connectionId)
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
            abortInFlightQueryForConnection(connectionId)
            hmrTablesCache.delete(connectionId)
            tablesFetchInflight.delete(connectionId)
            setSessions((prev) =>
              prev.map((s) =>
                s.connectionId === connectionId
                  ? {
                      ...s,
                      tunnelAlive: false,
                      workspace: {
                        ...s.workspace,
                        tables: [],
                        tablesLoading: false,
                        tablesError: reason,
                        queryRunning: false,
                        messages: [...s.workspace.messages, reason],
                        activeResultTab: 'messages',
                      },
                    }
                  : s,
              ),
            )
            setConnectError(`${reason}. Click Reconnect tunnel or disconnect and connect again.`)
          })
        : () => {}
    return () => {
      unsubIdle()
      unsubTunnel()
    }
  }, [abortInFlightQueryForConnection])

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
    setPickerMode('cluster')
    setSelectedCluster(null)
    setFilterCluster('')
    await loadProducers(false)
  }, [loadProducers])

  useEffect(() => {
    if (showPicker && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [showPicker, producersLoading])

  const clusterTags = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of producers) {
      const cluster = producerCluster(p)
      if (!cluster) continue
      counts.set(cluster, (counts.get(cluster) ?? 0) + 1)
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [producers])

  const searchActive = producerSearch.trim().length > 0
  const globalSearchMatches = useMemo(
    () =>
      applyProducerBrowseFilters(filterProducers(producers, producerSearch), {
        cluster: filterCluster,
      }),
    [producers, producerSearch, filterCluster],
  )
  const globalSearchClusterGroups = useMemo(
    () => groupProducersByCluster(globalSearchMatches),
    [globalSearchMatches],
  )

  const databaseBrowseList = useMemo(
    () =>
      applyProducerBrowseFilters(listProducersForBrowse(producers, producerSearch), {
        cluster: filterCluster,
      }),
    [producers, producerSearch, filterCluster],
  )
  const databaseBrowseGroups = useMemo(
    () => groupProducersByCluster(databaseBrowseList),
    [databaseBrowseList],
  )
  const databaseBrowseDupes = useMemo(
    () => duplicateDbNames(databaseBrowseList),
    [databaseBrowseList],
  )

  const filteredClusterTags = clusterTags.filter(([cluster]) => {
    const q = producerSearch.toLowerCase()
    if (!q) return true
    return cluster.toLowerCase().includes(q)
  })

  const filterClusterOptions = useMemo(
    () =>
      [...new Set(producers.map((p) => producerCluster(p)).filter(Boolean))].sort((a, b) =>
        a.localeCompare(b),
      ),
    [producers],
  )

  const clusterDatabases = useMemo(() => {
    if (!selectedCluster) return []
    const filtered = producers
      .filter((p) => producerCluster(p) === selectedCluster)
      .filter((p) => {
        if (filterCluster && producerCluster(p) !== filterCluster) return false
        const q = producerSearch.toLowerCase()
        if (!q) return true
        return (
          p.dbName.toLowerCase().includes(q) ||
          p.producer.toLowerCase().includes(q)
        )
      })
    return dedupeProducersForBrowse(filtered).sort((a, b) => a.dbName.localeCompare(b.dbName))
  }, [producers, selectedCluster, producerSearch, filterCluster])

  const clusterDupes = useMemo(() => duplicateDbNames(clusterDatabases), [clusterDatabases])

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

      const { cluster } = parseProducerPathFields(producerName)
      const newSession = createSession({
        connectionId: res.connectionId!,
        tunnelId: res.tunnelId!,
        kgb: res.kgb!,
        dbName: res.dbName!,
        producerName,
        cluster,
      })
      newSession.workspace = { ...newSession.workspace, tablesLoading: true }
      setSessions((prev) => [...prev, newSession])
      setActiveSessionId(newSession.id)
      setIsConnecting(false)
      queueMicrotask(() => {
        void fetchTablesRef.current(newSession.id)
      })
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

  const handleReconnectTunnel = useCallback(
    async (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return
      setConnectError(null)
      patchSession(sessionId, { tablesLoading: true, tablesError: null })
      try {
        const res = await window.api.dbReconnect(session.connectionId)
        if (!res.success) {
          patchSession(sessionId, {
            tablesLoading: false,
            tablesError: res.error ?? 'Reconnect failed',
          })
          setConnectError(res.error ?? 'Reconnect failed')
          return
        }
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sessionId ? { ...s, tunnelAlive: true } : s,
          ),
        )
        await fetchTablesRef.current(sessionId, true)
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        patchSession(sessionId, { tablesLoading: false, tablesError: errMsg })
        setConnectError(errMsg)
      }
    },
    [patchSession],
  )

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
      hmrTablesCache.delete(session.connectionId)
      tablesFetchInflight.delete(session.connectionId)
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
      const connectionId = session?.connectionId ?? sessionId

      if (!session && !forceRefresh) {
        const cached = hmrTablesCache.get(connectionId)
        if (cached?.length) {
          applyTablesForConnection(setSessions, connectionId, cached, null)
        }
        return
      }

      if (!connectionId) {
        if (session) {
          patchSession(sessionId, {
            tablesLoading: false,
            tablesError: 'Connection lost. Click Retry to reconnect.',
          })
        }
        return
      }

      if (!forceRefresh) {
        const cached = hmrTablesCache.get(connectionId)
        if (cached?.length && (session?.workspace.tables.length ?? 0) === 0) {
          applyTablesForConnection(setSessions, connectionId, cached, null)
          return
        }
      }

      const inflight = tablesFetchInflight.get(connectionId)
      if (inflight && !forceRefresh) {
        patchSession(sessionId, { tablesLoading: true, tablesError: null })
        try {
          await inflight
        } catch {
          // Primary fetch already recorded the error.
        }
        const cached = hmrTablesCache.get(connectionId)
        if (cached?.length) {
          applyTablesForConnection(setSessions, connectionId, cached, null)
          return
        }
        const latest = sessionsRef.current.find((s) => s.connectionId === connectionId)
        if (latest && latest.workspace.tables.length === 0) {
          failTablesForConnection(
            setSessions,
            connectionId,
            latest.workspace.tablesError ?? 'Failed to load tables',
          )
        }
        return
      }

      const fetchGen = (tablesFetchGenRef.current.get(connectionId) ?? 0) + 1
      tablesFetchGenRef.current.set(connectionId, fetchGen)

      setSessions((prev) =>
        prev.map((s) =>
          s.connectionId === connectionId
            ? { ...s, workspace: { ...s.workspace, tablesLoading: true, tablesError: null } }
            : s,
        ),
      )

      const run = async () => {
        try {
          const res = await Promise.race([
            window.api.dbListTables(connectionId, forceRefresh),
            new Promise<{ success: false; tables: []; error: string }>((_, reject) => {
              setTimeout(
                () => reject(new Error(`Timed out after ${TABLES_FETCH_TIMEOUT_MS / 1000}s`)),
                TABLES_FETCH_TIMEOUT_MS,
              )
            }),
          ])
          if (tablesFetchGenRef.current.get(connectionId) !== fetchGen) return
          if (!res.success) {
            failTablesForConnection(
              setSessions,
              connectionId,
              res.error ?? 'Failed to load tables',
            )
          } else {
            applyTablesForConnection(setSessions, connectionId, res.tables ?? [], null)
          }
        } catch (err) {
          if (tablesFetchGenRef.current.get(connectionId) !== fetchGen) return
          failTablesForConnection(
            setSessions,
            connectionId,
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      const task = run()
      tablesFetchInflight.set(connectionId, task)
      try {
        await task
      } finally {
        tablesFetchInflight.delete(connectionId)
      }
    },
    [patchSession],
  )

  fetchTablesRef.current = fetchTables

  useEffect(() => {
    if (!activeSessionId) return
    const session = sessionsRef.current.find((s) => s.id === activeSessionId)
    if (!session) return
    if (session.workspace.tables.length > 0) return
    void fetchTables(activeSessionId)
  }, [activeSessionId, fetchTables])

  const selectSessionTab = useCallback((sessionId: string) => {
    startTransition(() => setActiveSessionId(sessionId))
  }, [])

  /* ── Expand Table (describe) ── */

  const fetchTableColumnsForSession = useCallback(
    async (sessionId: string, connectionId: string, tableName: string) => {
      const gen = (columnsDescribeGenRef.current.get(sessionId) ?? 0) + 1
      columnsDescribeGenRef.current.set(sessionId, gen)

      updateSessionWorkspace(sessionId, (w) => {
        const { [tableName]: _removed, ...restErrors } = w.columnsError
        return {
          columnsLoading: tableName,
          columnsError: restErrors,
        }
      })

      try {
        const res = await Promise.race([
          window.api.dbDescribeTable(connectionId, tableName),
          new Promise<{ success: false; columns: []; error: string }>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Timed out loading columns after ${COLUMNS_DESCRIBE_TIMEOUT_MS / 1000}s`,
                  ),
                ),
              COLUMNS_DESCRIBE_TIMEOUT_MS,
            )
          }),
        ])

        const session = sessionsRef.current.find((s) => s.id === sessionId)
        if (
          !session ||
          !shouldApplyDescribeResult(
            columnsDescribeGenRef.current.get(sessionId) ?? 0,
            gen,
            session.workspace.expandedTable,
            tableName,
          )
        ) {
          return
        }

        if (!res.success) {
          const errMsg = res.error ?? 'Unknown error'
          updateSessionWorkspace(sessionId, (w) => ({
            columnsLoading: w.columnsLoading === tableName ? null : w.columnsLoading,
            columnsError: { ...w.columnsError, [tableName]: errMsg },
            messages: [...w.messages, `Error describing ${tableName}: ${errMsg}`],
            activeResultTab: 'messages',
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
        const session = sessionsRef.current.find((s) => s.id === sessionId)
        if (
          !session ||
          !shouldApplyDescribeResult(
            columnsDescribeGenRef.current.get(sessionId) ?? 0,
            gen,
            session.workspace.expandedTable,
            tableName,
          )
        ) {
          return
        }
        updateSessionWorkspace(sessionId, (w) => ({
          columnsLoading: w.columnsLoading === tableName ? null : w.columnsLoading,
          columnsError: { ...w.columnsError, [tableName]: errMsg },
          messages: [...w.messages, `Error describing ${tableName}: ${errMsg}`],
          activeResultTab: 'messages',
        }))
      } finally {
        const session = sessionsRef.current.find((s) => s.id === sessionId)
        if (
          session &&
          session.workspace.columnsLoading === tableName &&
          session.workspace.tableColumns[tableName] === undefined &&
          (columnsDescribeGenRef.current.get(sessionId) ?? 0) === gen
        ) {
          updateSessionWorkspace(sessionId, (w) => ({
            columnsLoading: null,
            columnsError: {
              ...w.columnsError,
              [tableName]: w.columnsError[tableName] ?? 'Failed to load columns',
            },
          }))
        }
      }
    },
    [updateSessionWorkspace],
  )

  fetchTableColumnsRef.current = fetchTableColumnsForSession

  const toggleTableForSession = useCallback(
    async (sessionId: string, tableName: string) => {
      let connectionId: string | null = null
      let skipFetch = true
      setSessions((prev) => {
        const session = prev.find((s) => s.id === sessionId)
        if (!session) return prev
        connectionId = session.connectionId
        if (session.workspace.expandedTable === tableName) {
          skipFetch = true
          return prev.map((s) =>
            s.id === sessionId
              ? { ...s, workspace: { ...s.workspace, expandedTable: null } }
              : s,
          )
        }
        if (session.workspace.tableColumns[tableName]) {
          skipFetch = true
          return prev.map((s) =>
            s.id === sessionId
              ? { ...s, workspace: { ...s.workspace, expandedTable: tableName } }
              : s,
          )
        }
        skipFetch = false
        return prev.map((s) =>
          s.id === sessionId
            ? {
                ...s,
                workspace: {
                  ...s.workspace,
                  expandedTable: tableName,
                  columnsLoading: tableName,
                },
              }
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
      const sql = `SELECT * FROM \`${tableName}\` LIMIT ${TABLE_PREVIEW_LIMIT};`
      patchSession(sessionId, { query: sql, expandedTable: tableName })
    },
    [patchSession],
  )

  /* ── Run Query ── */

  const runQueryForSession = useCallback(
    async (sessionId: string, sqlOverride?: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return

      const sql = (sqlOverride ?? session.workspace.query).trim()
      if (!sql) return

      const connectionId = session.connectionId
      const runId = ++queryRunIdRef.current

      // Supersede a stuck or in-flight query (common after Vite HMR during dev).
      if (session.workspace.queryRunning) {
        void window.api.dbCancelQuery(connectionId).catch(() => undefined)
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
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
        ),
      )

      const normalized = normalizeSqlSingleQuotedTableIds(sql)
      let execSql = sql
      if (normalized.changed) {
        execSql = normalized.sql
        patchSession(sessionId, { query: execSql })
      }

      startQueryElapsedTimer()
      queryIpcInFlightRef.current = true
      try {
        const res = await Promise.race([
          window.api.dbExecuteQuery(connectionId, execSql),
          new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Query timed out after ${QUERY_CLIENT_TIMEOUT_MS / 1000}s (client) — click Cancel or reconnect.`,
                  ),
                ),
              QUERY_CLIENT_TIMEOUT_MS,
            )
          }),
        ])
        if (runId !== queryRunIdRef.current) return
        if (res.error) {
          const msgs = [`Error: ${res.error}`]
          if (/timed out|lost|closed|ECONNRESET|cancelled/i.test(res.error)) {
            msgs.push('Connection may be dead — disconnect and reconnect.')
          }
          updateSessionWorkspace(sessionId, (w) => ({
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
          if (normalized.changed) {
            notes.push(
              'Normalized single-quoted table names to backticks (e.g. FROM \'table\' → FROM `table`).',
            )
          }
          if (res.rowCapApplied) {
            notes.push('Auto-added LIMIT 10001 (query had no LIMIT — avoids slow full table scans over SSH).')
          }
          if (res.tunnelOptimized) {
            notes.push('Large TEXT/JSON/BLOB columns were truncated on the server for faster SELECT * preview (2048 chars per cell).')
          }
          if (res.truncated) {
            notes.push('Showing first 10,000 rows (more may exist — add a narrower WHERE or LIMIT).')
          }
          const preview = parseStarSelectPreview(execSql)
          updateSessionWorkspace(sessionId, (w) => {
            const patch: Partial<DbSessionWorkspace> = {
              queryRunning: false,
              result: res,
              messages: notes.length > 0 ? [...w.messages, ...notes] : w.messages,
            }
            if (preview && res.columns.length > 0) {
              patch.tableColumns = {
                ...w.tableColumns,
                [preview.table]: res.columns.map((col) => ({
                  name: col.name,
                  type: col.type,
                  nullable: true,
                  key: '',
                  defaultValue: null,
                  extra: '',
                })),
              }
            }
            return patch
          })
        }
      } catch (err) {
        if (runId !== queryRunIdRef.current) return
        const errMsg = err instanceof Error ? err.message : String(err)
        updateSessionWorkspace(sessionId, (w) => ({
          queryRunning: false,
          result: null,
          messages: [...w.messages, `Query failed: ${errMsg}`],
          activeResultTab: 'messages',
        }))

        if (/ECONNRESET|EPIPE|lost|closed|timeout/i.test(errMsg)) {
          setConnectError('Connection lost or timed out. Retry loading tables or run the query again.')
        }
      } finally {
        queryIpcInFlightRef.current = false
        if (runId === queryRunIdRef.current) {
          stopQueryElapsedTimer()
          updateSessionWorkspace(sessionId, (w) =>
            w.queryRunning ? { queryRunning: false } : {},
          )
        }
      }
    },
    [
      patchSession,
      updateSessionWorkspace,
      startQueryElapsedTimer,
      stopQueryElapsedTimer,
    ],
  )

  const runQuery = useCallback(
    async (sqlOverride?: string) => {
      if (!activeSessionId) return
      await runQueryForSession(activeSessionId, sqlOverride)
    },
    [activeSessionId, runQueryForSession],
  )

  const cancelQueryForSession = useCallback(
    async (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session?.workspace.queryRunning) return

      const connectionId = session.connectionId
      queryRunIdRef.current += 1
      queryIpcInFlightRef.current = false
      stopQueryElapsedTimer()
      updateSessionWorkspace(sessionId, (w) => ({ queryRunning: false }))

      try {
        const res = await Promise.race([
          window.api.dbCancelQuery(connectionId),
          new Promise<{ success: boolean; error?: string }>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Cancel timed out after ${CANCEL_CLIENT_TIMEOUT_MS / 1000}s`)),
              CANCEL_CLIENT_TIMEOUT_MS,
            )
          }),
        ])
        updateSessionWorkspace(sessionId, (w) => ({
          messages: [
            ...w.messages,
            res.success ? 'Query cancelled.' : `Cancel failed: ${res.error ?? 'Unknown error'}`,
          ],
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

  runQueryRef.current = runQueryForSession

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
              const sessionId = activeSessionIdRef.current
              if (sessionId) runQueryRef.current(sessionId, selected || undefined)
              return true
            },
          },
        ]),
      ),
    ],
    [],
  )

  function renderProducerRow(p: DbProducer, dupes: Set<string>, showClusterInSubtitle: boolean) {
    const cluster = producerCluster(p)
    const showSubtitle = shouldShowProducerSubtitle(p, dupes) || showClusterInSubtitle
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
              {showClusterInSubtitle && cluster ? cluster : p.producer}
            </span>
          )}
        </span>
      </button>
    )
  }

  function renderDbFilters(showClusterFilter: boolean) {
    if (!showClusterFilter) return null
    return (
      <div className="dbw-picker-filters">
        <label className="dbw-picker-filter">
          <span>Cluster</span>
          <select
            className="form-input dbw-picker-filter-select"
            value={filterCluster}
            onChange={(e) => setFilterCluster(e.target.value)}
          >
            <option value="">All clusters</option>
            {filterClusterOptions.map((cluster) => (
              <option key={cluster} value={cluster}>
                {cluster}
              </option>
            ))}
          </select>
        </label>
      </div>
    )
  }

  function renderPickerModal() {
    const showingClusterDatabases = pickerMode === 'cluster' && selectedCluster !== null
    const showingGlobalSearch =
      pickerMode === 'cluster' && searchActive && !showingClusterDatabases
    const showingDatabaseBrowse = pickerMode === 'database'
    const showingDbFilters =
      showingClusterDatabases || showingDatabaseBrowse || showingGlobalSearch
    const globalDupes = duplicateDbNames(globalSearchMatches)

    return (
      <div className="modal-overlay" onClick={() => setShowPicker(false)}>
        <div className="dbw-picker-modal" onClick={(e) => e.stopPropagation()}>
          <h2>
            {showingClusterDatabases ? (
              <>
                <button
                  className="dbw-picker-back"
                  onClick={() => {
                    setSelectedCluster(null)
                    setProducerSearch('')
                    setFilterCluster('')
                  }}
                  title="Back to clusters"
                >
                  &#8592;
                </button>
                {selectedCluster}
              </>
            ) : showingGlobalSearch ? (
              'Search Results'
            ) : showingDatabaseBrowse ? (
              'Browse databases'
            ) : (
              'Connect to database'
            )}
          </h2>

          <div className="dbw-picker-mode-tabs">
            <button
              type="button"
              className={`dbw-picker-mode-tab ${pickerMode === 'cluster' ? 'active' : ''}`}
              onClick={() => {
                setPickerMode('cluster')
                setSelectedCluster(null)
                setFilterCluster('')
              }}
            >
              By cluster
            </button>
            <button
              type="button"
              className={`dbw-picker-mode-tab ${pickerMode === 'database' ? 'active' : ''}`}
              onClick={() => {
                setPickerMode('database')
                setSelectedCluster(null)
                setFilterCluster('')
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
                ? 'Search database name, cluster, or producer...'
                : showingClusterDatabases
                  ? 'Search databases in this cluster...'
                  : 'Search cluster names or database names...'
            }
            value={producerSearch}
            onChange={(e) => setProducerSearch(e.target.value)}
          />

          {renderDbFilters(showingDbFilters)}

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
                databaseBrowseGroups.map(({ cluster, producers: group }) => (
                  <div key={cluster} className="dbw-picker-group">
                    <div className="dbw-picker-group-label">{cluster}</div>
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
                globalSearchClusterGroups.map(({ cluster, producers: group }) => (
                  <div key={cluster} className="dbw-picker-group">
                    <div className="dbw-picker-group-label">{cluster}</div>
                    {group.map((p) => renderProducerRow(p, globalDupes, true))}
                  </div>
                ))
              )
            ) : pickerMode === 'cluster' && !showingClusterDatabases ? (
              filteredClusterTags.length === 0 ? (
                <div className="dbw-picker-empty">
                  {clusterTags.length === 0
                    ? 'No clusters available'
                    : `No results for "${producerSearch}"`}
                </div>
              ) : (
                filteredClusterTags.map(([cluster, count]) => (
                  <button
                    key={cluster}
                    className="dbw-picker-item"
                    onClick={() => {
                      setSelectedCluster(cluster)
                      setProducerSearch('')
                    }}
                  >
                    <span className="dbw-picker-db-name">{cluster}</span>
                    <span className="dbw-picker-db-count">
                      {count} database{count !== 1 ? 's' : ''}
                    </span>
                  </button>
                ))
              )
            ) : showingClusterDatabases ? (
              clusterDatabases.length === 0 ? (
                <div className="dbw-picker-empty">
                  {`No results for "${producerSearch}"`}
                </div>
              ) : (
                clusterDatabases.map((p) => renderProducerRow(p, clusterDupes, true))
              )
            ) : null}
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

  return (
    <div className="dbw-view">
      {/* ── Toolbar ── */}
      <div className="dbw-toolbar">
        <div className="dbw-toolbar-left">
          <button className="btn btn-sm" type="button" onClick={openPicker}>
            + Add connection
          </button>
          {activeSession && (
            <span className="dbw-conn-label">
              {activeSession.label}
              {!activeSession.tunnelAlive && (
                <span className="dbw-conn-dead"> · tunnel down</span>
              )}
            </span>
          )}
          <span className="dbw-conn-status">
            <StatusDot
              status={
                !activeSession
                  ? 'idle'
                  : !activeSession.tunnelAlive
                    ? 'error'
                    : activeSession.workspace.queryRunning
                      ? 'running'
                      : 'idle'
              }
              title={
                activeSession && !activeSession.tunnelAlive
                  ? 'Tunnel down'
                  : activeSession?.workspace.queryRunning
                    ? 'Query running'
                    : 'Connected'
              }
            />
            {sessions.filter((s) => s.tunnelAlive).length} connected
          </span>
        </div>
        <div className="dbw-toolbar-right">
          {activeSessionId && activeSession && (
            <>
              {!activeSession.tunnelAlive && (
                <button
                  className="btn btn-sm btn-primary"
                  type="button"
                  onClick={() => void handleReconnectTunnel(activeSessionId)}
                >
                  Reconnect tunnel
                </button>
              )}
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
                disabled={!activeSession.tunnelAlive}
                onClick={() => void fetchTables(activeSessionId, true)}
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
                onClick={() => selectSessionTab(s.id)}
                title={s.label}
              >
                <span className="dbw-session-tab-label">{s.dbName}</span>
                <span className="dbw-session-tab-sub">{s.cluster}</span>
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
          {sessions.map((s) => (
            <DbSessionWorkspacePanel
              key={s.id}
              sessionId={s.id}
              dbName={s.dbName}
              workspace={s.workspace}
              tunnelAlive={s.tunnelAlive}
              isActive={s.id === activeSessionId}
              queryElapsedSec={s.id === activeSessionId ? queryElapsedSec : 0}
              tablePreviewLimit={TABLE_PREVIEW_LIMIT}
              resultsDisplayCap={RESULTS_DISPLAY_CAP}
              cmExtensions={cmExtensions}
              formatMs={formatMs}
              renderCellValue={renderCellValue}
              onQueryChange={(query) => patchSession(s.id, { query })}
              onRunQuery={(sql) => void runQueryForSession(s.id, sql)}
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
