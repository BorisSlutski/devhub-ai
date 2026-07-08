import { createConnection } from 'net'
import { ipcMain } from 'electron'
import { akeylessDb } from '../akeyless-db'
import { mysqlClient } from '../mysql-client'
import {
  registerDbConnection,
  touchDbConnection,
  clearDbConnectionIdle,
} from '../db-connection-idle'

function touchConnection(connectionId: string): void {
  touchDbConnection(connectionId)
}

// Generous enough to cover the force-tunnel-restart fallback below (SSH reopen +
// Akeyless auth can take 20-30s on its own) — the fast path (tunnel already healthy)
// returns almost immediately regardless.
const ENSURE_CONNECTION_TIMEOUT_MS = 60_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

/** Reopen MySQL on the existing SSH tunnel when the socket was dropped (timeout/cancel). */
async function ensureDbConnection(connectionId: string): Promise<string | null> {
  let tunnel = akeylessDb.getTunnel(connectionId)
  if (!tunnel) {
    const meta = akeylessDb.getConnectionMeta(connectionId)
    if (!meta) {
      return 'SSH tunnel is closed. Disconnect this tab and connect again.'
    }
    try {
      console.log(`[db-workbench] tunnel missing for ${connectionId}, reopening SSH…`)
      const reopened = await akeylessDb.reopenTunnel(connectionId)
      await waitForLocalPort(reopened.localPort)
      tunnel = akeylessDb.getTunnel(connectionId)
      if (!tunnel) {
        return 'SSH tunnel failed to reopen. Try Reconnect or connect again.'
      }
    } catch (err: any) {
      return err?.message ?? String(err)
    }
  }

  if (mysqlClient.isConnected(connectionId)) return null

  if (mysqlClient.isQueryInFlight(connectionId)) {
    return 'A query is still running — wait or cancel before reconnecting.'
  }

  const reconnect = async (user: string, password: string, localPort: number, dbName: string) => {
    await mysqlClient.reconnect(connectionId, '127.0.0.1', localPort, user, password, dbName)
    registerDbConnection(connectionId)
  }

  try {
    await reconnect(tunnel.credentials.user, tunnel.credentials.password, tunnel.localPort, tunnel.dbName)
    return null
  } catch {
    try {
      const credentials = await akeylessDb.getCredentials(tunnel.producerName)
      tunnel.credentials = credentials
      await reconnect(credentials.user, credentials.password, tunnel.localPort, tunnel.dbName)
      return null
    } catch {
      // Both attempts failed on the existing local port. The SSH tunnel *process*
      // can still be alive (so we never took the "tunnel missing" branch above)
      // while the forward itself is silently stuck — e.g. after sleep/wake or a
      // bastion-side drop the local client doesn't notice. Reconnecting MySQL to
      // the same dead port just repeats the same hang on every query. Force a
      // full tunnel restart on a fresh port as a last resort before giving up.
      try {
        console.log(
          `[db-workbench] mysql reconnect failed twice for ${connectionId}, forcing SSH tunnel restart…`,
        )
        const reopened = await akeylessDb.reopenTunnel(connectionId)
        await waitForLocalPort(reopened.localPort)
        tunnel = akeylessDb.getTunnel(connectionId)
        if (!tunnel) {
          return 'SSH tunnel failed to reopen. Try Reconnect or connect again.'
        }
        await reconnect(tunnel.credentials.user, tunnel.credentials.password, tunnel.localPort, tunnel.dbName)
        return null
      } catch (err: any) {
        return err?.message ?? String(err)
      }
    }
  }
}

async function ensureDbConnectionWithTimeout(connectionId: string): Promise<string | null> {
  try {
    return await withTimeout(
      ensureDbConnection(connectionId),
      ENSURE_CONNECTION_TIMEOUT_MS,
      `Reconnect timed out after ${ENSURE_CONNECTION_TIMEOUT_MS / 1000}s`,
    )
  } catch (err: any) {
    return err?.message ?? String(err)
  }
}

/** Wait until the SSH local forward accepts TCP (replaces fixed 8s sleep). */
function waitForLocalPort(port: number, timeoutMs = 25_000): Promise<void> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const probe = () => {
      const sock = createConnection({ host: '127.0.0.1', port }, () => {
        sock.destroy()
        resolve()
      })
      sock.on('error', () => {
        sock.destroy()
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Tunnel port ${port} not ready after ${timeoutMs / 1000}s`))
          return
        }
        setTimeout(probe, 400)
      })
    }
    probe()
  })
}

export function registerDbWorkbenchHandlers() {
  // List available database producers from Akeyless
  ipcMain.handle(
    'db-list-producers',
    async (_event, type?: 'mysql' | 'mongo', forceRefresh?: boolean) => {
      try {
        console.log('[db-workbench] listing producers, type:', type, 'forceRefresh:', !!forceRefresh)
        const { producers, stale } = await akeylessDb.listProducers(type, { forceRefresh })
        console.log('[db-workbench] found', producers.length, 'producers', stale ? '(stale cache)' : '')
        return { success: true, producers, stale: !!stale }
      } catch (err: any) {
        console.error('[db-workbench] listProducers error:', err.message)
        return { success: false, producers: [], error: err.message }
      }
    },
  )

  // Connect: open tunnel + get credentials + connect MySQL
  ipcMain.handle('db-connect', async (_event, producerName: string) => {
    let tunnelId: string | undefined
    try {
      console.log('[db-workbench] connecting to:', producerName)

      // 1. Open SSH tunnel (gets credentials + spawns akeyless connect)
      console.log('[db-workbench] opening tunnel...')
      const tunnel = await akeylessDb.openTunnel(producerName)
      tunnelId = tunnel.id
      console.log('[db-workbench] tunnel open on port', tunnel.localPort)

      // 2. Wait until the local forward accepts connections
      await waitForLocalPort(tunnel.localPort)

      // 3. Connect MySQL through the tunnel (use 127.0.0.1 not localhost — avoids IPv6 ::1)
      console.log('[db-workbench] connecting MySQL to 127.0.0.1:', tunnel.localPort, 'db:', tunnel.dbName)
      const conn = await mysqlClient.connect(
        tunnel.id,
        '127.0.0.1',
        tunnel.localPort,
        tunnel.credentials.user,
        tunnel.credentials.password,
        tunnel.dbName
      )
      console.log('[db-workbench] MySQL connected, id:', conn.id)
      registerDbConnection(conn.id)

      return {
        success: true,
        connectionId: conn.id,
        tunnelId: tunnel.id,
        kgb: tunnel.kgb,
        dbName: tunnel.dbName,
        type: tunnel.type,
      }
    } catch (err: any) {
      console.error('[db-workbench] connect error:', err.message)
      if (tunnelId) {
        try {
          await mysqlClient.disconnect(tunnelId)
        } catch {
          // ignore
        }
        akeylessDb.closeTunnel(tunnelId)
      }
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('db-list-connections', async () => {
    try {
      return { success: true, connections: mysqlClient.getConnections() }
    } catch (err: any) {
      return { success: false, connections: [], error: err.message }
    }
  })

  // Disconnect: close MySQL connection + tunnel
  ipcMain.handle('db-list-sessions', async () => {
    try {
      const tunnels = akeylessDb.getActiveTunnels()
      const sessions = tunnels.map((t) => ({
        connectionId: t.id,
        tunnelId: t.id,
        kgb: t.kgb,
        dbName: t.dbName,
        producerName: t.producerName,
      }))
      return { success: true, sessions }
    } catch (err: any) {
      return { success: false, sessions: [], error: err.message }
    }
  })

  ipcMain.handle('db-disconnect', async (_event, connectionId: string) => {
    try {
      clearDbConnectionIdle(connectionId)
      await mysqlClient.disconnect(connectionId)
      akeylessDb.closeTunnel(connectionId) // tunnel ID matches connection ID
      akeylessDb.clearConnectionMeta(connectionId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('db-reconnect', async (_event, connectionId: string) => {
    touchConnection(connectionId)
    try {
      const err = await ensureDbConnectionWithTimeout(connectionId)
      return err ? { success: false, error: err } : { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Execute SQL query
  ipcMain.handle('db-execute-query', async (_event, connectionId: string, sqlText: string) => {
    touchConnection(connectionId)
    const ensureStarted = Date.now()
    const ensureErr = await ensureDbConnectionWithTimeout(connectionId)
    const ensureMs = Date.now() - ensureStarted
    if (ensureErr) {
      console.error(
        `[db-workbench] query failed connection=${connectionId} ensure=${ensureMs}ms sql=${sqlText.trim().slice(0, 120)} err=${ensureErr}`,
      )
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 0,
        executionTimeMs: 0,
        error: ensureErr,
      }
    }
    const started = Date.now()
    const preview = sqlText.trim().replace(/\s+/g, ' ').slice(0, 120)
    console.log(`[db-workbench] query start connection=${connectionId} ensure=${ensureMs}ms sql=${preview}`)
    try {
      const result = await mysqlClient.executeQuery(connectionId, sqlText)
      console.log(
        `[db-workbench] query done connection=${connectionId} ensure=${ensureMs}ms total=${Date.now() - started}ms mysql=${result.executionTimeMs}ms rows=${result.rowCount} optimized=${!!result.tunnelOptimized}`,
      )
      return result
    } catch (err: any) {
      console.error(
        `[db-workbench] query failed connection=${connectionId} ensure=${ensureMs}ms ms=${Date.now() - started}:`,
        err.message,
      )
      return { columns: [], rows: [], rowCount: 0, affectedRows: 0, executionTimeMs: 0, error: err.message }
    }
  })

  ipcMain.handle('db-cancel-query', async (_event, connectionId: string) => {
    touchConnection(connectionId)
    if (!mysqlClient.hasConnection(connectionId)) {
      return { success: false, error: 'No connection found for this tab.' }
    }
    try {
      return await mysqlClient.cancelQuery(connectionId)
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // List tables in current database
  ipcMain.handle(
    'db-list-tables',
    async (_event, connectionId: string, forceRefresh?: boolean) => {
      touchConnection(connectionId)
      const needsReconnect =
        !mysqlClient.hasConnection(connectionId) || !mysqlClient.isConnected(connectionId)
      if (needsReconnect) {
        const ensureErr = await ensureDbConnectionWithTimeout(connectionId)
        if (ensureErr) {
          return { success: false, tables: [], error: ensureErr }
        }
      }
      const started = Date.now()
      try {
        const tables = await withTimeout(
          mysqlClient.listTables(connectionId, undefined, {
            forceRefresh: forceRefresh === true,
          }),
          55_000,
          'List tables timed out after 55s',
        )
        console.log(
          `[db-workbench] list-tables ok connection=${connectionId} count=${tables.length} ms=${Date.now() - started}`,
        )
        return { success: true, tables }
      } catch (err: any) {
        console.error(
          `[db-workbench] list-tables failed connection=${connectionId} ms=${Date.now() - started}:`,
          err.message,
        )
        return { success: false, tables: [], error: err.message }
      }
    },
  )

  // Describe a table's columns (uses cache when SELECT * preview already ran DESCRIBE)
  ipcMain.handle('db-describe-table', async (_event, connectionId: string, tableName: string) => {
    touchConnection(connectionId)
    const started = Date.now()
    const cached = mysqlClient.getTableColumnsCache(connectionId, tableName)
    if (cached) {
      console.log(
        `[db-workbench] describe-table cache hit connection=${connectionId} table=${tableName} cols=${cached.length}`,
      )
      return { success: true, columns: cached }
    }
    const needsReconnect =
      !mysqlClient.hasConnection(connectionId) || !mysqlClient.isConnected(connectionId)
    if (needsReconnect) {
      const ensureErr = await ensureDbConnectionWithTimeout(connectionId)
      if (ensureErr) {
        return { success: false, columns: [], error: ensureErr }
      }
    }
    try {
      const columns = await mysqlClient.describeTable(connectionId, tableName)
      console.log(
        `[db-workbench] describe-table ok connection=${connectionId} table=${tableName} cols=${columns.length} ms=${Date.now() - started}`,
      )
      return { success: true, columns }
    } catch (err: any) {
      console.error(
        `[db-workbench] describe-table failed connection=${connectionId} table=${tableName} ms=${Date.now() - started}:`,
        err.message,
      )
      return { success: false, columns: [], error: err.message }
    }
  })

  // List databases accessible through the connection
  ipcMain.handle('db-list-databases', async (_event, connectionId: string) => {
    touchConnection(connectionId)
    const ensureErr = await ensureDbConnectionWithTimeout(connectionId)
    if (ensureErr) {
      return { success: false, databases: [], error: ensureErr }
    }
    try {
      return { success: true, databases: await mysqlClient.listDatabases(connectionId) }
    } catch (err: any) {
      return { success: false, databases: [], error: err.message }
    }
  })
}
