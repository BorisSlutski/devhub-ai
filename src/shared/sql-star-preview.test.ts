import { describe, it, expect } from 'vitest'
import {
  parseStarSelectPreview,
  isLargeColumnType,
  buildTunnelOptimizedStarSelect,
} from './sql-star-preview'

describe('parseStarSelectPreview', () => {
  it('parses backtick-quoted table with limit', () => {
    expect(parseStarSelectPreview('SELECT * FROM `reports` LIMIT 25')).toEqual({
      table: 'reports',
      limit: 25,
    })
  })

  it('parses db.table', () => {
    expect(parseStarSelectPreview('SELECT * FROM billing.reports LIMIT 10')).toEqual({
      database: 'billing',
      table: 'reports',
      limit: 10,
    })
  })

  it('rejects queries without limit', () => {
    expect(parseStarSelectPreview('SELECT * FROM reports')).toBeNull()
  })

  it('rejects high limits', () => {
    expect(parseStarSelectPreview('SELECT * FROM reports LIMIT 500')).toBeNull()
  })

  it('rejects single-quoted table identifiers', () => {
    expect(parseStarSelectPreview("SELECT * FROM 'tax_rate' LIMIT 25")).toBeNull()
  })
})

describe('isLargeColumnType', () => {
  it('detects text and json types', () => {
    expect(isLargeColumnType('longtext')).toBe(true)
    expect(isLargeColumnType('mediumblob')).toBe(true)
    expect(isLargeColumnType('json')).toBe(true)
    expect(isLargeColumnType('varchar(255)')).toBe(false)
    expect(isLargeColumnType('int')).toBe(false)
  })
})

describe('buildTunnelOptimizedStarSelect', () => {
  const escapeId = (id: string) => `\`${id.replace(/`/g, '``')}\``

  it('truncates large columns on the server', () => {
    const sql = buildTunnelOptimizedStarSelect(escapeId, undefined, 'reports', [
      { name: 'id', type: 'bigint' },
      { name: 'payload', type: 'longtext' },
    ], 25)
    expect(sql).toContain('`id`')
    expect(sql).toContain('SUBSTRING(CAST(`payload` AS CHAR(2048)), 1, 2048) AS `payload`')
    expect(sql).toContain('FROM `reports` LIMIT 25')
  })
})
