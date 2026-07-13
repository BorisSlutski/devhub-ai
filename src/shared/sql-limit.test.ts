import { describe, it, expect } from 'vitest'
import { capUnboundedSelect } from './sql-limit'

describe('capUnboundedSelect', () => {
  it('appends LIMIT to bare SELECT', () => {
    const { sql, rowCapApplied } = capUnboundedSelect('SELECT * FROM users', 10_000)
    expect(rowCapApplied).toBe(true)
    expect(sql).toBe('SELECT * FROM users LIMIT 10001')
  })

  it('leaves SELECT with LIMIT unchanged', () => {
    const { sql, rowCapApplied } = capUnboundedSelect('SELECT * FROM users LIMIT 5', 10_000)
    expect(rowCapApplied).toBe(false)
    expect(sql).toBe('SELECT * FROM users LIMIT 5')
  })

  it('does not cap INSERT', () => {
    const { rowCapApplied } = capUnboundedSelect('INSERT INTO t VALUES (1)', 10_000)
    expect(rowCapApplied).toBe(false)
  })

  it('does not cap trivial SELECT probes', () => {
    const { sql, rowCapApplied } = capUnboundedSelect('SELECT 1', 1_000)
    expect(rowCapApplied).toBe(false)
    expect(sql).toBe('SELECT 1')
  })
})
