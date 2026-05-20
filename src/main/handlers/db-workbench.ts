import { ipcMain } from 'electron'
import { akeylessDb } from '../akeyless-db'
import { mysqlClient } from '../mysql-client'

export function registerDbWorkbenchHandlers() {
  // List available database producers from Akeyless
  ipcMain.handle('db-list-producers', async (_event, type?: 'mysql' | 'mongo') => {
    try {
      console.log('[db-workbench] listing producers, type:', type)
      const producers = await akeylessDb.listProducers(type)
      console.log('[db-workbench] found', producers.length, 'producers')
      return { success: true, producers }
    } catch (err: any) {
      console.error('[db-workbench] listProducers error:', err.message)
      return { success: false, producers: [], error: err.message }
    }
  })

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

      // 2. Wait for the tunnel to be ready (SSH handshake + cert setup takes ~5-8s)
      await new Promise(resolve => setTimeout(resolve, 8000))

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
  ipcMain.handle('db-disconnect', async (_event, connectionId: string) => {
    try {
      await mysqlClient.disconnect(connectionId)
      akeylessDb.closeTunnel(connectionId) // tunnel ID matches connection ID
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  // Execute SQL query
  ipcMain.handle('db-execute-query', async (_event, connectionId: string, sqlText: string) => {
    try {
      return await mysqlClient.executeQuery(connectionId, sqlText)
    } catch (err: any) {
      return { columns: [], rows: [], rowCount: 0, affectedRows: 0, executionTimeMs: 0, error: err.message }
    }
  })

  // List tables in current database
  ipcMain.handle('db-list-tables', async (_event, connectionId: string) => {
    try {
      return { success: true, tables: await mysqlClient.listTables(connectionId) }
    } catch (err: any) {
      return { success: false, tables: [], error: err.message }
    }
  })

  // Describe a table's columns
  ipcMain.handle('db-describe-table', async (_event, connectionId: string, tableName: string) => {
    try {
      return { success: true, columns: await mysqlClient.describeTable(connectionId, tableName) }
    } catch (err: any) {
      return { success: false, columns: [], error: err.message }
    }
  })

  // List databases accessible through the connection
  ipcMain.handle('db-list-databases', async (_event, connectionId: string) => {
    try {
      return { success: true, databases: await mysqlClient.listDatabases(connectionId) }
    } catch (err: any) {
      return { success: false, databases: [], error: err.message }
    }
  })
}
