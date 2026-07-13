/**
 * trino-client.ts — Main-process module for managing Trino connections via the
 * `trino-client` REST client (no SSH tunnel needed — direct HTTPS to the coordinator).
 *
 * Exports a singleton `trinoClient` instance of `TrinoClientManager`.
 * All public methods are safe to call from IPC handlers; errors are caught
 * and returned in structured result objects rather than thrown.
 */

import { Trino, BasicAuth } from 'trino-client'
import { capUnboundedSelect } from '../shared/sql-limit'
import { normalizeWixUser } from './trino-user'

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface TableMatch {
  catalog: string
  schema: string
  name: string
}

export interface QueryResult {
  columns: ColumnDef[]
  rows: any[][]
  rowCount: number
  affectedRows: number
  executionTimeMs: number
  error?: string
  truncated?: boolean
  /** True when an unbounded SELECT/WITH was auto-capped with LIMIT. */
  rowCapApplied?: boolean
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

/** Workbench preview cap — UI shows 250 rows; keep fetch small for wide Trino tables. */
const MAX_ROWS = 1_000
const QUERY_TIMEOUT_MS = 90_000
const CONNECT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Internal metadata stored alongside each connection
// ---------------------------------------------------------------------------

interface ConnectionEntry {
  client: Trino
  meta: TrinoConnection
  /** queryId of the currently in-flight query, for cancelQuery. */
  currentQueryId: string | null
  /** Set when cancelQuery runs before the first page arrives — executeQuery
   *  issues the server-side cancel itself once currentQueryId becomes known. */
  cancelRequested: boolean
  /** Bumped on cancel so an in-flight executeQuery does not apply stale results. */
  generation: number
}

function previewSql(sql: string, max = 120): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`
}

/** Quote a Trino identifier segment (catalog/schema/table) — doubles embedded quotes. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function escapeSqlLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/%/g, '\\%').replace(/_/g, '\\_')
}

function sqlLikePattern(value: string): string {
  return `'%${escapeSqlLike(value)}%' ESCAPE '\\'`
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

    const normalizedUser = normalizeWixUser(user)
    const client = Trino.create({
      server,
      catalog: catalog || undefined,
      schema: schema || undefined,
      auth: new BasicAuth(normalizedUser, password || undefined),
    })

    // Verify the credentials/server actually work before handing back a "connected" state.
    await withTimeout(
      (async () => {
        const iter = await client.query({ query: 'SELECT 1', user: normalizedUser })
        for await (const page of iter) {
          if (page.error) {
            throw new Error(page.error.message)
          }
        }
      })(),
      CONNECT_TIMEOUT_MS,
      `Trino connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`,
    )

    const meta: TrinoConnection = { id, server, catalog, schema, user: normalizedUser, connected: true }
    this.connections.set(id, {
      client,
      meta,
      currentQueryId: null,
      cancelRequested: false,
      generation: 0,
    })

    return { ...meta }
  }

  disconnect(id: string): void {
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
    const deadline = Date.now() + QUERY_TIMEOUT_MS
    const generationAtStart = entry.generation
    entry.currentQueryId = null
    entry.cancelRequested = false
    let cancelIssued = false
    const issueQueryCancel = async () => {
      if (cancelIssued) return
      cancelIssued = true
      await cancelInFlightQuery(entry)
    }

    try {
      const { sql: execSql, rowCapApplied } = capUnboundedSelect(sql, MAX_ROWS)
      console.log(`[trino-client] query start id=${id} sql=${previewSql(execSql)}`)
      let iter: AsyncIterator<unknown>
      try {
        iter = await withTimeout(
          entry.client.query({ query: execSql, user: entry.meta.user }),
          Math.max(1, deadline - Date.now()),
          `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s`,
        )
      } catch (queryErr) {
        await issueQueryCancel()
        throw queryErr
      }

      const columns: ColumnDef[] = []
      const rows: any[][] = []
      let truncated = false

      // Manual iteration (not `for await`) so each page fetch is bounded by the
      // overall deadline — `for await` would only bound the initial call above,
      // letting a slow/stuck query page through results indefinitely.
      while (true) {
        if (entry.generation !== generationAtStart) {
          return { ...empty, error: 'Query cancelled' }
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          await issueQueryCancel()
          throw new Error(`Query timed out after ${QUERY_TIMEOUT_MS / 1000}s`)
        }
        let pageResult: IteratorResult<unknown>
        try {
          pageResult = await withTimeout(
            iter.next(),
            remaining,
            `Query timed out after ${QUERY_TIMEOUT_MS / 1000}s`,
          )
        } catch (timeoutErr) {
          await issueQueryCancel()
          throw timeoutErr
        }
        const page = pageResult.value as {
          id?: string
          error?: { message: string }
          columns?: { name: string; type: string }[]
          data?: unknown[][]
        }
        const { done } = pageResult
        if (done) break
        if (page.id) {
          entry.currentQueryId = page.id
          if (entry.cancelRequested) {
            entry.cancelRequested = false
            try {
              await entry.client.cancel(page.id)
            } catch {
              // best effort — generation bump already voids this result either way
            }
            return { ...empty, error: 'Query cancelled' }
          }
        }
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
        if (truncated) {
          await issueQueryCancel()
          break
        }
      }

      if (rows.length > MAX_ROWS) {
        rows.length = MAX_ROWS
        truncated = true
      }

      const executionTimeMs = Math.round((performance.now() - start) * 100) / 100
      console.log(
        `[trino-client] query ok id=${id} total=${executionTimeMs}ms rows=${rows.length} capped=${rowCapApplied} sql=${previewSql(execSql)}`,
      )

      return {
        columns,
        rows,
        rowCount: rows.length,
        affectedRows: 0,
        executionTimeMs,
        truncated,
        rowCapApplied,
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
   * Cancel the currently in-flight query. Trino's cancel API requires the
   * queryId, which we only learn once the first page returns — if that
   * hasn't happened yet, `cancelRequested` tells executeQuery's loop to
   * issue the server-side cancel itself as soon as the queryId arrives.
   */
  async cancelQuery(id: string): Promise<{ success: boolean; error?: string }> {
    const entry = this.connections.get(id)
    if (!entry) {
      return { success: false, error: `No connection found for id "${id}"` }
    }
    entry.generation += 1
    if (!entry.currentQueryId) {
      entry.cancelRequested = true
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
    const res = await this.executeQuery(id, `SHOW SCHEMAS FROM ${quoteIdent(catalog)}`)
    if (res.error) throw new Error(res.error)
    return res.rows.map((r) => String(r[0]))
  }

  /** List tables in catalog.schema, falling back to the connection's current catalog/schema. */
  async listTables(id: string, catalog?: string, schema?: string, nameFilter?: string): Promise<string[]> {
    const entry = this.connections.get(id)
    if (!entry) throw new Error(`No connection found for id "${id}"`)
    const cat = catalog ?? entry.meta.catalog
    const sch = schema ?? entry.meta.schema
    if (!cat || !sch) throw new Error('No catalog/schema selected on this connection')
    const filter = nameFilter?.trim()
    const sql = filter
      ? `SHOW TABLES FROM ${quoteIdent(cat)}.${quoteIdent(sch)} LIKE ${sqlLikePattern(filter)}`
      : `SHOW TABLES FROM ${quoteIdent(cat)}.${quoteIdent(sch)}`
    const res = await this.executeQuery(id, sql)
    if (res.error) throw new Error(res.error)
    return res.rows.map((r) => String(r[0]))
  }

  /**
   * Find tables by name — scoped to catalog.schema when provided, otherwise searches
   * across accessible catalogs via system.jdbc.tables.
   */
  async searchTables(
    id: string,
    nameFilter: string,
    catalog?: string,
    schema?: string,
  ): Promise<TableMatch[]> {
    const filter = nameFilter.trim()
    if (catalog && schema) {
      const names = filter
        ? await this.listTables(id, catalog, schema, filter)
        : await this.listTables(id, catalog, schema)
      return names.map((name) => ({ catalog, schema, name }))
    }
    if (!filter) return []

    const entry = this.connections.get(id)
    const globalSql = `SELECT table_cat, table_schem, table_name
FROM system.jdbc.tables
WHERE table_type = 'TABLE'
  AND LOWER(table_name) LIKE LOWER(${sqlLikePattern(filter)})
ORDER BY table_cat, table_schem, table_name
LIMIT 100`
    const res = await this.executeQuery(id, globalSql)
    if (!res.error) {
      return res.rows.map((r) => ({
        catalog: String(r[0]),
        schema: String(r[1]),
        name: String(r[2]),
      }))
    }

    const fallbackCatalog = catalog ?? entry?.meta.catalog
    const fallbackSchema = schema ?? entry?.meta.schema
    if (fallbackCatalog && fallbackSchema) {
      const names = await this.listTables(id, fallbackCatalog, fallbackSchema, filter)
      return names.map((name) => ({
        catalog: fallbackCatalog,
        schema: fallbackSchema,
        name,
      }))
    }

    throw new Error(
      `Global table search failed (${res.error}). Try catalog.schema.table_name in the search box.`,
    )
  }

  /** DESCRIBE catalog.schema.table — returns Column/Type/Extra/Comment. */
  async describeTable(id: string, tableName: string, catalog?: string, schema?: string): Promise<ColumnInfo[]> {
    const entry = this.connections.get(id)
    if (!entry) throw new Error(`No connection found for id "${id}"`)
    const cat = catalog ?? entry.meta.catalog
    const sch = schema ?? entry.meta.schema
    const qualified =
      cat && sch
        ? `${quoteIdent(cat)}.${quoteIdent(sch)}.${quoteIdent(tableName)}`
        : quoteIdent(tableName)
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

async function cancelInFlightQuery(entry: ConnectionEntry): Promise<void> {
  entry.generation += 1
  const queryId = entry.currentQueryId
  if (queryId) {
    try {
      await entry.client.cancel(queryId)
    } catch {
      // best effort
    }
  } else {
    entry.cancelRequested = true
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
