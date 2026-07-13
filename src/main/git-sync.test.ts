import { describe, it, expect } from 'vitest'
import {
  countDirtyPorcelainLines,
  deriveSyncState,
  isSafeRefName,
  parsePorcelainPaths,
} from './git-sync'

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

describe('countDirtyPorcelainLines', () => {
  it('ignores untracked-only lines', () => {
    expect(countDirtyPorcelainLines('?? .octocode/\n')).toBe(0)
  })

  it('counts modified tracked files', () => {
    expect(countDirtyPorcelainLines(' M src/foo.ts\n?? new.txt\n')).toBe(1)
  })

  it('counts staged changes', () => {
    expect(countDirtyPorcelainLines('A  src/new.ts\n')).toBe(1)
  })
})

describe('parsePorcelainPaths', () => {
  it('splits tracked and untracked paths', () => {
    expect(parsePorcelainPaths(' M CLAUDE.md\n?? .octocode/\n')).toEqual({
      tracked: ['CLAUDE.md'],
      untracked: ['.octocode/'],
    })
  })

  it('uses destination path for renames', () => {
    expect(parsePorcelainPaths('R  old.txt -> new.txt\n')).toEqual({
      tracked: ['new.txt'],
      untracked: [],
    })
  })

  it('parses path when space after XY is missing (slice(3) used to drop first char)', () => {
    expect(parsePorcelainPaths(' MCLAUDE.md\n')).toEqual({
      tracked: ['CLAUDE.md'],
      untracked: [],
    })
  })

  it('strips git-quoted paths', () => {
    expect(parsePorcelainPaths(' M "CLAUDE.md"\n')).toEqual({
      tracked: ['CLAUDE.md'],
      untracked: [],
    })
  })

  it('handles porcelain v2 ordinary lines', () => {
    const line =
      '1 .M N... 100644 100644 100644 abcdef1234567890abcdef1234567890abcdef12 abcdef1234567890abcdef1234567890abcdef12 CLAUDE.md'
    expect(parsePorcelainPaths(`${line}\n`)).toEqual({
      tracked: ['CLAUDE.md'],
      untracked: [],
    })
  })
})
