/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

const mockMysql = {
  isConnected: vi.fn(),
  hasConnection: vi.fn(),
  isQueryInFlight: vi.fn(),
  getTableColumnsCache: vi.fn(),
  reconnect: vi.fn(),
  cancelQuery: vi.fn(),
  executeQuery: vi.fn(),
  describeTable: vi.fn(),
}

const mockTunnel = {
  id: 'conn-1',
  producerName: '/prod/dba/test',
  localPort: 2000,
  dbName: 'tax_rates',
  credentials: { user: 'u', password: 'p' },
}

const mockAkeyless = {
  getTunnel: vi.fn(() => mockTunnel),
  getConnectionMeta: vi.fn(() => ({ producerName: mockTunnel.producerName, kgb: 'k', dbName: 'tax_rates', type: 'mysql' as const })),
  reopenTunnel: vi.fn(),
  getCredentials: vi.fn(),
  clearConnectionMeta: vi.fn(),
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn)
    },
  },
}))

vi.mock('../mysql-client', () => ({ mysqlClient: mockMysql }))
vi.mock('../akeyless-db', () => ({ akeylessDb: mockAkeyless }))
vi.mock('../db-connection-idle', () => ({
  registerDbConnection: vi.fn(),
  touchDbConnection: vi.fn(),
  clearDbConnectionIdle: vi.fn(),
}))

describe('db-workbench handlers', () => {
  beforeAll(async () => {
    const { registerDbWorkbenchHandlers } = await import('./db-workbench')
    registerDbWorkbenchHandlers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockMysql.hasConnection.mockReturnValue(true)
    mockMysql.isConnected.mockReturnValue(true)
    mockMysql.isQueryInFlight.mockReturnValue(false)
    mockMysql.getTableColumnsCache.mockReturnValue(null)
    mockMysql.cancelQuery.mockResolvedValue({ success: true })
  })

  it('db-cancel-query skips ensureDbConnection and calls cancelQuery directly', async () => {
    const cancel = handlers.get('db-cancel-query')
    expect(cancel).toBeDefined()
    const result = await cancel!({} as never, 'conn-1')
    expect(result).toEqual({ success: true })
    expect(mockMysql.cancelQuery).toHaveBeenCalledWith('conn-1')
    expect(mockAkeyless.getCredentials).not.toHaveBeenCalled()
    expect(mockMysql.reconnect).not.toHaveBeenCalled()
  })

  it('db-describe-table returns columns when connected', async () => {
    const columns = [
      {
        name: 'id',
        type: 'bigint',
        nullable: false,
        key: 'PRI',
        defaultValue: null,
        extra: '',
      },
    ]
    mockMysql.getTableColumnsCache.mockReturnValue(null)
    mockMysql.describeTable.mockResolvedValue(columns)
    const describe = handlers.get('db-describe-table')
    expect(describe).toBeDefined()
    const result = await describe!({} as never, 'conn-1', 'tax_rate')
    expect(result).toEqual({ success: true, columns })
    expect(mockMysql.describeTable).toHaveBeenCalledWith('conn-1', 'tax_rate')
  })

  it('db-describe-table returns cached columns without describe', async () => {
    const columns = [{ name: 'id', type: 'int', nullable: true, key: 'PRI', defaultValue: null, extra: '' }]
    mockMysql.getTableColumnsCache.mockReturnValue(columns)
    const describe = handlers.get('db-describe-table')
    const result = await describe!({} as never, 'conn-1', 'tax_rate')
    expect(result).toEqual({ success: true, columns })
    expect(mockMysql.describeTable).not.toHaveBeenCalled()
  })

  it('db-describe-table returns error when describe fails', async () => {
    mockMysql.getTableColumnsCache.mockReturnValue(null)
    mockMysql.describeTable.mockRejectedValue(new Error('timeout'))
    const describe = handlers.get('db-describe-table')
    const result = await describe!({} as never, 'conn-1', 'tax_rate')
    expect(result).toEqual({ success: false, columns: [], error: 'timeout' })
  })
})
