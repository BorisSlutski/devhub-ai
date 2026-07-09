/**
 * mysql-client.ts — Main-process module for managing MySQL connections via mysql2/promise.
 *
 * Exports a singleton `mysqlClient` instance of `MysqlClient`.
 * All public methods are safe to call from IPC handlers; errors are caught
 * and returned in structured result objects rather than thrown.
 */

import { coalesceInflight } from './describe-inflight-coalesce'
import { capUnboundedSelect } from '../shared/sql-limit'
import {
  buildTunnelOptimizedStarSelect,
  isLargeColumnType,
  parseStarSelectPreview,
} from '../shared/sql-star-preview'

// Use eval require to prevent Vite from bundling the native module.
// Same pattern as pty-manager.ts.
// eslint-disable-next-line no-eval
const mysql: typeof import('mysql2/promise') = eval("require('mysql2/promise')")

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface QueryResult {
  columns: ColumnDef[]
  rows: any[][]
  rowCount: number
  affectedRows: number
  executionTimeMs: number
  error?: string
  /** True when we appended LIMIT because the query had none. */
  rowCapApplied?: boolean
  truncated?: boolean
  /** True when SELECT * preview was rewritten to cap large columns on the server. */
  tunnelOptimized?: boolean
}

export interface ColumnDef {
  name: string
  type: string
}

export interface TableInfo {
  name: string
  type: 'TABLE' | 'VIEW'
  engine: string | null
  rows: number | null
  comment: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  key: string
  defaultValue: string | null
  extra: string
}

export interface DbConnection {
  id: string
  host: string
  port: number
  user: string
  database: string
  connected: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ROWS = 10_000
const MAX_CELL_CHARS = 2_048
const CONNECT_TIMEOUT_MS = 10_000
/** Metadata (SHOW TABLES, etc.) over SSH tunnels. */
const QUERY_TIMEOUT_MS = 45_000
/** User SQL — long enough for analytics, short enough to fail visibly. */
const EXEC_QUERY_TIMEOUT_MS = 90_000
const PING_TIMEOUT_MS = 2_000
/** Skip pre-query ping when the connection was used recently. */
const PING_IDLE_THRESHOLD_MS = 45_000
/** Reuse SHOW FULL TABLES results — avoids HMR / tab churn hammering the tunnel. */
const TABLES_LIST_CACHE_TTL_MS = 5 * 60 * 1000
/** Hard cap for SHOW FULL TABLES (renderer races at 50s). */
const LIST_TABLES_TIMEOUT_MS = 50_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

// ---------------------------------------------------------------------------
// MySQL field-type code to human-readable name mapping
// Based on mysql2 field type constants.
// ---------------------------------------------------------------------------

const FIELD_TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  14: 'NEWDATE',
  15: 'VARCHAR',
  16: 'BIT',
  245: 'JSON',
  246: 'NEWDECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINY_BLOB',
  250: 'MEDIUM_BLOB',
  251: 'LONG_BLOB',
  252: 'BLOB',
  253: 'VAR_STRING',
  254: 'STRING',
  255: 'GEOMETRY'
}

function fieldTypeName(typeCode: number): string {
  return FIELD_TYPE_NAMES[typeCode] ?? `UNKNOWN(${typeCode})`
}

async function queryWithTimeout(
  connection: any,
  sql: string,
  params?: unknown[],
  timeoutMs = QUERY_TIMEOUT_MS,
  onTimeout?: () => void,
): Promise<[unknown, unknown]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const queryPromise =
      params !== undefined ? connection.query(sql, params) : connection.query(sql)
    return (await Promise.race([
      queryPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true
          reject(new Error(`Query timed out after ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
      }),
    ])) as [unknown, unknown]
  } catch (err) {
    if (timedOut) {
      onTimeout?.()
      try {
        connection.destroy()
      } catch {
        // best effort — free the socket so the next query can reconnect
      }
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function pingWithTimeout(connection: any, label: string): Promise<void> {
  await Promise.race([
    connection.ping(),
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} ping timed out after ${PING_TIMEOUT_MS / 1000}s`)),
        PING_TIMEOUT_MS,
      )
    }),
  ])
}

async function pingIfIdle(entry: ConnectionEntry): Promise<void> {
  const idleMs = Date.now() - entry.lastActivityAt
  if (idleMs < PING_IDLE_THRESHOLD_MS) return
  await pingWithTimeout(entry.queryConn, 'Query connection')
}

function columnCacheKey(database: string, table: string): string {
  return `${database}\0${table}`
}

function previewSql(sql: string, max = 120): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

async function createMysqlConnection(
  host: string,
  port: number,
  user: string,
  password: string,
  database: string,
): Promise<any> {
  const connection = await mysql.createConnection({
    host,
    port,
    user,
    password,
    database,
    connectTimeout: CONNECT_TIMEOUT_MS,
    multipleStatements: false,
    rowsAsArray: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10_000,
    // PyCharm/JDBC default — compression over SSH tunnels often stalls the query socket.
    compress: false,
  })
  await connection.ping()
  return connection
}

/** Row from SHOW FULL TABLES: [name, BASE TABLE|VIEW] (rowsAsArray) or named fields. */
function parseShowFullTablesRow(r: any, database: string): [string, string] {
  if (Array.isArray(r)) return [String(r[0]), String(r[1] ?? '')]
  const nameKey = `Tables_in_${database}`
  if (r && typeof r === 'object' && nameKey in r) {
    return [String(r[nameKey]), String(r.Table_type ?? '')]
  }
  if (r && typeof r === 'object' && 'Table_type' in r) {
    const name = Object.keys(r).find((k) => k.startsWith('Tables_in_'))
    return [name ? String(r[name]) : '', String(r.Table_type ?? '')]
  }
  return ['', '']
}

// ---------------------------------------------------------------------------
// Internal metadata stored alongside each connection
// ---------------------------------------------------------------------------

interface ConnectionEntry {
  /** User SQL — isolated from metadata so SHOW TABLES cannot block SELECT. */
  queryConn: any
  /** SHOW TABLES / DESCRIBE — timeouts here do not kill the query socket. */
  metaConn: any
  meta: DbConnection
  password: string
  host: string
  port: number
  lastActivityAt: number
  queryInFlight: boolean
  /** Bumped on cancel/reconnect so in-flight executeQuery does not drop the new socket. */
  generation: number
  columnCache: Map<string, ColumnInfo[]>
  tablesListCache: { database: string; tables: TableInfo[]; at: number } | null
  listTablesInFlight: Promise<TableInfo[]> | null
  /** Coalesce concurrent DESCRIBE for the same table on this connection. */
  describeInFlight: Map<string, Promise<ColumnInfo[]>>
  /** Serialize metadata queries — prevents HMR from stacking concurrent SHOW TABLES. */
  metaQueryChain: Promise<void>
}

// ---------------------------------------------------------------------------
// MysqlClient
// ---------------------------------------------------------------------------

class MysqlClient {
  private connections: Map<string, ConnectionEntry> = new Map()

  private withMetaLock<T>(entry: ConnectionEntry, fn: () => Promise<T>): Promise<T> {
    const run = entry.metaQueryChain.then(fn, fn)
    entry.metaQueryChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async ensureMetaReady(entry: ConnectionEntry): Promise<void> {
    await this.withMetaLock(entry, async () => {
      try {
        await Promise.race([
          entry.metaConn.ping(),
          new Promise<never>((_, reject) => {
            setTimeout(
              () => reject(new Error(`Metadata ping timed out after ${PING_TIMEOUT_MS / 1000}s`)),
              PING_TIMEOUT_MS,
            )
          }),
        ])
      } catch {
        await this.replaceMetaConnection(entry)
      }
    })
  }

  private async replaceMetaConnection(entry: ConnectionEntry): Promise<void> {
    try {
      entry.metaConn.destroy()
    } catch {
      // ignore
    }
    entry.metaConn = await createMysqlConnection(
      entry.host,
      entry.port,
      entry.meta.user,
      entry.password,
      entry.meta.database,
    )
  }

  /**
   * `id` is optional only for legacy call sites; when provided, a connection that finishes
   * AFTER the entry has been superseded (disconnected/reconnected under the same id, e.g. by a
   * slow reconnect racing a cancel timeout) is destroyed immediately instead of being assigned
   * to a stale, no-longer-tracked entry — otherwise that socket leaks forever.
   */
  private async replaceQueryConnection(entry: ConnectionEntry, id?: string): Promise<void> {
    try {
      entry.queryConn.destroy()
    } catch {
      // ignore
    }
    const conn = await createMysqlConnection(
      entry.host,
      entry.port,
      entry.meta.user,
      entry.password,
      entry.meta.database,
    )
    if (id !== undefined && this.connections.get(id) !== entry) {
      try {
        conn.destroy()
      } catch {
        // ignore
      }
      return
    }
    entry.queryConn = conn
    entry.lastActivityAt = Date.now()
  }

  /** Verify the user-query socket; reopen if the tunnel dropped it while metadata still works. */
  private async ensureQueryReady(entry: ConnectionEntry, id?: string): Promise<void> {
    try {
      await pingWithTimeout(entry.queryConn, 'Query connection')
      entry.lastActivityAt = Date.now()
    } catch {
      await this.replaceQueryConnection(entry, id)
    }
  }

  private async queryMeta(entry: ConnectionEntry, sql: string, params?: unknown[]): Promise<[unknown, unknown]> {
    await this.ensureMetaReady(entry)
    return this.withMetaLock(entry, async () => {
      try {
        return await queryWithTimeout(entry.metaConn, sql, params, QUERY_TIMEOUT_MS, () => {
          // Sync replace so the next queued metadata query uses a fresh socket.
          void this.replaceMetaConnection(entry)
        })
      } catch (err: any) {
        if (isConnectionLostError(err)) {
          try {
            await this.replaceMetaConnection(entry)
          } catch {
            // metadata path failed; query socket may still work
          }
        }
        throw err
      }
    })
  }

  private async getCachedColumns(
    entry: ConnectionEntry,
    table: string,
    database: string,
  ): Promise<ColumnInfo[]> {
    const key = columnCacheKey(database, table)
    const cached = entry.columnCache.get(key)
    if (cached) return cached
    const cols = await this.describeTable(entry.meta.id, table, database)
    return cols
  }

  /**
   * Connect to a MySQL server. After a successful TCP + auth handshake the
   * connection is verified with a ping.
   */
  async connect(
    id: string,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string
  ): Promise<DbConnection> {
    // If a connection with this id already exists, close it first.
    if (this.connections.has(id)) {
      await this.disconnect(id)
    }

    const [queryConn, metaConn] = await Promise.all([
      createMysqlConnection(host, port, user, password, database),
      createMysqlConnection(host, port, user, password, database),
    ])

    const meta: DbConnection = {
      id,
      host,
      port,
      user,
      database,
      connected: true
    }

    this.connections.set(id, {
      queryConn,
      metaConn,
      meta,
      password,
      host,
      port,
      lastActivityAt: Date.now(),
      queryInFlight: false,
      generation: 0,
      columnCache: new Map(),
      tablesListCache: null,
      listTablesInFlight: null,
      describeInFlight: new Map(),
      metaQueryChain: Promise.resolve(),
    })

    return { ...meta }
  }

  /**
   * Disconnect a single connection by id.
   */
  async disconnect(id: string): Promise<void> {
    const entry = this.connections.get(id)
    if (!entry) return

    entry.meta.connected = false
    this.connections.delete(id)

    await Promise.allSettled([
      entry.queryConn.end().catch(() => undefined),
      entry.metaConn.end().catch(() => undefined),
    ])
  }

  /**
   * Execute an arbitrary SQL statement and return a structured result.
   *
   * - SELECT-like statements return columns + rows (capped at MAX_ROWS).
   * - DML statements (INSERT/UPDATE/DELETE) return affectedRows.
   * - Errors are caught and surfaced via `QueryResult.error`.
   */
  async executeQuery(id: string, sql: string): Promise<QueryResult> {
    const empty: QueryResult = {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: 0,
      executionTimeMs: 0,
    }

    const entry = this.connections.get(id)
    if (!entry) {
      return { ...empty, error: `No connection found for id "${id}"` }
    }

    const start = performance.now()
    const generationAtStart = entry.generation
    let pingMs = 0
    let schemaMs = 0
    let tunnelOptimized = false
    let useMetaSocket = false

    try {
      const pingStart = performance.now()
      const { sql: cappedSql, rowCapApplied } = capUnboundedSelect(sql, MAX_ROWS)
      let execSql = cappedSql

      const preview = parseStarSelectPreview(cappedSql)
      if (preview) {
        const db = preview.database ?? entry.meta.database
        const schemaStart = performance.now()
        const columns = await this.getCachedColumns(entry, preview.table, db)
        schemaMs = Math.round((performance.now() - schemaStart) * 100) / 100
        if (columns.some((c) => isLargeColumnType(c.type))) {
          execSql = buildTunnelOptimizedStarSelect(
            (ident) => entry.metaConn.escapeId(ident),
            preview.database,
            preview.table,
            columns,
            preview.limit,
          )
          tunnelOptimized = true
        }
        // Same socket as DESCRIBE / SHOW TABLES — proven over SSH tunnels (PyCharm uses one JDBC conn).
        useMetaSocket = true
      } else {
        await pingIfIdle(entry)
      }
      pingMs = Math.round((performance.now() - pingStart) * 100) / 100
      entry.queryInFlight = true
      console.log(
        `[mysql-client] query start id=${id} meta=${useMetaSocket} sql=${previewSql(execSql)} optimized=${tunnelOptimized}`,
      )

      const queryStart = performance.now()
      let result: unknown
      let fields: unknown

      if (useMetaSocket) {
        await this.ensureMetaReady(entry)
        ;[result, fields] = await this.withMetaLock(entry, () =>
          queryWithTimeout(entry.metaConn, execSql, undefined, QUERY_TIMEOUT_MS, () => {
            void this.replaceMetaConnection(entry)
          }),
        )
      } else {
        await this.ensureQueryReady(entry, id)
        ;[result, fields] = await queryWithTimeout(
          entry.queryConn,
          execSql,
          undefined,
          EXEC_QUERY_TIMEOUT_MS,
          () => {
            void this.replaceQueryConnection(entry, id).catch(() => undefined)
          },
        )
      }
      const queryMs = Math.round((performance.now() - queryStart) * 100) / 100

      if (entry.generation !== generationAtStart) {
        return { ...empty, error: 'Query cancelled' }
      }
      entry.lastActivityAt = Date.now()
      entry.queryInFlight = false
      const executionTimeMs = Math.round((performance.now() - start) * 100) / 100

      if (Array.isArray(result)) {
        const columns: ColumnDef[] = (fields ?? []).map((f: any) => ({
          name: f.name as string,
          type: fieldTypeName(f.columnType ?? f.type ?? 0),
        }))

        const sanitizeStart = performance.now()
        let rows = (result as any[][]).map((row) => row.map(sanitizeCellForIpc))
        const sanitizeMs = Math.round((performance.now() - sanitizeStart) * 100) / 100
        let truncated = false
        if (rows.length > MAX_ROWS) {
          rows = rows.slice(0, MAX_ROWS)
          truncated = true
        }

        console.log(
          `[mysql-client] query ok id=${id} total=${executionTimeMs}ms ping=${pingMs}ms schema=${schemaMs}ms mysql=${queryMs}ms sanitize=${sanitizeMs}ms rows=${rows.length} optimized=${tunnelOptimized} meta=${useMetaSocket} sql=${previewSql(sql)}`,
        )

        return {
          columns,
          rows,
          rowCount: rows.length,
          affectedRows: 0,
          executionTimeMs,
          rowCapApplied,
          truncated,
          tunnelOptimized,
        }
      }

      console.log(
        `[mysql-client] query ok id=${id} total=${executionTimeMs}ms ping=${pingMs}ms mysql=${queryMs}ms affected=${(result as any).affectedRows ?? 0} sql=${previewSql(sql)}`,
      )

      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: (result as any).affectedRows ?? 0,
        executionTimeMs,
      }
    } catch (err: any) {
      if (entry.generation === generationAtStart) {
        entry.queryInFlight = false
      }
      const executionTimeMs = Math.round((performance.now() - start) * 100) / 100
      const msg = err?.message ?? String(err)

      if (
        entry.generation === generationAtStart &&
        (/timed out/i.test(msg) || isConnectionLostError(err))
      ) {
        entry.meta.connected = false
        try {
          entry.queryConn.destroy()
        } catch {
          // keep entry + credentials so ensureDbConnection can reopen the socket
        }
      }

      console.error(
        `[mysql-client] query failed id=${id} total=${executionTimeMs}ms ping=${pingMs}ms schema=${schemaMs}ms optimized=${tunnelOptimized} meta=${useMetaSocket} sql=${previewSql(sql)} err=${msg}`,
      )

      if (entry.generation !== generationAtStart) {
        return { ...empty, executionTimeMs, error: 'Query cancelled' }
      }

      return {
        ...empty,
        executionTimeMs,
        error: msg,
      }
    }
  }

  /**
   * Abort a running query and reopen the MySQL connection on the same tunnel port.
   */
  async cancelQuery(id: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.connections.get(id)
    if (!entry) {
      return { success: false, error: `No connection found for id "${id}"` }
    }

    try {
      entry.generation += 1
      entry.queryInFlight = false
      try {
        entry.queryConn.destroy()
      } catch {
        // ignore
      }

      await Promise.race([
        this.replaceQueryConnection(entry, id),
        new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Reconnect after cancel timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)),
            CONNECT_TIMEOUT_MS,
          )
        }),
      ])
      entry.queryInFlight = false
      entry.meta.connected = true
      return { success: true }
    } catch (err: any) {
      entry.meta.connected = false
      try {
        entry.queryConn.destroy()
      } catch {
        // keep entry for a later reconnect attempt
      }
      return { success: false, error: err?.message ?? String(err) }
    }
  }

  /**
   * Reopen the MySQL socket on an existing tunnel (refreshes Akeyless credentials).
   */
  async reconnect(
    id: string,
    host: string,
    port: number,
    user: string,
    password: string,
    database: string,
  ): Promise<DbConnection> {
    return this.connect(id, host, port, user, password, database)
  }

  isConnected(id: string): boolean {
    const entry = this.connections.get(id)
    return entry?.meta.connected === true
  }

  isQueryInFlight(id: string): boolean {
    const entry = this.connections.get(id)
    return entry?.queryInFlight === true
  }

  hasConnection(id: string): boolean {
    return this.connections.has(id)
  }

  /** Read column metadata cached by a prior DESCRIBE or SELECT * preview. */
  getTableColumnsCache(id: string, tableName: string, database?: string): ColumnInfo[] | null {
    const entry = this.connections.get(id)
    if (!entry) return null
    const db = database ?? entry.meta.database
    return entry.columnCache.get(columnCacheKey(db, tableName)) ?? null
  }

  async listDatabases(id: string): Promise<string[]> {
    const entry = this.connections.get(id)
    if (!entry) {
      throw new Error(`No connection found for id "${id}"`)
    }

    const [rows] = await this.queryMeta(entry, 'SHOW DATABASES')
    return (rows as any[]).map((r: any) => (Array.isArray(r) ? r[0] : r.Database) as string)
  }

  /**
   * List tables (and views) in the given database, falling back to the
   * connection's current database.
   *
   * Uses SHOW FULL TABLES (fast data-dictionary path). No INFORMATION_SCHEMA
   * fallback — that path can hang for minutes on large schemas over SSH tunnels.
   */
  async listTables(
    id: string,
    database?: string,
    options?: { forceRefresh?: boolean },
  ): Promise<TableInfo[]> {
    const entry = this.connections.get(id)
    if (!entry) {
      throw new Error(`No connection found for id "${id}"`)
    }

    const db = (database ?? entry.meta.database)?.trim()
    if (!db) {
      throw new Error('No database selected on this connection')
    }

    const forceRefresh = options?.forceRefresh === true
    const cached = entry.tablesListCache
    if (
      !forceRefresh &&
      cached &&
      cached.database === db &&
      Date.now() - cached.at < TABLES_LIST_CACHE_TTL_MS
    ) {
      console.log(
        `[mysql-client] list-tables cache hit id=${id} count=${cached.tables.length}`,
      )
      return cached.tables
    }

    if (!forceRefresh && entry.listTablesInFlight) {
      return entry.listTablesInFlight
    }

    const fetchTables = async (): Promise<TableInfo[]> => {
      return withTimeout(
        (async () => {
          const qualifiedDb = entry.metaConn.escapeId(db)
          const [rows] = await this.queryMeta(entry, `SHOW FULL TABLES FROM ${qualifiedDb}`)

          const tables = (rows as any[]).map((r: any) => {
            const [name, tableType] = parseShowFullTablesRow(r, db)
            return {
              name,
              type: (tableType === 'VIEW' ? 'VIEW' : 'TABLE') as 'TABLE' | 'VIEW',
              engine: null,
              rows: null,
              comment: '',
            }
          })
          tables.sort((a, b) => a.name.localeCompare(b.name))
          entry.tablesListCache = { database: db, tables, at: Date.now() }
          return tables
        })(),
        LIST_TABLES_TIMEOUT_MS,
        `SHOW TABLES timed out after ${LIST_TABLES_TIMEOUT_MS / 1000}s`,
      )
    }

    entry.listTablesInFlight = fetchTables().finally(() => {
      entry.listTablesInFlight = null
    })
    return entry.listTablesInFlight
  }

  /**
   * Describe the columns of a table.
   */
  async describeTable(id: string, tableName: string, database?: string): Promise<ColumnInfo[]> {
    const entry = this.connections.get(id)
    if (!entry) {
      throw new Error(`No connection found for id "${id}"`)
    }

    const db = database ?? entry.meta.database
    const cacheKey = columnCacheKey(db, tableName)
    const cached = entry.columnCache.get(cacheKey)
    if (cached) return cached

    const inflightKey = `${id}\0${cacheKey}`
    return coalesceInflight(entry.describeInFlight, inflightKey, () =>
      this.fetchTableColumns(entry, tableName, db),
    )
  }

  private async fetchTableColumns(
    entry: ConnectionEntry,
    tableName: string,
    db: string,
  ): Promise<ColumnInfo[]> {
    const qualifiedTable = db
      ? `${entry.metaConn.escapeId(db)}.${entry.metaConn.escapeId(tableName)}`
      : entry.metaConn.escapeId(tableName)

    const [rows] = await this.queryMeta(entry, `SHOW FULL COLUMNS FROM ${qualifiedTable}`)

    const columns = (rows as any[]).map((r: any) => {
      // rowsAsArray: [Field, Type, Collation, Null, Key, Default, Extra, Privileges, Comment]
      const row = Array.isArray(r)
        ? r
        : [r.Field, r.Type, r.Collation, r.Null, r.Key, r.Default, r.Extra, r.Privileges, r.Comment]
      return {
        name: row[0] as string,
        type: row[1] as string,
        nullable: row[3] === 'YES',
        key: (row[4] as string) ?? '',
        defaultValue: row[5] != null ? String(row[5]) : null,
        extra: (row[6] as string) ?? '',
      }
    })

    entry.columnCache.set(columnCacheKey(db, tableName), columns)
    return columns
  }

  /**
   * Return a serializable snapshot of all active connections.
   */
  getConnections(): DbConnection[] {
    return Array.from(this.connections.values()).map((e) => ({ ...e.meta }))
  }

  /**
   * Disconnect every active connection. Called on app quit.
   */
  async disconnectAll(): Promise<void> {
    const ids = Array.from(this.connections.keys())
    await Promise.allSettled(ids.map((id) => this.disconnect(id)))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the error indicates the underlying TCP connection is dead
 * (server gone, connection reset, protocol desync, etc.).
 */
function isConnectionLostError(err: any): boolean {
  if (!err) return false
  const code: string = err.code ?? ''
  const fatal: boolean = err.fatal ?? false
  const lostCodes = new Set([
    'PROTOCOL_CONNECTION_LOST',
    'ECONNRESET',
    'ECONNREFUSED',
    'EPIPE',
    'ER_SERVER_SHUTDOWN',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR'
  ])
  return fatal || lostCodes.has(code)
}

/** Shrink large values before IPC so wide rows return faster over the tunnel. */
function sanitizeCellForIpc(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Buffer.isBuffer(value)) {
    return value.length <= MAX_CELL_CHARS ? value : value.subarray(0, MAX_CELL_CHARS)
  }
  if (typeof value === 'string' && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}…`
  }
  if (typeof value === 'object') return value
  const text = String(value)
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const mysqlClient = new MysqlClient()
