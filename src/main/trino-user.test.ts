/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { normalizeWixUser, normalizeTrinoServerUrl, parseTrinoServerInput, parseTableNavigatorInput } from './trino-user'

describe('normalizeWixUser', () => {
  it('appends @wix.com to bare usernames', () => {
    expect(normalizeWixUser('boris')).toBe('boris@wix.com')
  })

  it('leaves full email unchanged', () => {
    expect(normalizeWixUser('boris@wix.com')).toBe('boris@wix.com')
  })

  it('trims whitespace', () => {
    expect(normalizeWixUser('  boris  ')).toBe('boris@wix.com')
  })
})

describe('normalizeTrinoServerUrl', () => {
  it('keeps https URLs', () => {
    expect(normalizeTrinoServerUrl('https://presto-router.wixpress.com:443')).toBe(
      'https://presto-router.wixpress.com:443',
    )
  })

  it('adds https to host:port', () => {
    expect(normalizeTrinoServerUrl('presto-router.wixpress.com:443')).toBe(
      'https://presto-router.wixpress.com:443',
    )
  })
})

describe('parseTrinoServerInput', () => {
  it('converts DataGrip JDBC URL to https REST base', () => {
    expect(parseTrinoServerInput('jdbc:trino://presto-router.wixpress.com:443')).toEqual({
      server: 'https://presto-router.wixpress.com:443',
    })
  })

  it('extracts catalog and schema from JDBC path', () => {
    expect(parseTrinoServerInput('jdbc:trino://host:443/hive/default')).toEqual({
      server: 'https://host:443',
      catalog: 'hive',
      schema: 'default',
    })
  })

  it('converts trino:// scheme', () => {
    expect(parseTrinoServerInput('trino://presto-router.wixpress.com:443')).toEqual({
      server: 'https://presto-router.wixpress.com:443',
    })
  })
})

describe('parseTableNavigatorInput', () => {
  it('parses catalog.schema.table', () => {
    expect(parseTableNavigatorInput('prod.premium.events')).toEqual({
      catalog: 'prod',
      schema: 'premium',
      tableFilter: 'events',
    })
  })

  it('parses schema.table', () => {
    expect(parseTableNavigatorInput('premium.events')).toEqual({
      schema: 'premium',
      tableFilter: 'events',
    })
  })

  it('parses bare table name', () => {
    expect(parseTableNavigatorInput('events')).toEqual({ tableFilter: 'events' })
  })
})
