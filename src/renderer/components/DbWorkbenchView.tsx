import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { sql, MySQL } from '@codemirror/lang-sql'
import { EditorView, keymap } from '@codemirror/view'
import {
  filterProducers,
  listProducersForBrowse,
  groupProducersByCluster,
  duplicateDbNames,
  shouldShowDatabaseSubtitle,
} from '../../shared/db-picker'
import './DbWorkbenchView.css'

/* ── Local Types (no shared imports to avoid circular deps) ── */

interface DbProducer {
  name: string
  cluster: string
  database: string
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

interface ConnectionState {
  connectionId: string
  tunnelId: string
  cluster: string
  database: string
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
  // Connection state
  const [connection, setConnection] = useState<ConnectionState | null>(null)
  const [connectPhase, setConnectPhase] = useState<ConnectPhase>('idle')
  const [connectError, setConnectError] = useState<string | null>(null)

  // Producer picker
  const [showPicker, setShowPicker] = useState(false)
  const [producers, setProducers] = useState<DbProducer[]>([])
  const [producersLoading, setProducersLoading] = useState(false)
  const [producerSearch, setProducerSearch] = useState('')
  const [pickerMode, setPickerMode] = useState<'cluster' | 'database'>('cluster')
  const [selectedCluster, setSelectedCluster] = useState<string | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Schema browser
  const [tables, setTables] = useState<TableInfo[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [expandedTable, setExpandedTable] = useState<string | null>(null)
  const [tableColumns, setTableColumns] = useState<Record<string, ColumnInfo[]>>({})
  const [columnsLoading, setColumnsLoading] = useState<string | null>(null)

  // SQL editor
  const [query, setQuery] = useState('')
  const runQueryRef = useRef<() => void>(() => {})

  // Results
  const [result, setResult] = useState<QueryResult | null>(null)
  const [queryRunning, setQueryRunning] = useState(false)
  const [activeResultTab, setActiveResultTab] = useState<'results' | 'messages'>('results')
  const [messages, setMessages] = useState<string[]>([])

  /* ── Producer Picker ── */

  const openPicker = useCallback(async () => {
    setShowPicker(true)
    setProducerSearch('')
    setPickerMode('cluster')
    setSelectedCluster(null)
    setProducersLoading(true)
    setConnectError(null)
    try {
      const res = await window.api.dbListProducers('mysql')
      console.log('[DbWorkbench] dbListProducers response:', JSON.stringify({ success: res.success, count: res.producers?.length, error: res.error }))
      if (!res.success) {
        setConnectError(res.error ?? 'Failed to load databases')
        setProducers([])
      } else {
        setProducers(res.producers ?? [])
      }
    } catch (err) {
      setConnectError(`Failed to load databases: ${err instanceof Error ? err.message : String(err)}`)
      setProducers([])
    } finally {
      setProducersLoading(false)
    }
  }, [])

  useEffect(() => {
    if (showPicker && searchInputRef.current) {
      searchInputRef.current.focus()
    }
  }, [showPicker, producersLoading])

  const clusters = useMemo(
    () => [...new Set(producers.map((p) => p.cluster))].sort((a, b) => a.localeCompare(b)),
    [producers],
  )

  const searchActive = producerSearch.trim().length > 0
  const globalSearchMatches = useMemo(
    () => filterProducers(producers, producerSearch),
    [producers, producerSearch],
  )
  const globalSearchGroups = useMemo(
    () => groupProducersByCluster(globalSearchMatches),
    [globalSearchMatches],
  )

  const databaseBrowseList = useMemo(
    () => listProducersForBrowse(producers, producerSearch),
    [producers, producerSearch],
  )
  const databaseBrowseGroups = useMemo(
    () => groupProducersByCluster(databaseBrowseList),
    [databaseBrowseList],
  )
  const databaseBrowseDupes = useMemo(
    () => duplicateDbNames(databaseBrowseList),
    [databaseBrowseList],
  )

  const filteredClusters = clusters.filter((c) => {
    const q = producerSearch.toLowerCase()
    if (!q) return true
    return c.toLowerCase().includes(q)
  })

  const clusterDatabases = useMemo(() => {
    if (!selectedCluster) return []
    return producers
      .filter((p) => p.cluster === selectedCluster)
      .filter((p) => {
        const q = producerSearch.toLowerCase()
        if (!q) return true
        return (
          p.dbName.toLowerCase().includes(q) ||
          p.database.toLowerCase().includes(q)
        )
      })
      .sort((a, b) => a.dbName.localeCompare(b.dbName))
  }, [producers, selectedCluster, producerSearch])

  const clusterDupes = useMemo(() => duplicateDbNames(clusterDatabases), [clusterDatabases])

  /* ── Connect / Disconnect ── */

  const handleConnect = useCallback(async (producerName: string) => {
    setShowPicker(false)
    setConnectError(null)
    setConnectPhase('authenticating')

    // Simulate phase progression (real timing depends on backend)
    const phaseTimer1 = setTimeout(() => setConnectPhase('tunneling'), 5000)
    const phaseTimer2 = setTimeout(() => setConnectPhase('connecting'), 12000)

    try {
      const res = await window.api.dbConnect(producerName)
      clearTimeout(phaseTimer1)
      clearTimeout(phaseTimer2)

      if (!res.success || res.error) {
        setConnectPhase('idle')
        setConnectError(res.error ?? 'Connection failed')
        return
      }

      setConnection({
        connectionId: res.connectionId!,
        tunnelId: res.tunnelId!,
        cluster: res.cluster!,
        database: res.database!,
      })
      setConnectPhase('done')

      // Reset workspace state
      setTables([])
      setTableColumns({})
      setExpandedTable(null)
      setResult(null)
      setMessages([])
      setQuery('')
    } catch (err) {
      clearTimeout(phaseTimer1)
      clearTimeout(phaseTimer2)
      setConnectPhase('idle')
      setConnectError(`Connection failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const handleDisconnect = useCallback(async () => {
    if (!connection) return
    try {
      await window.api.dbDisconnect(connection.connectionId)
    } catch {
      // Best effort
    }
    setConnection(null)
    setConnectPhase('idle')
    setTables([])
    setTableColumns({})
    setExpandedTable(null)
    setResult(null)
    setMessages([])
    setQuery('')
  }, [connection])

  /* ── Fetch Tables ── */

  const fetchTables = useCallback(async () => {
    if (!connection) return
    setTablesLoading(true)
    try {
      const res = await window.api.dbListTables(connection.connectionId)
      if (!res.success) {
        setMessages((prev) => [...prev, `Error loading tables: ${res.error ?? 'Unknown error'}`])
        setActiveResultTab('messages')
        setTables([])
      } else {
        setTables(res.tables ?? [])
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        `Error loading tables: ${err instanceof Error ? err.message : String(err)}`,
      ])
      setActiveResultTab('messages')
    } finally {
      setTablesLoading(false)
    }
  }, [connection])

  useEffect(() => {
    if (connection) {
      fetchTables()
    }
  }, [connection, fetchTables])

  /* ── Expand Table (describe) ── */

  const toggleTable = useCallback(
    async (tableName: string) => {
      if (expandedTable === tableName) {
        setExpandedTable(null)
        return
      }
      setExpandedTable(tableName)

      if (tableColumns[tableName]) return
      if (!connection) return

      setColumnsLoading(tableName)
      try {
        const res = await window.api.dbDescribeTable(connection.connectionId, tableName)
        if (!res.success) {
          setMessages((prev) => [...prev, `Error describing ${tableName}: ${res.error ?? 'Unknown error'}`])
          setActiveResultTab('messages')
        } else {
          setTableColumns((prev) => ({ ...prev, [tableName]: res.columns ?? [] }))
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          `Error describing ${tableName}: ${err instanceof Error ? err.message : String(err)}`,
        ])
        setActiveResultTab('messages')
      } finally {
        setColumnsLoading(null)
      }
    },
    [connection, expandedTable, tableColumns],
  )

  const handleTableClick = useCallback(
    (tableName: string) => {
      setQuery(`SELECT * FROM \`${tableName}\` LIMIT 100;`)
    },
    [],
  )

  /* ── Run Query ── */

  const runQuery = useCallback(async () => {
    if (!connection || !query.trim() || queryRunning) return
    setQueryRunning(true)
    setResult(null)
    setActiveResultTab('results')

    try {
      const res = await window.api.dbExecuteQuery(connection.connectionId, query.trim())
      setResult(res)
      if (res.error) {
        setMessages((prev) => [...prev, `Error: ${res.error}`])
        setActiveResultTab('messages')
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      setResult(null)
      setMessages((prev) => [...prev, `Query failed: ${errMsg}`])
      setActiveResultTab('messages')

      // If connection dropped, offer reconnect
      if (/ECONNRESET|EPIPE|lost|closed|timeout/i.test(errMsg)) {
        setConnectError('Connection lost. Please reconnect.')
        setConnection(null)
        setConnectPhase('idle')
      }
    } finally {
      setQueryRunning(false)
    }
  }, [connection, query, queryRunning])

  // Keep ref current for CodeMirror keymap
  runQueryRef.current = runQuery

  /* ── Keyboard shortcut: Cmd+Enter ── */

  const cmRunKeymap = useRef(
    keymap.of([
      {
        key: 'Mod-Enter',
        run: () => {
          runQueryRef.current()
          return true
        },
      },
    ]),
  )

  /* ── CodeMirror extensions ── */

  const cmExtensions = useRef([
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
    cmRunKeymap.current,
  ])

  function renderProducerRow(p: DbProducer, dupes: Set<string>, showClusterInSubtitle: boolean) {
    const showDbSubtitle = shouldShowDatabaseSubtitle(p, dupes) || showClusterInSubtitle
    return (
      <button
        key={p.name}
        className="dbw-picker-item"
        onClick={() => handleConnect(p.name)}
      >
        <span className="dbw-picker-item-text">
          <span className="dbw-picker-db-name">{p.dbName}</span>
          {showDbSubtitle && (
            <span className="dbw-picker-db-sub">
              {showClusterInSubtitle ? `${p.cluster} · ${p.database}` : p.database}
            </span>
          )}
        </span>
      </button>
    )
  }

  function renderPickerModal() {
    const showingDatabases = pickerMode === 'cluster' && selectedCluster !== null
    const showingGlobalSearch =
      pickerMode === 'cluster' && searchActive && !showingDatabases
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
                  onClick={() => { setSelectedCluster(null); setProducerSearch('') }}
                  title="Back to clusters"
                >
                  &#8592;
                </button>
                {selectedCluster}
              </>
            ) : showingGlobalSearch ? (
              'Search Results'
            ) : showingDatabaseBrowse ? (
              'Browse by database'
            ) : (
              'Select Cluster'
            )}
          </h2>

          <div className="dbw-picker-mode-tabs">
            <button
              type="button"
              className={`dbw-picker-mode-tab ${pickerMode === 'cluster' ? 'active' : ''}`}
              onClick={() => {
                setPickerMode('cluster')
                setSelectedCluster(null)
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
              }}
            >
              By database name
            </button>
          </div>

          <input
            ref={searchInputRef}
            className="form-input dbw-picker-search"
            type="text"
            placeholder={
              showingDatabaseBrowse
                ? 'Search by database name, host, or cluster...'
                : showingDatabases
                  ? 'Search databases in this cluster...'
                  : 'Search clusters or database names...'
            }
            value={producerSearch}
            onChange={(e) => setProducerSearch(e.target.value)}
          />

          {connectError && (
            <div className="dbw-error-banner" style={{ margin: '0 0 8px' }}>
              <span className="dbw-error-icon">!</span>
              <span>{connectError}</span>
            </div>
          )}

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
                globalSearchGroups.map(({ cluster, producers: group }) => (
                  <div key={cluster} className="dbw-picker-group">
                    <div className="dbw-picker-group-label">{cluster}</div>
                    {group.map((p) => renderProducerRow(p, globalDupes, true))}
                  </div>
                ))
              )
            ) : !showingDatabases ? (
              filteredClusters.length === 0 ? (
                <div className="dbw-picker-empty">
                  {clusters.length === 0
                    ? 'No clusters available'
                    : `No results for "${producerSearch}"`}
                </div>
              ) : (
                filteredClusters.map((cluster) => {
                  const count = producers.filter((p) => p.cluster === cluster).length
                  return (
                    <button
                      key={cluster}
                      className="dbw-picker-item"
                      onClick={() => { setSelectedCluster(cluster); setProducerSearch('') }}
                    >
                      <span className="dbw-picker-db-name">{cluster}</span>
                      <span className="dbw-picker-db-count">{count} db{count !== 1 ? 's' : ''}</span>
                    </button>
                  )
                })
              )
            ) : clusterDatabases.length === 0 ? (
              <div className="dbw-picker-empty">
                {`No results for "${producerSearch}"`}
              </div>
            ) : (
              clusterDatabases.map((p) => renderProducerRow(p, clusterDupes, false))
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

  if (!connection && connectPhase === 'idle') {
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

  if (!connection && connectPhase !== 'idle') {
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
          <button className="btn btn-sm" onClick={openPicker}>
            Connect &#9662;
          </button>
          <span className="dbw-conn-label">
            {connection!.cluster} / {connection!.database}
          </span>
          <span className="dbw-conn-status">
            <span className="dbw-conn-dot" />
            Connected
          </span>
        </div>
        <div className="dbw-toolbar-right">
          <button className="btn btn-sm btn-danger" onClick={handleDisconnect}>
            Disconnect
          </button>
          <button className="btn btn-sm" onClick={fetchTables}>
            Refresh
          </button>
        </div>
      </div>

      {connectError && (
        <div className="dbw-error-banner">
          <span className="dbw-error-icon">!</span>
          <span>{connectError}</span>
          <button className="dbw-error-dismiss" onClick={() => setConnectError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {showPicker && renderPickerModal()}

      {/* ── Main Split ── */}
      <div className="dbw-main">
        {/* ── Left Sidebar: Schema Browser ── */}
        <div className="dbw-sidebar">
          <div className="dbw-sidebar-header">
            <span className="dbw-sidebar-title">{connection!.database}</span>
            <span className="dbw-sidebar-count">
              {tables.length} table{tables.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="dbw-sidebar-list">
            {tablesLoading ? (
              <div className="dbw-sidebar-loading">Loading tables...</div>
            ) : tables.length === 0 ? (
              <div className="dbw-sidebar-empty">No tables found</div>
            ) : (
              tables.map((t) => {
                const isExpanded = expandedTable === t.name
                const cols = tableColumns[t.name]
                const isLoadingCols = columnsLoading === t.name

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
                onClick={runQuery}
                disabled={queryRunning || !query.trim()}
              >
                {queryRunning ? 'Running...' : 'Run \u25B6'}
              </button>
            </div>
            <div className="dbw-editor-wrapper">
              <CodeMirror
                value={query}
                onChange={(val) => setQuery(val)}
                extensions={cmExtensions.current}
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
                  className={`dbw-results-tab ${activeResultTab === 'results' ? 'active' : ''}`}
                  onClick={() => setActiveResultTab('results')}
                >
                  Results
                </button>
                <button
                  className={`dbw-results-tab ${activeResultTab === 'messages' ? 'active' : ''}`}
                  onClick={() => setActiveResultTab('messages')}
                >
                  Messages
                  {messages.length > 0 && (
                    <span className="dbw-msg-count">{messages.length}</span>
                  )}
                </button>
              </div>
              {activeResultTab === 'results' && result && !result.error && (
                <span className="dbw-results-meta">
                  {result.rowCount} row{result.rowCount !== 1 ? 's' : ''}
                  {' \u00B7 '}
                  {formatMs(result.executionTimeMs)}
                  {result.affectedRows > 0 && ` \u00B7 ${result.affectedRows} affected`}
                </span>
              )}
              {activeResultTab === 'messages' && messages.length > 0 && (
                <button
                  className="btn btn-sm"
                  onClick={() => setMessages([])}
                >
                  Clear
                </button>
              )}
            </div>

            <div className="dbw-results-content">
              {activeResultTab === 'results' ? (
                queryRunning ? (
                  <div className="dbw-results-loading">
                    <div className="dbw-connecting-spinner dbw-spinner-sm" />
                    <span>Executing query...</span>
                  </div>
                ) : result?.error ? (
                  <div className="dbw-results-error">
                    <span className="dbw-error-icon">!</span>
                    <pre>{result.error}</pre>
                  </div>
                ) : result && result.columns.length > 0 ? (
                  <div className="dbw-table-scroll">
                    <table className="dbw-results-table">
                      <thead>
                        <tr>
                          <th className="dbw-row-num">#</th>
                          {result.columns.map((col) => (
                            <th key={col.name}>
                              <span className="dbw-th-name">{col.name}</span>
                              <span className="dbw-th-type">{col.type}</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row, ri) => (
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
                ) : result && result.affectedRows > 0 ? (
                  <div className="dbw-results-message-ok">
                    Query OK, {result.affectedRows} row{result.affectedRows !== 1 ? 's' : ''} affected
                    ({formatMs(result.executionTimeMs)})
                  </div>
                ) : !result ? (
                  <div className="dbw-results-empty">
                    Run a query to see results here
                  </div>
                ) : (
                  <div className="dbw-results-empty">
                    Query returned no rows ({formatMs(result.executionTimeMs)})
                  </div>
                )
              ) : (
                <div className="dbw-messages-list">
                  {messages.length === 0 ? (
                    <div className="dbw-results-empty">No messages</div>
                  ) : (
                    messages.map((msg, i) => (
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
  )
}
