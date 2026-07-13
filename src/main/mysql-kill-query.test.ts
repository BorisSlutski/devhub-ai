/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from 'vitest'
import { killServerQuery } from './mysql-kill-query'

describe('killServerQuery', () => {
  it('issues KILL QUERY with the victim thread id', async () => {
    const killQuery = vi.fn().mockResolvedValue([[], []])
    const killConn = { query: killQuery }
    const victimConn = { threadId: 77 }

    await killServerQuery(killConn, victimConn)

    expect(killQuery).toHaveBeenCalledWith('KILL QUERY 77')
  })

  it('no-ops when kill socket is missing', async () => {
    const killQuery = vi.fn()
    await killServerQuery(null, { threadId: 77 })
    expect(killQuery).not.toHaveBeenCalled()
  })

  it('no-ops when victim thread id is missing', async () => {
    const killQuery = vi.fn()
    await killServerQuery({ query: killQuery }, {})
    expect(killQuery).not.toHaveBeenCalled()
  })

  it('swallows kill errors (tunnel may already be dead)', async () => {
    const killQuery = vi.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(
      killServerQuery({ query: killQuery }, { threadId: 42 }),
    ).resolves.toBeUndefined()
  })
})
