import { describe, it, expect } from 'vitest'
import { deriveSyncState, isSafeRefName } from './git-sync'

describe('isSafeRefName', () => {
  it('accepts typical branch names', () => {
    expect(isSafeRefName('main')).toBe(true)
    expect(isSafeRefName('master')).toBe(true)
    expect(isSafeRefName('release/1.2')).toBe(true)
    expect(isSafeRefName('feature/foo-bar_1')).toBe(true)
  })

  it('rejects unsafe ref names', () => {
    expect(isSafeRefName('')).toBe(false)
    expect(isSafeRefName('main; rm -rf')).toBe(false)
    expect(isSafeRefName('branch with spaces')).toBe(false)
    expect(isSafeRefName('evil"branch')).toBe(false)
    expect(isSafeRefName('../main')).toBe(false)
    expect(isSafeRefName('-bad')).toBe(false)
    expect(isSafeRefName('refs/heads/main.lock')).toBe(false)
  })
})

describe('deriveSyncState', () => {
  it('returns synced when up to date with remote', () => {
    expect(deriveSyncState(true, true, 'main', 0, 0, 0)).toBe('synced')
  })

  it('returns dirty when uncommitted changes exist', () => {
    expect(deriveSyncState(true, true, 'main', 0, 0, 2)).toBe('dirty')
  })
})
