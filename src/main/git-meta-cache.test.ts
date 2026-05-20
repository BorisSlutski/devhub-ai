import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  getCachedFolderMeta,
  setCachedFolderMeta,
  invalidateFolderMeta,
} from './git-meta-cache'
import type { GitFolderMeta } from '../shared/ipc-types'

const sampleMeta: GitFolderMeta = {
  gitBranch: 'main',
  gitRemote: null,
  isGitRepo: true,
  baseBranch: 'main',
  currentBranch: 'main',
  commitsBehind: 0,
  commitsAhead: 0,
  uncommitted: 0,
  state: 'synced',
}

describe('git-meta-cache', () => {
  beforeEach(() => {
    invalidateFolderMeta('/tmp/repo')
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns cached meta within TTL', () => {
    setCachedFolderMeta('/tmp/repo', sampleMeta)
    expect(getCachedFolderMeta('/tmp/repo')).toEqual(sampleMeta)
  })

  it('expires cache after TTL', () => {
    setCachedFolderMeta('/tmp/repo', sampleMeta)
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(getCachedFolderMeta('/tmp/repo')).toBeNull()
  })

  it('invalidate removes entry', () => {
    setCachedFolderMeta('/tmp/repo', sampleMeta)
    invalidateFolderMeta('/tmp/repo')
    expect(getCachedFolderMeta('/tmp/repo')).toBeNull()
  })
})
