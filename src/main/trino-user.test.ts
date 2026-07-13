/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'
import { normalizeWixUser } from './trino-user'

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
