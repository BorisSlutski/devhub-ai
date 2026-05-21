/**
 * mysql-client.ts — Main-process module for managing MySQL connections via mysql2/promise.
 *
 * Exports a singleton `mysqlClient` instance of `MysqlClient`.
 * All public methods are safe to call from IPC handlers; errors are caught
 * and returned in structured result objects rather than thrown.
 */

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
const CONNECT_TIMEOUT_MS = 10_000
/** Metadata (SHOW TABLES, etc.) over SSH tunnels. */
const QUERY_TIMEOUT_MS = 30_000
/** User SQL — long enough for analytics, short enough to fail visibly. */
const EXEC_QUERY_TIMEOUT_MS = 90_000
const PING_TIMEOUT_MS = 5_000

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
): Promise<[unknown, unknown]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const queryPromise =
      params !== undefined ? connection.query(sql, params) : connection.query(sql)
    return (await Promise.race([
      queryPromise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Query timed out after ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
      }),
    ])) as [unknown, unknown]
  } finally {
    if (timer) clearTimeout(timer)
  }
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
  connection: any // mysql2 Connection (typed as any to stay decoupled from runtime types)
  meta: DbConnection
}

// ---------------------------------------------------------------------------
// MysqlClient
// ---------------------------------------------------------------------------

class MysqlClient {
  private connections: Map<string, ConnectionEntry> = new Map()

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
    })

    // Verify the connection is alive.
    await connection.ping()

    const meta: DbConnection = {
      id,
      host,
      port,
      user,
      database,
      connected: true
    }

    this.connections.set(id, { connection, meta })

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

    try {
      await entry.connection.end()
    } catch {
      // Best-effort — the connection may already be dead.
    }
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

    try {
      await queryWithTimeout(entry.connection, 'SELECT 1', undefined, PING_TIMEOUT_MS)

      const { sql: execSql, rowCapApplied } = capUnboundedSelect(sql, MAX_ROWS)
      const [result, fields] = await queryWithTimeout(
        entry.connection,
        execSql,
        undefined,
        EXEC_QUERY_TIMEOUT_MS,
      )
      const executionTimeMs = Math.round((performance.now() - start) * 100) / 100

      if (Array.isArray(result)) {
        const columns: ColumnDef[] = (fields ?? []).map((f: any) => ({
          name: f.name as string,
          type: fieldTypeName(f.columnType ?? f.type ?? 0),
        }))

        let rows = result as any[][]
        let truncated = false
        if (rows.length > MAX_ROWS) {
          rows = rows.slice(0, MAX_ROWS)
          truncated = true
        }

        return {
          columns,
          rows,
          rowCount: rows.length,
          affectedRows: 0,
          executionTimeMs,
          rowCapApplied,
          truncated,
        }
      }

      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: (result as any).affectedRows ?? 0,
        executionTimeMs,
      }
    } catch (err: any) {
      const executionTimeMs = Math.round((performance.now() - start) * 100) / 100
      const msg = err?.message ?? String(err)

      if (/timed out/i.test(msg) || isConnectionLostError(err)) {
        entry.meta.connected = false
        this.connections.delete(id)
        try {
          await entry.connection.destroy()
        } catch {
          // best effort — free the tunnel port for a reconnect
        }
      }

      return {
        ...empty,
        executionTimeMs,
        error: msg,
      }
    }
  }

  /**
   * List all databases the connected user can see.
   */
  async listDatabases(id: string): Promise<string[]> {
    const entry = this.connections.get(id)
    if (!entry) {
      throw new Error(`No connection found for id "${id}"`)
    }

    try {
      const [rows] = await queryWithTimeout(entry.connection, 'SHOW DATABASES')
      return (rows as any[]).map((r: any) => (Array.isArray(r) ? r[0] : r.Database) as string)
    } catch (err: any) {
      if (isConnectionLostError(err)) entry.meta.connected = false
      throw err
    }
  }

  /**
   * List tables (and views) in the given database, falling back to the
   * connection's current database.
   *
   * Uses SHOW FULL TABLES (fast data-dictionary path). No INFORMATION_SCHEMA
   * fallback — that path can hang for minutes on large schemas over SSH tunnels.
   */
  async listTables(id: string, database?: string): Promise<TableInfo[]> {
    const entry = this.connections.get(id)
    if (!entry) {
      throw new Error(`No connection found for id "${id}"`)
    }

    const db = (database ?? entry.meta.database)?.trim()
    if (!db) {
      throw new Error('No database selected on this connection')
    }

    try {
      const qualifiedDb = entry.connection.escapeId(db)
      const [rows] = await queryWithTimeout(
        entry.connection,
        `SHOW FULL TABLES FROM ${qualifiedDb}`,
      )

      const tables = (rows as any[]).map((r: any) => {
        const [name, tableType] = parseShowFullTablesRow(r, db)
        return {
          name,
          type: (tableType === 'VIEW' ? 'VIEW' : 'TABLE') as 'TABLE' | 'VIEW',
          engine: null,
          rows: null,
          comment: ''
        }
      })
      tables.sort((a, b) => a.name.localeCompare(b.name))
      return tables
    } catch (err: any) {
      if (isConnectionLostError(err)) entry.meta.connected = false
      throw err
    }
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

    try {
      // Escape database and table identifiers to prevent injection.
      // mysql2 connection.escapeId handles backtick-quoting.
      const qualifiedTable = database
        ? `${entry.connection.escapeId(db)}.${entry.connection.escapeId(tableName)}`
        : entry.connection.escapeId(tableName)

      const [rows] = await entry.connection.query(`SHOW FULL COLUMNS FROM ${qualifiedTable}`)

      return (rows as any[]).map((r: any) => {
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
          extra: (row[6] as string) ?? ''
        }
      })
    } catch (err: any) {
      if (isConnectionLostError(err)) entry.meta.connected = false
      throw err
    }
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
/**
 * Append LIMIT to bare SELECT/WITH so MySQL does not stream millions of rows over the tunnel.
 */
function capUnboundedSelect(
  sql: string,
  maxRows: number,
): { sql: string; rowCapApplied: boolean } {
  const trimmed = sql.trim()
  const body = trimmed.replace(/;+\s*$/, '')
  if (/;\s*\S/.test(body)) return { sql, rowCapApplied: false }
  if (!/^\s*(select|with)\b/i.test(body)) return { sql, rowCapApplied: false }
  if (/\blimit\s+(\d+|\?)/i.test(body)) return { sql, rowCapApplied: false }
  return { sql: `${body} LIMIT ${maxRows + 1}`, rowCapApplied: true }
}

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

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const mysqlClient = new MysqlClient()
