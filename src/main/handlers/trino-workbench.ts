import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { trinoClient } from '../trino-client'
import {
  saveTrinoCredential,
  getTrinoCredential,
  deleteTrinoCredential,
  hasTrinoCredential,
} from '../trino-credentials-store'
import { normalizeWixUser, parseTrinoServerInput } from '../trino-user'

export interface TrinoProfile {
  id: string
  label: string
  server: string
  catalog: string
  schema: string
  user: string
}

/** Known internal Trino coordinators — user still supplies catalog/schema/credentials. */
export const TRINO_SERVER_PRESETS: { label: string; server: string }[] = [
  { label: 'presto-router.wixpress.com', server: 'https://presto-router.wixpress.com:443' },
  { label: 'trino.wixprod.net', server: 'https://trino.wixprod.net:443' },
]

export function registerTrinoWorkbenchHandlers() {
  ipcMain.handle('trino-server-presets', async () => {
    return { success: true, presets: TRINO_SERVER_PRESETS }
  })

  ipcMain.handle('trino-has-saved-credential', async (_event, server: string, user: string) => {
    try {
      const resolvedServer = parseTrinoServerInput(server).server
      return { success: true, hasCredential: hasTrinoCredential(resolvedServer, user) }
    } catch (err: any) {
      return { success: false, hasCredential: false, error: err.message }
    }
  })

  ipcMain.handle(
    'trino-connect',
    async (
      _event,
      connectionId: string,
      server: string,
      catalog: string,
      schema: string,
      user: string,
      password: string,
      savePassword?: boolean,
    ) => {
      try {
        const parsed = parseTrinoServerInput(server)
        const resolvedServer = parsed.server
        if (!resolvedServer) {
          return { success: false, error: 'Server is required' }
        }
        const resolvedCatalog = (catalog || parsed.catalog || '').trim()
        const resolvedSchema = (schema || parsed.schema || '').trim()
        const resolvedUser = normalizeWixUser(user)
        const resolvedPassword =
          password || getTrinoCredential(resolvedServer, resolvedUser) || ''
        if (!resolvedPassword) {
          return { success: false, error: 'Password is required' }
        }

        console.log(
          `[trino-workbench] connecting id=${connectionId} server=${resolvedServer} catalog=${resolvedCatalog || '(none)'} schema=${resolvedSchema || '(none)'}`,
        )
        const conn = await trinoClient.connect(
          connectionId,
          resolvedServer,
          resolvedCatalog,
          resolvedSchema,
          resolvedUser,
          resolvedPassword,
        )

        if (savePassword) {
          if (password) {
            try {
              saveTrinoCredential(resolvedServer, resolvedUser, password)
            } catch (saveErr: any) {
              return {
                success: true,
                connectionId: conn.id,
                server: resolvedServer,
                catalog: resolvedCatalog,
                schema: resolvedSchema,
                user: resolvedUser,
                credentialWarning: saveErr?.message ?? 'Failed to save password',
              }
            }
          }
        } else {
          try {
            deleteTrinoCredential(resolvedServer, resolvedUser)
          } catch {
            // non-fatal — connection already succeeded
          }
        }

        console.log(`[trino-workbench] connected id=${conn.id}`)
        return {
          success: true,
          connectionId: conn.id,
          server: resolvedServer,
          catalog: resolvedCatalog,
          schema: resolvedSchema,
          user: resolvedUser,
        }
      } catch (err: any) {
        console.error('[trino-workbench] connect error:', err.message)
        return { success: false, error: err.message }
      }
    },
  )

  ipcMain.handle('trino-list-connections', async () => {
    try {
      return { success: true, connections: trinoClient.getConnections() }
    } catch (err: any) {
      return { success: false, connections: [], error: err.message }
    }
  })

  ipcMain.handle('trino-disconnect', async (_event, connectionId: string) => {
    try {
      await trinoClient.disconnect(connectionId)
      return { success: true }
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('trino-execute-query', async (_event, connectionId: string, sqlText: string) => {
    if (!trinoClient.hasConnection(connectionId)) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affectedRows: 0,
        executionTimeMs: 0,
        error: 'No connection found for this tab. Reconnect to continue.',
      }
    }
    const started = Date.now()
    const preview = sqlText.trim().replace(/\s+/g, ' ').slice(0, 120)
    console.log(`[trino-workbench] query start connection=${connectionId} sql=${preview}`)
    try {
      const result = await trinoClient.executeQuery(connectionId, sqlText)
      console.log(
        `[trino-workbench] query done connection=${connectionId} total=${Date.now() - started}ms rows=${result.rowCount}`,
      )
      return result
    } catch (err: any) {
      console.error(
        `[trino-workbench] query failed connection=${connectionId} ms=${Date.now() - started}:`,
        err.message,
      )
      return { columns: [], rows: [], rowCount: 0, affectedRows: 0, executionTimeMs: 0, error: err.message }
    }
  })

  ipcMain.handle('trino-cancel-query', async (_event, connectionId: string) => {
    if (!trinoClient.hasConnection(connectionId)) {
      return { success: false, error: 'No connection found for this tab.' }
    }
    try {
      return await trinoClient.cancelQuery(connectionId)
    } catch (err: any) {
      return { success: false, error: err.message }
    }
  })

  ipcMain.handle('trino-list-catalogs', async (_event, connectionId: string) => {
    try {
      return { success: true, catalogs: await trinoClient.listCatalogs(connectionId) }
    } catch (err: any) {
      return { success: false, catalogs: [], error: err.message }
    }
  })

  ipcMain.handle('trino-list-schemas', async (_event, connectionId: string, catalog: string) => {
    try {
      return { success: true, schemas: await trinoClient.listSchemas(connectionId, catalog) }
    } catch (err: any) {
      return { success: false, schemas: [], error: err.message }
    }
  })

  ipcMain.handle(
    'trino-describe-table',
    async (_event, connectionId: string, tableName: string, catalog?: string, schema?: string) => {
      try {
        const columns = await trinoClient.describeTable(connectionId, tableName, catalog, schema)
        return { success: true, columns }
      } catch (err: any) {
        return { success: false, columns: [], error: err.message }
      }
    },
  )

  const listOrSearchTables = async (
    _event: IpcMainInvokeEvent,
    connectionId: string,
    catalog?: string,
    schema?: string,
    nameFilter?: string,
  ) => {
    try {
      const filter = nameFilter?.trim()
      if (filter) {
        const matches = await trinoClient.searchTables(connectionId, filter, catalog, schema)
        const tables = matches.map((m) => ({
          name: m.name,
          type: 'TABLE' as const,
          engine: null,
          rows: null,
          comment: '',
          catalog: m.catalog,
          schema: m.schema,
        }))
        return { success: true, tables }
      }
      const names = await trinoClient.listTables(connectionId, catalog, schema)
      const tables = names.map((name) => ({
        name,
        type: 'TABLE' as const,
        engine: null,
        rows: null,
        comment: '',
        catalog: catalog ?? '',
        schema: schema ?? '',
      }))
      return { success: true, tables }
    } catch (err: any) {
      return { success: false, tables: [], error: err.message }
    }
  }

  ipcMain.handle('trino-list-tables', listOrSearchTables)
  // Alias — arg order matches preload trinoSearchTables(connectionId, query, catalog?, schema?)
  ipcMain.handle(
    'trino-search-tables',
    async (event, connectionId: string, query: string, catalog?: string, schema?: string) =>
      listOrSearchTables(event, connectionId, catalog, schema, query),
  )
}
