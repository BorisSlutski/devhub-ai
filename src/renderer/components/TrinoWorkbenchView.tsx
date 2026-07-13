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
  rowCapApplied?: boolean
}

interface TableInfo {
  name: string
  type: 'TABLE' | 'VIEW'
  engine: string | null
  rows: number | null
  comment: string
  catalog?: string
  schema?: string
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
const TABLE_SEARCH_DEBOUNCE_MS = 350

interface ParsedTableNavigatorInput {
  catalog?: string
  schema?: string
  tableFilter: string
}

function parseTableNavigatorInput(raw: string): ParsedTableNavigatorInput {
  const trimmed = raw.trim()
  if (!trimmed) return { tableFilter: '' }
  const parts = trimmed.split('.').map((p) => p.trim()).filter(Boolean)
  if (parts.length >= 3) {
    return { catalog: parts[0], schema: parts[1], tableFilter: parts.slice(2).join('.') }
  }
  if (parts.length === 2) {
    return { schema: parts[0], tableFilter: parts[1] }
  }
  return { tableFilter: parts[0] }
}

function extractQualifiedTableFromSql(sql: string): ParsedTableNavigatorInput | null {
  const m = sql.match(
    /\b(?:FROM|JOIN)\s+([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)/i,
  )
  if (m) return { catalog: m[1], schema: m[2], tableFilter: m[3] }
  const m2 = sql.match(/\b(?:FROM|JOIN)\s+([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)/i)
  if (m2) return { schema: m2[1], tableFilter: m2[2] }
  return null
}

function tableLocation(
  session: TrinoSession,
  tableName: string,
): { catalog: string; schema: string } {
  const row = session.workspace.tables.find((t) => t.name === tableName)
  return {
    catalog: row?.catalog || session.catalog,
    schema: row?.schema || session.schema,
  }
}

interface TrinoSessionWorkspace {
  tables: TableInfo[]
  tablesLoading: boolean
  tablesError: string | null
  /** Trino: catalogs from SHOW CATALOGS when not set at connect time. */
  catalogs: string[]
  schemas: string[]
  metaLoading: boolean
  expandedTable: string | null
  tableColumns: Record<string, ColumnInfo[]>
  columnsLoading: string | null
  columnsError: Record<string, string>
  query: string
  result: QueryResult | null
  queryRunning: boolean
  activeResultTab: 'results' | 'messages'
  messages: string[]
  tableSearch: string
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
    catalogs: [],
    schemas: [],
    metaLoading: false,
    expandedTable: null,
    tableColumns: {},
    columnsLoading: null,
    columnsError: {},
    query: '',
    result: null,
    queryRunning: false,
    activeResultTab: 'results',
    messages: [],
    tableSearch: '',
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
  savePassword: boolean
}

const EMPTY_FORM: ConnectFormState = {
  server: '',
  catalog: '',
  schema: '',
  user: '',
  password: '',
  savePassword: false,
}
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
  const [connectWarning, setConnectWarning] = useState<string | null>(null)

  const runQueryRef = useRef<(sessionId: string, sqlOverride?: string) => void>(() => {})
  const fetchTablesRef = useRef<(sessionId: string, forceRefresh?: boolean) => void>(() => {})
  const discoverCatalogsRef = useRef<(sessionId: string) => void>(() => {})
  const discoverSchemasRef = useRef<(sessionId: string, catalog: string) => void>(() => {})
  const searchTablesRef = useRef<(sessionId: string, input: string) => void>(() => {})
  const tableSearchTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const queryRunIdRef = useRef(0)
  const queryIpcInFlightRef = useRef(false)
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

  // Restore live main-process connections after renderer remount (Vite HMR / tab switch).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await window.api.trinoListConnections()
      if (cancelled || !res.success || !res.connections?.length) return
      if (sessionsRef.current.length > 0) return

      const restored: TrinoSession[] = res.connections.map((c) => ({
        id: c.id,
        connectionId: c.id,
        server: c.server,
        catalog: c.catalog,
        schema: c.schema,
        user: c.user,
        label: `${c.catalog || c.server}${c.schema ? ` / ${c.schema}` : ''}`,
        connected: true,
        workspace: {
          ...createEmptyWorkspace(),
          ...(c.catalog && c.schema ? { tablesLoading: true } : { metaLoading: true }),
        },
      }))
      sessionsRef.current = restored
      setSessions(restored)
      setActiveSessionId(restored[restored.length - 1].id)

      for (const s of restored) {
        if (s.catalog && s.schema) {
          queueMicrotask(() => void fetchTablesRef.current(s.id, true))
        } else if (s.catalog) {
          queueMicrotask(() => void discoverSchemasRef.current(s.id, s.catalog))
        } else {
          queueMicrotask(() => void discoverCatalogsRef.current(s.id))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
    void window.api.trinoListConnections().then((res) => {
      for (const c of res.connections ?? []) {
        void window.api.trinoCancelQuery(c.id).catch(() => undefined)
      }
    })
  }, [sessions, stopQueryElapsedTimer])

  const patchSession = useCallback((sessionId: string, patch: Partial<TrinoSessionWorkspace>) => {
    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, workspace: { ...s.workspace, ...patch } } : s)),
    )
  }, [])

  const patchTrinoSession = useCallback(
    (sessionId: string, patch: Partial<Pick<TrinoSession, 'catalog' | 'schema' | 'label'>>) => {
      setSessions((prev) =>
        prev.map((s) => {
          if (s.id !== sessionId) return s
          const next = { ...s, ...patch }
          if (patch.catalog !== undefined || patch.schema !== undefined) {
            next.label = `${next.catalog || next.server}${next.schema ? ` / ${next.schema}` : ''}`
          }
          return next
        }),
      )
    },
    [],
  )

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
    setConnectWarning(null)
    const last = loadLastConnection()
    const base = presets.length > 0 ? { ...EMPTY_FORM, server: presets[0].server } : EMPTY_FORM
    const next = last ? { ...base, ...last, password: '', savePassword: false } : base
    setForm(next)
    setShowConnectForm(true)
    if (next.server && next.user) {
      const lookupServer = next.server
      const lookupUser = next.user
      void window.api.trinoHasSavedCredential(lookupServer, lookupUser).then((res) => {
        if (!res.success || !res.hasCredential) return
        setForm((f) => {
          if (f.server !== lookupServer || f.user !== lookupUser) return f
          return { ...f, savePassword: true }
        })
      })
    }
  }, [presets])

  const handleConnect = useCallback(async () => {
    if (!form.server.trim()) {
      setConnectError('Server is required')
      return
    }
    setConnectError(null)
    setConnectWarning(null)
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
        form.savePassword,
      )
      if (!res.success) {
        setConnectError(res.error ?? 'Connection failed')
        setIsConnecting(false)
        return
      }
      if (res.credentialWarning) {
        setConnectWarning(`Connected, but failed to save password: ${res.credentialWarning}`)
      }
      const resolvedServer = res.server ?? form.server.trim()
      const resolvedCatalog = res.catalog ?? form.catalog.trim()
      const resolvedSchema = res.schema ?? form.schema.trim()
      const resolvedUser = res.user ?? form.user.trim()
      saveLastConnection({
        server: resolvedServer,
        catalog: resolvedCatalog,
        schema: resolvedSchema,
        user: resolvedUser,
      })
      const newSession: TrinoSession = {
        id: connectionId,
        connectionId,
        server: resolvedServer,
        catalog: resolvedCatalog,
        schema: resolvedSchema,
        user: resolvedUser,
        label: `${resolvedCatalog || resolvedServer}${resolvedSchema ? ` / ${resolvedSchema}` : ''}`,
        connected: true,
        workspace: createEmptyWorkspace(),
      }
      if (resolvedCatalog && resolvedSchema) {
        newSession.workspace = { ...newSession.workspace, tablesLoading: true }
      } else {
        newSession.workspace = { ...newSession.workspace, metaLoading: true }
      }
      const nextSessions = [...sessionsRef.current, newSession]
      sessionsRef.current = nextSessions
      setSessions(nextSessions)
      setActiveSessionId(newSession.id)
      setShowConnectForm(false)
      setIsConnecting(false)
      if (resolvedCatalog && resolvedSchema) {
        queueMicrotask(() => void fetchTablesRef.current(newSession.id))
      } else if (resolvedCatalog) {
        queueMicrotask(() => void discoverSchemasRef.current(newSession.id, resolvedCatalog))
      } else {
        queueMicrotask(() => void discoverCatalogsRef.current(newSession.id))
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

  const discoverCatalogs = useCallback(
    async (sessionId: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return
      patchSession(sessionId, { metaLoading: true, tablesError: null, catalogs: [], schemas: [] })
      try {
        const res = await window.api.trinoListCatalogs(session.connectionId)
        if (!res.success) {
          patchSession(sessionId, {
            metaLoading: false,
            tablesError: res.error ?? 'Failed to list catalogs — try SHOW CATALOGS in the editor.',
          })
          return
        }
        const catalogs = res.catalogs ?? []
        patchSession(sessionId, { metaLoading: false, catalogs })
        if (catalogs.length === 1) {
          patchTrinoSession(sessionId, { catalog: catalogs[0] })
          void discoverSchemasRef.current(sessionId, catalogs[0])
        }
      } catch (err) {
        patchSession(sessionId, {
          metaLoading: false,
          tablesError: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [patchSession, patchTrinoSession],
  )

  const discoverSchemas = useCallback(
    async (sessionId: string, catalog: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return
      patchSession(sessionId, { metaLoading: true, tablesError: null, schemas: [] })
      try {
        const res = await window.api.trinoListSchemas(session.connectionId, catalog)
        if (!res.success) {
          patchSession(sessionId, {
            metaLoading: false,
            tablesError: res.error ?? `Failed to list schemas in ${catalog}.`,
          })
          return
        }
        const schemas = res.schemas ?? []
        patchSession(sessionId, { metaLoading: false, schemas })
        if (schemas.length === 1) {
          patchTrinoSession(sessionId, { schema: schemas[0] })
          void fetchTablesRef.current(sessionId, true)
        }
      } catch (err) {
        patchSession(sessionId, {
          metaLoading: false,
          tablesError: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [patchSession, patchTrinoSession],
  )

  discoverCatalogsRef.current = discoverCatalogs
  discoverSchemasRef.current = discoverSchemas

  const selectCatalogForSession = useCallback(
    (sessionId: string, catalog: string) => {
      patchTrinoSession(sessionId, { catalog, schema: '' })
      patchSession(sessionId, { schemas: [], tables: [], tablesError: null })
      if (catalog) void discoverSchemas(sessionId, catalog)
    },
    [discoverSchemas, patchSession, patchTrinoSession],
  )

  const selectSchemaForSession = useCallback(
    (sessionId: string, schema: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return
      patchTrinoSession(sessionId, { schema })
      saveLastConnection({
        server: session.server,
        catalog: session.catalog,
        schema,
        user: session.user,
      })
      patchSession(sessionId, { tables: [], tablesError: null })
      if (!schema) return
      const search = session.workspace.tableSearch.trim()
      if (search) void searchTablesRef.current(sessionId, search)
      else void fetchTablesRef.current(sessionId, true)
    },
    [patchSession, patchTrinoSession],
  )

  const fetchTables = useCallback(
    async (sessionId: string, forceRefresh = false) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return
      if (session.workspace.tableSearch.trim()) {
        void searchTablesRef.current(sessionId, session.workspace.tableSearch)
        return
      }
      if (!session.catalog || !session.schema) {
        if (!session.catalog) {
          void discoverCatalogs(sessionId)
        } else {
          void discoverSchemas(sessionId, session.catalog)
        }
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
    [patchSession, discoverCatalogs, discoverSchemas],
  )

  const searchTablesForSession = useCallback(
    async (sessionId: string, input: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return

      const trimmed = input.trim()
      if (!trimmed) {
        patchSession(sessionId, { tables: [], tablesError: null })
        if (session.catalog && session.schema) {
          void fetchTablesRef.current(sessionId, true)
        }
        return
      }

      const parsed = parseTableNavigatorInput(trimmed)
      let catalog = parsed.catalog ?? session.catalog
      let schema = parsed.schema ?? session.schema
      const filter = parsed.tableFilter

      if (parsed.catalog && parsed.catalog !== session.catalog) {
        patchTrinoSession(sessionId, { catalog: parsed.catalog, schema: parsed.schema ?? '' })
        catalog = parsed.catalog
        schema = parsed.schema ?? ''
        void discoverSchemas(sessionId, parsed.catalog)
      } else if (parsed.schema && parsed.schema !== session.schema) {
        patchTrinoSession(sessionId, { schema: parsed.schema })
        schema = parsed.schema
      }

      patchSession(sessionId, { tablesLoading: true, tablesError: null })

      try {
        const res = await Promise.race([
          window.api.trinoListTables(
            session.connectionId,
            catalog || undefined,
            schema || undefined,
            filter,
          ),
          new Promise<{ success: false; tables: []; error: string }>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Timed out after ${TABLES_FETCH_TIMEOUT_MS / 1000}s`)),
              TABLES_FETCH_TIMEOUT_MS,
            )
          }),
        ])
        if (!res.success) {
          patchSession(sessionId, { tablesLoading: false, tablesError: res.error ?? 'Table search failed' })
          return
        }
        const tables = res.tables ?? []
        if (tables.length === 1 && tables[0].catalog && tables[0].schema) {
          patchTrinoSession(sessionId, { catalog: tables[0].catalog, schema: tables[0].schema })
        }
        patchSession(sessionId, { tables, tablesLoading: false, tablesError: null })
      } catch (err) {
        patchSession(sessionId, {
          tablesLoading: false,
          tablesError: err instanceof Error ? err.message : String(err),
        })
      }
    },
    [patchSession, patchTrinoSession, discoverSchemas],
  )

  searchTablesRef.current = searchTablesForSession
  fetchTablesRef.current = fetchTables

  const scheduleTableSearch = useCallback((sessionId: string, value: string) => {
    const existing = tableSearchTimersRef.current.get(sessionId)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      tableSearchTimersRef.current.delete(sessionId)
      void searchTablesRef.current(sessionId, value)
    }, TABLE_SEARCH_DEBOUNCE_MS)
    tableSearchTimersRef.current.set(sessionId, timer)
  }, [])

  const handleTableSearchChange = useCallback(
    (sessionId: string, value: string) => {
      patchSession(sessionId, { tableSearch: value })
      scheduleTableSearch(sessionId, value)
    },
    [patchSession, scheduleTableSearch],
  )

  const handleQueryChangeForSession = useCallback(
    (sessionId: string, query: string) => {
      patchSession(sessionId, { query })
      const parsed = extractQualifiedTableFromSql(query)
      if (!parsed?.tableFilter) return

      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return

      const parts = [parsed.catalog, parsed.schema, parsed.tableFilter].filter(Boolean)
      const searchText = parts.join('.')
      if (searchText === session.workspace.tableSearch) return

      patchSession(sessionId, { tableSearch: searchText })
      if (parsed.catalog && parsed.catalog !== session.catalog) {
        patchTrinoSession(sessionId, { catalog: parsed.catalog, schema: parsed.schema ?? '' })
        void discoverSchemas(sessionId, parsed.catalog)
      } else if (parsed.schema && parsed.schema !== session.schema) {
        patchTrinoSession(sessionId, { schema: parsed.schema })
      }
      scheduleTableSearch(sessionId, searchText)
    },
    [patchSession, patchTrinoSession, discoverSchemas, scheduleTableSearch],
  )

  const selectSessionTab = useCallback((sessionId: string) => {
    startTransition(() => setActiveSessionId(sessionId))
  }, [])

  /* ── Expand Table (describe) ── */

  const fetchTableColumnsForSession = useCallback(
    async (sessionId: string, connectionId: string, tableName: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      const loc = session ? tableLocation(session, tableName) : { catalog: '', schema: '' }
      try {
        const res = await window.api.trinoDescribeTable(
          connectionId,
          tableName,
          loc.catalog || session?.catalog,
          loc.schema || session?.schema,
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
      const loc = session ? tableLocation(session, tableName) : { catalog: '', schema: '' }
      const qualified =
        loc.catalog && loc.schema ? `${loc.catalog}.${loc.schema}.${tableName}` : tableName
      const previewSql = `SELECT * FROM ${qualified} LIMIT ${TABLE_PREVIEW_LIMIT};`
      patchSession(sessionId, { query: previewSql, expandedTable: tableName })
    },
    [patchSession],
  )

  /* ── Run Query ── */

  const runQueryForSession = useCallback(
    async (sessionId: string, sqlOverride?: string) => {
      const session = sessionsRef.current.find((s) => s.id === sessionId)
      if (!session) return
      const statement = (sqlOverride ?? session.workspace.query).trim()
      if (!statement) return

      const connectionId = session.connectionId
      const runId = ++queryRunIdRef.current

      if (session.workspace.queryRunning) {
        void window.api.trinoCancelQuery(connectionId).catch(() => undefined)
      }

      setSessions((prev) =>
        prev.map((s) =>
          s.id === sessionId
            ? { ...s, workspace: { ...s.workspace, queryRunning: true, result: null, activeResultTab: 'results' } }
            : s,
        ),
      )

      startQueryElapsedTimer()
      queryIpcInFlightRef.current = true
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
          if (res.rowCapApplied) {
            notes.push(
              'Auto-added LIMIT 1001 (query had no LIMIT — Trino stops early instead of scanning the full table).',
            )
          }
          if (res.truncated) {
            notes.push('Showing first 1,000 rows (more may exist — add a narrower WHERE or LIMIT).')
          }
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
        queryIpcInFlightRef.current = false
        if (runId === queryRunIdRef.current) {
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

          {connectWarning && (
            <div
              className="dbw-error-banner"
              style={{ margin: '0 0 8px', background: 'rgba(234, 179, 8, 0.15)', borderColor: 'rgba(234, 179, 8, 0.4)' }}
            >
              <span className="dbw-error-icon">!</span>
              <span>{connectWarning}</span>
            </div>
          )}

          <label className="dbw-picker-filter" style={{ display: 'block', marginBottom: 8 }}>
            <span>Server</span>
            <input
              className="form-input"
              list="trino-server-presets"
              value={form.server}
              onChange={(e) => setForm((f) => ({ ...f, server: e.target.value }))}
              placeholder="https://presto-router.wixpress.com:443"
            />
            <span className="dbw-picker-hint" style={{ display: 'block', marginTop: 4, fontSize: 12, opacity: 0.75 }}>
              HTTPS REST URL (DataGrip JDBC URLs like jdbc:trino://… are converted automatically).
              Catalog/schema are optional — leave empty to connect like DataGrip, then run SQL.
            </span>
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
              placeholder="optional — e.g. hive"
            />
          </label>

          <label className="dbw-picker-filter" style={{ display: 'block', marginBottom: 8 }}>
            <span>Schema</span>
            <input
              className="form-input"
              value={form.schema}
              onChange={(e) => setForm((f) => ({ ...f, schema: e.target.value }))}
              placeholder="optional — e.g. default"
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

          <label
            className="dbw-picker-filter"
            style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}
          >
            <input
              type="checkbox"
              checked={form.savePassword}
              onChange={(e) => setForm((f) => ({ ...f, savePassword: e.target.checked }))}
            />
            <span>Save password (encrypted, this machine only)</span>
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
          {connectWarning && !showConnectForm && (
            <div
              className="dbw-error-banner"
              style={{ background: 'rgba(234, 179, 8, 0.15)', borderColor: 'rgba(234, 179, 8, 0.4)' }}
            >
              <span className="dbw-error-icon">!</span>
              <span>{connectWarning}</span>
              <button className="dbw-error-dismiss" onClick={() => setConnectWarning(null)}>
                Dismiss
              </button>
            </div>
          )}
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

      {connectWarning && (
        <div
          className="dbw-error-banner"
          style={{ background: 'rgba(234, 179, 8, 0.15)', borderColor: 'rgba(234, 179, 8, 0.4)' }}
        >
          <span className="dbw-error-icon">!</span>
          <span>{connectWarning}</span>
          <button type="button" className="dbw-error-dismiss" onClick={() => setConnectWarning(null)}>
            Dismiss
          </button>
        </div>
      )}

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
              dbName={s.catalog && s.schema ? `${s.catalog} / ${s.schema}` : s.server}
              workspace={s.workspace}
              tunnelAlive={s.connected}
              isActive={s.id === activeSessionId}
              queryElapsedSec={s.id === activeSessionId ? queryElapsedSec : 0}
              tablePreviewLimit={TABLE_PREVIEW_LIMIT}
              resultsDisplayCap={RESULTS_DISPLAY_CAP}
              cmExtensions={cmExtensions}
              formatMs={formatMs}
              renderCellValue={renderCellValue}
              onQueryChange={(query) => handleQueryChangeForSession(s.id, query)}
              onRunQuery={(sqlOverride) => void runQueryForSession(s.id, sqlOverride)}
              onCancelQuery={() => void cancelQueryForSession(s.id)}
              onFetchTables={() => void fetchTables(s.id, true)}
              tableSearch={{
                value: s.workspace.tableSearch,
                onChange: (value) => handleTableSearchChange(s.id, value),
              }}
              catalogBrowse={{
                catalogs: s.workspace.catalogs,
                schemas: s.workspace.schemas,
                catalog: s.catalog,
                schema: s.schema,
                loading: s.workspace.metaLoading,
                onCatalogChange: (catalog) => selectCatalogForSession(s.id, catalog),
                onSchemaChange: (schema) => selectSchemaForSession(s.id, schema),
              }}
              onToggleTable={(tableName) => void toggleTableForSession(s.id, tableName)}
              onRetryColumns={(tableName) => retryColumnsForSession(s.id, tableName)}
              onTableClick={(tableName) => handleTableClickForSession(s.id, tableName)}
              formatTableDisplayName={(t) => {
                const cat = t.catalog || s.catalog
                const sch = t.schema || s.schema
                return cat && sch ? `${cat}.${sch}.${t.name}` : t.name
              }}
              onActiveResultTab={(tab) => patchSession(s.id, { activeResultTab: tab })}
              onClearMessages={() => patchSession(s.id, { messages: [] })}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
