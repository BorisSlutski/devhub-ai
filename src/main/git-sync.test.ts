import { describe, it, expect } from 'vitest'
import { deriveSyncState } from './git-sync'

describe('deriveSyncState', () => {
  it('returns not-git when not a repo', () => {
    expect(deriveSyncState(false, false, null, 0, 0, 0)).toBe('not-git')
  })

  it('returns no-remote without origin', () => {
    expect(deriveSyncState(true, false, 'main', 0, 0, 0)).toBe('no-remote')
  })

  it('returns no-base without base branch', () => {
    expect(deriveSyncState(true, true, null, 0, 0, 0)).toBe('no-base')
  })

  it('returns dirty when uncommitted changes exist', () => {
    expect(deriveSyncState(true, true, 'main', 3, 0, 2)).toBe('dirty')
  })

  it('returns diverged when behind and ahead', () => {
    expect(deriveSyncState(true, true, 'main', 2, 1, 0)).toBe('diverged')
  })

  it('returns behind when only behind', () => {
    expect(deriveSyncState(true, true, 'main', 3, 0, 0)).toBe('behind')
  })

  it('returns ahead when only ahead', () => {
    expect(deriveSyncState(true, true, 'main', 0, 2, 0)).toBe('ahead')
  })

  it('returns synced when aligned and clean', () => {
    expect(deriveSyncState(true, true, 'main', 0, 0, 0)).toBe('synced')
  })
})
