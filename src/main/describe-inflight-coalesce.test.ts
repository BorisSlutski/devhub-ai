import { describe, it, expect, vi } from 'vitest'
import { coalesceInflight } from './describe-inflight-coalesce'

describe('coalesceInflight', () => {
  it('runs fn once for parallel calls with the same key', async () => {
    const map = new Map<string, Promise<number>>()
    const fn = vi.fn().mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          setTimeout(() => resolve(42), 20)
        }),
    )

    const [a, b] = await Promise.all([
      coalesceInflight(map, 'tax_rate', fn),
      coalesceInflight(map, 'tax_rate', fn),
    ])

    expect(a).toBe(42)
    expect(b).toBe(42)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('runs fn separately for different keys', async () => {
    const map = new Map<string, Promise<string>>()
    const fn = vi
      .fn()
      .mockImplementationOnce(async () => 'a')
      .mockImplementationOnce(async () => 'b')

    const [a, b] = await Promise.all([
      coalesceInflight(map, 'table_a', fn),
      coalesceInflight(map, 'table_b', fn),
    ])

    expect(a).toBe('a')
    expect(b).toBe('b')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
