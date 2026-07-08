/**
 * trino-client.ts — Main-process module for managing Trino connections via the
 * `trino-client` REST client (no SSH tunnel needed — direct HTTPS to the coordinator).
 *
 * Exports a singleton `trinoClient` instance of `TrinoClientManager`.
 * All public methods are safe to call from IPC handlers; errors are caught
 * and returned in structured result objects rather than thrown.
 */

import { Trino, BasicAuth } from 'trino-client'

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
  truncated?: boolean
}

export interface ColumnDef {
  name: string
  type: string
}

export interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  key: string
  defaultValue: string | null
  extra: string
}

export interface TrinoConnection {
  id: string
  server: string
  catalog: string
  schema: string
  user: string
  connected: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_ROWS = 10_000
const QUERY_TIMEOUT_MS = 90_000

// ---------------------------------------------------------------------------
// Internal metadata stored alongside each connection
// ---------------------------------------------------------------------------

interface ConnectionEntry {
  client: Trino
  meta: TrinoConnection
  password: string
  /** queryId of the currently in-flight query, for cancelQuery. */
  currentQueryId: string | null
  /** Bumped on cancel so an in-flight executeQuery does not apply stale results. */
  generation: number
}

function previewSql(sql: string, max = 120): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

// ---------------------------------------------------------------------------
// TrinoClientManager
// ---------------------------------------------------------------------------

class TrinoClientManager {
  private connections: Map<string, ConnectionEntry> = new Map()

  /**
   * Connect to a Trino coordinator. Verified with a `SELECT 1` before the
   * connection is considered live.
   */
  async connect(
    id: string,
    server: string,
    catalog: string,
    schema: string,
    user: string,
    password: string,
  ): Promise<TrinoConnection> {
    if (this.connections.has(id)) {
      this.disconnect(id)
    }

    const client = Trino.create({
      server,
      catalog: catalog || undefined,
      schema: schema || undefined,
      auth: new BasicAuth(user, password || undefined),
    })

    // Verify the credentials/server actually work before handing back a "connected" state.
    const iter = await client.query('SELECT 1')
    for await (const page of iter) {
      if (page.error) {
        throw new Error(page.error.message)
      }
    }

    const meta: TrinoConnection = { id, server, catalog, schema, user, connected: true }
    this.connections.set(id, {
      client,
      meta,
      password,
      currentQueryId: null,
      generation: 0,
    })

    return { ...meta }
  }

  disconnect(id: string): void {
    const entry = this.connections.get(id)
    if (!entry) return
    entry.meta.connected = false
    this.connections.delete(id)
  }

  /**
   * Execute an arbitrary SQL statement and return a structured result.
   * Trino streams results across multiple pages (nextUri) — we accumulate
   * them here, capping at MAX_ROWS the same way the MySQL workbench does.
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
    entry.currentQueryId = null

    try {
      console.log(`[trino-client] query start id=${id} sql=${previewSql(sql)}`)
      const iter = await withTimeout(
        entry.client.query(sql),
        QUERY_TIMEOUT_MS,
        `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s`,
      )

      const columns: ColumnDef[] = []
      const rows: any[][] = []
      let truncated = false

      for await (const page of iter) {
        if (entry.generation !== generationAtStart) {
          return { ...empty, error: 'Query cancelled' }
        }
        if (page.id) entry.currentQueryId = page.id
        if (page.error) {
          throw new Error(page.error.message)
        }
        if (columns.length === 0 && page.columns) {
          columns.push(...page.columns.map((c) => ({ name: c.name, type: c.type })))
        }
        if (page.data) {
          for (const row of page.data) {
            if (rows.length >= MAX_ROWS) {
              truncated = true
              break
            }
            rows.push(row)
          }
        }
        if (truncated) break
      }

      const executionTimeMs = Math.round((performance.now() - start) * 100) / 100
      console.log(
        `[trino-client] query ok id=${id} total=${executionTimeMs}ms rows=${rows.length} sql=${previewSql(sql)}`,
      )

      return {
        columns,
        rows,
        rowCount: rows.length,
        affectedRows: 0,
        executionTimeMs,
        truncated,
      }
    } catch (err: any) {
      const executionTimeMs = Math.round((performance.now() - start) * 100) / 100
      const msg = err?.message ?? String(err)
      console.error(
        `[trino-client] query failed id=${id} total=${executionTimeMs}ms sql=${previewSql(sql)} err=${msg}`,
      )
      if (entry.generation !== generationAtStart) {
        return { ...empty, executionTimeMs, error: 'Query cancelled' }
      }
      return { ...empty, executionTimeMs, error: msg }
    }
  }

  /**
   * Cancel the currently in-flight query (best effort — Trino's cancel API
   * requires the queryId, which we only learn once the first page returns).
   */
  async cancelQuery(id: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.connections.get(id)
    if (!entry) {
      return { success: false, error: `No connection found for id "${id}"` }
    }
    entry.generation += 1
    if (!entry.currentQueryId) {
      return { success: true }
    }
    try {
      await entry.client.cancel(entry.currentQueryId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err?.message ?? String(err) }
    }
  }

  isConnected(id: string): boolean {
    return this.connections.get(id)?.meta.connected === true
  }

  hasConnection(id: string): boolean {
    return this.connections.has(id)
  }

  async listCatalogs(id: string): Promise<string[]> {
    const res = await this.executeQuery(id, 'SHOW CATALOGS')
    if (res.error) throw new Error(res.error)
    return res.rows.map((r) => String(r[0]))
  }

  async listSchemas(id: string, catalog: string): Promise<string[]> {
    const res = await this.executeQuery(id, `SHOW SCHEMAS FROM ${catalog}`)
    if (res.error) throw new Error(res.error)
    return res.rows.map((r) => String(r[0]))
  }

  /** List tables in catalog.schema, falling back to the connection's current catalog/schema. */
  async listTables(id: string, catalog?: string, schema?: string): Promise<string[]> {
    const entry = this.connections.get(id)
    if (!entry) throw new Error(`No connection found for id "${id}"`)
    const cat = catalog ?? entry.meta.catalog
    const sch = schema ?? entry.meta.schema
    if (!cat || !sch) throw new Error('No catalog/schema selected on this connection')
    const res = await this.executeQuery(id, `SHOW TABLES FROM ${cat}.${sch}`)
    if (res.error) throw new Error(res.error)
    return res.rows.map((r) => String(r[0]))
  }

  /** DESCRIBE catalog.schema.table — returns Column/Type/Extra/Comment. */
  async describeTable(id: string, tableName: string, catalog?: string, schema?: string): Promise<ColumnInfo[]> {
    const entry = this.connections.get(id)
    if (!entry) throw new Error(`No connection found for id "${id}"`)
    const cat = catalog ?? entry.meta.catalog
    const sch = schema ?? entry.meta.schema
    const qualified = cat && sch ? `${cat}.${sch}.${tableName}` : tableName
    const res = await this.executeQuery(id, `DESCRIBE ${qualified}`)
    if (res.error) throw new Error(res.error)
    // DESCRIBE columns: Column, Type, Extra, Comment
    return res.rows.map((r) => ({
      name: String(r[0]),
      type: String(r[1]),
      nullable: true,
      key: '',
      defaultValue: null,
      extra: r[2] != null ? String(r[2]) : '',
    }))
  }

  getConnections(): TrinoConnection[] {
    return Array.from(this.connections.values()).map((e) => ({ ...e.meta }))
  }

  disconnectAll(): void {
    for (const id of Array.from(this.connections.keys())) this.disconnect(id)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const trinoClient = new TrinoClientManager()
