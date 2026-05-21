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
        cluster: tunnel.cluster,
        database: tunnel.dbName,
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
      const mysqlConns = mysqlClient.getConnections()
      const mysqlIds = new Set(mysqlConns.map((c) => c.id))
      const sessions = tunnels
        .filter((t) => mysqlIds.has(t.id))
        .map((t) => ({
          connectionId: t.id,
          tunnelId: t.id,
          cluster: t.cluster,
          database: t.dbName || t.database,
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
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Execute SQL query
  ipcMain.handle('db-execute-query', async (_event, connectionId: string, sqlText: string) => {
    touchConnection(connectionId)
    const started = Date.now()
    try {
      const result = await mysqlClient.executeQuery(connectionId, sqlText)
      console.log(
        `[db-workbench] query ok connection=${connectionId} rows=${result.rowCount} ms=${Date.now() - started}`,
      )
      return result
    } catch (err: any) {
      console.error(
        `[db-workbench] query failed connection=${connectionId} ms=${Date.now() - started}:`,
        err.message,
      )
      return { columns: [], rows: [], rowCount: 0, affectedRows: 0, executionTimeMs: 0, error: err.message }
    }
  })

  // List tables in current database
  ipcMain.handle('db-list-tables', async (_event, connectionId: string) => {
    touchConnection(connectionId)
    const started = Date.now()
    try {
      const tables = await mysqlClient.listTables(connectionId)
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
  })

  // Describe a table's columns
  ipcMain.handle('db-describe-table', async (_event, connectionId: string, tableName: string) => {
    touchConnection(connectionId)
    try {
      return { success: true, columns: await mysqlClient.describeTable(connectionId, tableName) }
    } catch (err: any) {
      return { success: false, columns: [], error: err.message }
    }
  })

  // List databases accessible through the connection
  ipcMain.handle('db-list-databases', async (_event, connectionId: string) => {
    touchConnection(connectionId)
    try {
      return { success: true, databases: await mysqlClient.listDatabases(connectionId) }
    } catch (err: any) {
      return { success: false, databases: [], error: err.message }
    }
  })
}
