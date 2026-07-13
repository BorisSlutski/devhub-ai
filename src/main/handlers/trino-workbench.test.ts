/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()

const mockTrinoClient = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  hasConnection: vi.fn(),
  executeQuery: vi.fn(),
  cancelQuery: vi.fn(),
  getConnections: vi.fn(),
  listCatalogs: vi.fn(),
  listSchemas: vi.fn(),
  listTables: vi.fn(),
  searchTables: vi.fn(),
  describeTable: vi.fn(),
}

const mockCredentialStore = {
  saveTrinoCredential: vi.fn(),
  getTrinoCredential: vi.fn(),
  deleteTrinoCredential: vi.fn(),
  hasTrinoCredential: vi.fn(),
}

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, fn)
    },
  },
}))

vi.mock('../trino-client', () => ({ trinoClient: mockTrinoClient }))
vi.mock('../trino-credentials-store', () => mockCredentialStore)

describe('trino-workbench handlers', () => {
  beforeAll(async () => {
    const { registerTrinoWorkbenchHandlers } = await import('./trino-workbench')
    registerTrinoWorkbenchHandlers()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    mockTrinoClient.connect.mockResolvedValue({
      id: 'trino-1',
      server: 'https://trino.wixprod.net:443',
      catalog: 'hive',
      schema: 'default',
      user: 'boris@wix.com',
      connected: true,
    })
    mockCredentialStore.getTrinoCredential.mockReturnValue(null)
    mockCredentialStore.hasTrinoCredential.mockReturnValue(false)
  })

  it('trino-connect uses stored password when form password is empty', async () => {
    mockCredentialStore.getTrinoCredential.mockReturnValue('stored-secret')
    const connect = handlers.get('trino-connect')
    const result = await connect!(
      {} as never,
      'trino-1',
      'https://trino.wixprod.net:443',
      'hive',
      'default',
      'boris',
      '',
      true,
    )
    expect(result).toMatchObject({
      success: true,
      connectionId: 'trino-1',
      server: 'https://trino.wixprod.net:443',
      user: 'boris@wix.com',
    })
    expect(mockTrinoClient.connect).toHaveBeenCalledWith(
      'trino-1',
      'https://trino.wixprod.net:443',
      'hive',
      'default',
      'boris@wix.com',
      'stored-secret',
    )
    expect(mockCredentialStore.saveTrinoCredential).not.toHaveBeenCalled()
  })

  it('trino-connect normalizes JDBC server URLs from DataGrip', async () => {
    const connect = handlers.get('trino-connect')
    const result = await connect!(
      {} as never,
      'trino-1',
      'jdbc:trino://presto-router.wixpress.com:443',
      '',
      '',
      'boriss@wix.com',
      'secret',
      false,
    )
    expect(result).toMatchObject({
      success: true,
      server: 'https://presto-router.wixpress.com:443',
    })
    expect(mockTrinoClient.connect).toHaveBeenCalledWith(
      'trino-1',
      'https://presto-router.wixpress.com:443',
      '',
      '',
      'boriss@wix.com',
      'secret',
    )
  })

  it('trino-connect saves password in main when savePassword is true', async () => {
    const connect = handlers.get('trino-connect')
    const result = await connect!(
      {} as never,
      'trino-1',
      'https://trino.wixprod.net:443',
      'hive',
      'default',
      'boris',
      'typed-secret',
      true,
    )
    expect(result).toMatchObject({ success: true, connectionId: 'trino-1', user: 'boris@wix.com' })
    expect(mockCredentialStore.saveTrinoCredential).toHaveBeenCalledWith(
      'https://trino.wixprod.net:443',
      'boris@wix.com',
      'typed-secret',
    )
  })

  it('trino-connect deletes stored credential when savePassword is false', async () => {
    const connect = handlers.get('trino-connect')
    await connect!(
      {} as never,
      'trino-1',
      'https://trino.wixprod.net:443',
      'hive',
      'default',
      'boris',
      'typed-secret',
      false,
    )
    expect(mockCredentialStore.deleteTrinoCredential).toHaveBeenCalledWith(
      'https://trino.wixprod.net:443',
      'boris@wix.com',
    )
  })

  it('trino-connect fails when no password is available', async () => {
    const connect = handlers.get('trino-connect')
    const result = await connect!(
      {} as never,
      'trino-1',
      'https://trino.wixprod.net:443',
      'hive',
      'default',
      'boris',
      '',
      false,
    )
    expect(result).toEqual({ success: false, error: 'Password is required' })
    expect(mockTrinoClient.connect).not.toHaveBeenCalled()
  })

  it('trino-has-saved-credential reports stored credentials without returning password', async () => {
    mockCredentialStore.hasTrinoCredential.mockReturnValue(true)
    const hasSaved = handlers.get('trino-has-saved-credential')
    const result = await hasSaved!({} as never, 'https://trino.wixprod.net:443', 'boris')
    expect(result).toEqual({ success: true, hasCredential: true })
    expect(mockCredentialStore.getTrinoCredential).not.toHaveBeenCalled()
  })

  it('trino-list-tables with filter delegates to searchTables', async () => {
    mockTrinoClient.searchTables.mockResolvedValue([
      { catalog: 'prod', schema: 'premium', name: 'products_dim' },
    ])
    const list = handlers.get('trino-list-tables')
    const result = await list!({} as never, 'trino-1', 'prod', 'premium', 'products')
    expect(mockTrinoClient.searchTables).toHaveBeenCalledWith('trino-1', 'products', 'prod', 'premium')
    expect(result).toMatchObject({
      success: true,
      tables: [{ name: 'products_dim', catalog: 'prod', schema: 'premium' }],
    })
  })

  it('trino-search-tables alias uses searchTables', async () => {
    mockTrinoClient.searchTables.mockResolvedValue([
      { catalog: 'prod', schema: 'premium', name: 'products_dim' },
    ])
    const search = handlers.get('trino-search-tables')
    expect(search).toBeDefined()
    const result = await search!({} as never, 'trino-1', 'products', 'prod', 'premium')
    expect(mockTrinoClient.searchTables).toHaveBeenCalledWith('trino-1', 'products', 'prod', 'premium')
    expect(result).toMatchObject({ success: true })
  })
})
