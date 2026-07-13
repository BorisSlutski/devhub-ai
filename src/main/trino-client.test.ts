/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockCancel = vi.fn().mockResolvedValue(undefined)
const mockQuery = vi.fn()

vi.mock('trino-client', () => ({
  Trino: {
    create: vi.fn(() => ({
      query: mockQuery,
      cancel: mockCancel,
    })),
  },
  BasicAuth: vi.fn(),
}))

function okConnectIter() {
  return {
    async next() {
      return { done: true, value: undefined }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

function hangingQueryIter(queryId = 'q-hang') {
  let pages = 0
  return {
    async next() {
      pages += 1
      if (pages === 1) {
        return { done: false, value: { id: queryId } }
      }
      return new Promise(() => {})
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }
}

describe('trino-client executeQuery timeout', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.resetModules()
    const { trinoClient } = await import('./trino-client')
    for (const conn of trinoClient.getConnections()) {
      trinoClient.disconnect(conn.id)
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('cancels server-side query once on timeout', async () => {
    mockQuery.mockImplementationOnce(async () => okConnectIter()).mockImplementation(async () => hangingQueryIter())

    const { trinoClient } = await import('./trino-client')
    await trinoClient.connect('conn-1', 'https://trino.wixprod.net:443', 'hive', 'default', 'boris', 'secret')

    const resultPromise = trinoClient.executeQuery('conn-1', 'SELECT 1')
    await vi.advanceTimersByTimeAsync(91_000)
    const result = await resultPromise

    expect(result.error).toMatch(/timed out|Query cancelled/)
    expect(mockCancel).toHaveBeenCalledTimes(1)
    expect(mockCancel).toHaveBeenCalledWith('q-hang')
  })

  it('allows a follow-up query after timeout without stale cancellation', async () => {
    mockQuery
      .mockImplementationOnce(async () => okConnectIter())
      .mockImplementationOnce(async () => hangingQueryIter('q-first'))
      .mockImplementationOnce(async () => {
        let calls = 0
        return {
          async next() {
            calls += 1
            if (calls === 1) {
              return {
                done: false,
                value: {
                  columns: [{ name: 'n', type: 'integer' }],
                  data: [[1]],
                },
              }
            }
            return { done: true, value: undefined }
          },
          [Symbol.asyncIterator]() {
            return this
          },
        }
      })

    const { trinoClient } = await import('./trino-client')
    await trinoClient.connect('conn-2', 'https://trino.wixprod.net:443', 'hive', 'default', 'boris', 'secret')

    const timedOut = trinoClient.executeQuery('conn-2', 'SELECT slow')
    await vi.advanceTimersByTimeAsync(91_000)
    const first = await timedOut
    expect(first.error).toMatch(/timed out|Query cancelled/)

    const second = await trinoClient.executeQuery('conn-2', 'SELECT 1')
    expect(second.error).toBeUndefined()
    expect(second.rows).toEqual([[1]])
  })

  it('auto-adds LIMIT to unbounded SELECT', async () => {
    let capturedQuery = ''
    mockQuery
      .mockImplementationOnce(async () => okConnectIter())
      .mockImplementation(async (req: { query: string }) => {
        capturedQuery = req.query
        return {
          async next() {
            return {
              done: false,
              value: {
                columns: [{ name: 'id', type: 'bigint' }],
                data: [[1]],
              },
            }
          },
          async return() {
            return { done: true, value: undefined }
          },
          [Symbol.asyncIterator]() {
            return this
          },
        }
      })

    const { trinoClient } = await import('./trino-client')
    await trinoClient.connect('conn-3', 'https://trino.wixprod.net:443', 'prod', 'premium', 'boris', 'secret')

    const result = await trinoClient.executeQuery(
      'conn-3',
      'select * from prod.premium.products_dim',
    )

    expect(capturedQuery).toMatch(/LIMIT 1001\s*$/i)
    expect(result.rowCapApplied).toBe(true)
    expect(result.error).toBeUndefined()
  })
})
