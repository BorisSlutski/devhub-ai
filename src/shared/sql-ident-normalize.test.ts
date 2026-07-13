import { describe, it, expect } from 'vitest'
import { normalizeSqlSingleQuotedTableIds } from './sql-ident-normalize'

describe('normalizeSqlSingleQuotedTableIds', () => {
  it('converts FROM single-quoted table to backticks', () => {
    const { sql, changed } = normalizeSqlSingleQuotedTableIds(
      "SELECT * FROM 'tax_rate' LIMIT 25;",
    )
    expect(changed).toBe(true)
    expect(sql).toBe('SELECT * FROM `tax_rate` LIMIT 25;')
  })

  it('converts JOIN single-quoted table to backticks', () => {
    const { sql, changed } = normalizeSqlSingleQuotedTableIds(
      "SELECT a.* FROM orders a JOIN 'users' u ON a.user_id = u.id",
    )
    expect(changed).toBe(true)
    expect(sql).toContain('JOIN `users`')
  })

  it('leaves valid backtick SQL unchanged', () => {
    const input = 'SELECT * FROM `tax_rate` LIMIT 25;'
    const { sql, changed } = normalizeSqlSingleQuotedTableIds(input)
    expect(changed).toBe(false)
    expect(sql).toBe(input)
  })
})
