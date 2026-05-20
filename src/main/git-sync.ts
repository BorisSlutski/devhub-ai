import { execFileSync, execSync } from 'child_process'
import type { GitFolderMeta, GitSyncState, GitSyncStatus } from '../shared/ipc-types'

/** Git ref names safe for argv (branch names from symbolic-ref / origin/HEAD). */
export function isSafeRefName(ref: string): boolean {
  if (!ref || ref.length > 200) return false
  if (ref.includes('..') || ref.startsWith('-') || ref.endsWith('.lock')) return false
  return /^[\w./-]+$/.test(ref)
}

export function deriveSyncState(
  isGitRepo: boolean,
  hasRemote: boolean,
  baseBranch: string | null,
  commitsBehind: number,
  commitsAhead: number,
  uncommitted: number,
): GitSyncState {
  if (!isGitRepo) return 'not-git'
  if (!hasRemote) return 'no-remote'
  if (!baseBranch) return 'no-base'
  if (uncommitted > 0) return 'dirty'
  if (commitsBehind > 0 && commitsAhead > 0) return 'diverged'
  if (commitsBehind > 0) return 'behind'
  if (commitsAhead > 0) return 'ahead'
  return 'synced'
}

export function isGitRepo(folderPath: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: folderPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

export function getCurrentBranch(folderPath: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: folderPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

export function hasOriginRemote(folderPath: string): boolean {
  try {
    execSync('git remote get-url origin', {
      cwd: folderPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

export function getOriginRemoteUrl(folderPath: string): string | null {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: folderPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (remote.includes('github.com')) {
      return remote
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/\.git$/, '')
    }
    return remote
  } catch {
    return null
  }
}

export function resolveBaseBranch(folderPath: string): string | null {
  try {
    const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: folderPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return remoteHead.replace('refs/remotes/origin/', '')
  } catch {
    try {
      execSync('git rev-parse --verify origin/main', {
        cwd: folderPath,
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return 'main'
    } catch {
      try {
        execSync('git rev-parse --verify origin/master', {
          cwd: folderPath,
          encoding: 'utf-8',
          timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore'],
        })
        return 'master'
      } catch {
        return null
      }
    }
  }
}

export function countCommitsBehind(folderPath: string, baseBranch: string): number {
  try {
    const count = execSync(`git rev-list --count HEAD..origin/${baseBranch}`, {
      cwd: folderPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return parseInt(count, 10) || 0
  } catch {
    return 0
  }
}

export function countCommitsAhead(folderPath: string, baseBranch: string): number {
  try {
    const count = execSync(`git rev-list --count origin/${baseBranch}..HEAD`, {
      cwd: folderPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return parseInt(count, 10) || 0
  } catch {
    return 0
  }
}

export function countUncommitted(folderPath: string): number {
  try {
    const status = execSync('git status --porcelain', {
      cwd: folderPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return status ? status.split('\n').length : 0
  } catch {
    return 0
  }
}

export function gitFetchOrigin(folderPath: string): void {
  execSync('git fetch origin', {
    cwd: folderPath,
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

const emptyFolderMeta: GitFolderMeta = {
  gitBranch: null,
  gitRemote: null,
  isGitRepo: false,
  baseBranch: null,
  currentBranch: null,
  commitsBehind: 0,
  commitsAhead: 0,
  uncommitted: 0,
  state: 'not-git',
}

export function buildGitFolderMeta(folderPath: string, fetch = false): GitFolderMeta {
  if (!isGitRepo(folderPath)) {
    return { ...emptyFolderMeta }
  }

  const hasRemote = hasOriginRemote(folderPath)
  const currentBranch = getCurrentBranch(folderPath)
  const gitBranch = currentBranch
  const gitRemote = hasRemote ? getOriginRemoteUrl(folderPath) : null
  const baseBranch = resolveBaseBranch(folderPath)

  if (fetch && hasRemote) {
    try {
      gitFetchOrigin(folderPath)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return {
        gitBranch,
        gitRemote,
        isGitRepo: true,
        baseBranch,
        currentBranch,
        commitsBehind: 0,
        commitsAhead: 0,
        uncommitted: countUncommitted(folderPath),
        state: 'error',
        error: msg.slice(0, 200),
      }
    }
  }

  const uncommitted = countUncommitted(folderPath)
  let commitsBehind = 0
  let commitsAhead = 0
  if (baseBranch) {
    commitsBehind = countCommitsBehind(folderPath, baseBranch)
    commitsAhead = countCommitsAhead(folderPath, baseBranch)
  }

  const state = deriveSyncState(
    true,
    hasRemote,
    baseBranch,
    commitsBehind,
    commitsAhead,
    uncommitted,
  )

  return {
    gitBranch,
    gitRemote,
    isGitRepo: true,
    baseBranch,
    currentBranch,
    commitsBehind,
    commitsAhead,
    uncommitted,
    state,
  }
}

export function buildGitSyncStatus(folderPath: string, fetch = false): GitSyncStatus {
  const meta = buildGitFolderMeta(folderPath, fetch)
  return {
    isGitRepo: meta.isGitRepo,
    baseBranch: meta.baseBranch,
    currentBranch: meta.currentBranch,
    commitsBehind: meta.commitsBehind,
    commitsAhead: meta.commitsAhead,
    uncommitted: meta.uncommitted,
    state: meta.state,
    error: meta.error,
  }
}

export function pullFolderToBase(folderPath: string): {
  success: boolean
  error?: string
  branch?: string | null
  behind?: number
  ahead?: number
} {
  if (!isGitRepo(folderPath)) {
    return { success: false, error: 'Not a git repository' }
  }

  if (!hasOriginRemote(folderPath)) {
    return { success: false, error: 'No origin remote configured' }
  }

  const baseBranch = resolveBaseBranch(folderPath)
  if (!baseBranch) {
    return { success: false, error: 'Could not determine main/master branch' }
  }
  if (!isSafeRefName(baseBranch)) {
    return { success: false, error: 'Invalid branch name' }
  }

  const uncommitted = countUncommitted(folderPath)
  if (uncommitted > 0) {
    return {
      success: false,
      error: 'You have uncommitted changes. Commit or stash them first.',
    }
  }

  try {
    gitFetchOrigin(folderPath)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: `Fetch failed: ${msg.slice(0, 200)}` }
  }

  try {
    execFileSync(
      'git',
      ['checkout', '-B', baseBranch, `origin/${baseBranch}`],
      {
        cwd: folderPath,
        encoding: 'utf-8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Your local changes') || msg.includes('would be overwritten')) {
      return {
        success: false,
        error: 'You have uncommitted changes. Commit or stash them first.',
      }
    }
    return { success: false, error: msg.slice(0, 200) }
  }

  try {
    execFileSync(
      'git',
      ['pull', '--ff-only', 'origin', baseBranch],
      {
        cwd: folderPath,
        encoding: 'utf-8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg.slice(0, 200) }
  }

  const branch = getCurrentBranch(folderPath)
  return {
    success: true,
    branch,
    behind: countCommitsBehind(folderPath, baseBranch),
    ahead: countCommitsAhead(folderPath, baseBranch),
  }
}
