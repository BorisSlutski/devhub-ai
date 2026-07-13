/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'

const mockCreateConnection = vi.fn()

vi.mock('net', () => ({
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
}))

describe('tunnel-probe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('isLocalPortReachable resolves true when TCP connects', async () => {
    mockCreateConnection.mockImplementation((_opts: unknown, onConnect: () => void) => {
      const sock = new EventEmitter() as EventEmitter & { destroy: () => void }
      sock.destroy = vi.fn()
      queueMicrotask(() => onConnect())
      return sock
    })
    const { isLocalPortReachable } = await import('./tunnel-probe')
    await expect(isLocalPortReachable(2000, 500)).resolves.toBe(true)
  })

  it('isLocalPortReachable resolves false when port never opens', async () => {
    vi.useFakeTimers()
    mockCreateConnection.mockImplementation(() => {
      const sock = new EventEmitter() as EventEmitter & { destroy: () => void }
      sock.destroy = vi.fn()
      return sock
    })
    const { isLocalPortReachable } = await import('./tunnel-probe')
    const result = isLocalPortReachable(2000, 500)
    await vi.advanceTimersByTimeAsync(600)
    await expect(result).resolves.toBe(false)
  })

  it('isLikelyTunnelFailure detects connection errors', async () => {
    const { isLikelyTunnelFailure } = await import('./tunnel-probe')
    expect(isLikelyTunnelFailure(new Error('connect ECONNREFUSED 127.0.0.1:2000'))).toBe(true)
    expect(isLikelyTunnelFailure(new Error('Access denied for user'))).toBe(false)
  })
})
