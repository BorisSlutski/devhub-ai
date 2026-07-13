import { execFile } from 'child_process'
import { promisify } from 'util'
import type { GitFolderMeta, GitSyncState, GitSyncStatus } from '../shared/ipc-types'

const execFileAsync = promisify(execFile)

type GitExecOpts = { cwd: string; timeout?: number }

async function gitStdout(args: string[], opts: GitExecOpts): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf-8',
    timeout: opts.timeout ?? 3000,
    maxBuffer: 1024 * 1024,
  })
  return stdout.trim()
}

async function gitOk(args: string[], opts: GitExecOpts): Promise<boolean> {
  try {
    await gitStdout(args, opts)
    return true
  } catch {
    return false
  }
}

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

export async function isGitRepo(folderPath: string): Promise<boolean> {
  return gitOk(['rev-parse', '--is-inside-work-tree'], { cwd: folderPath })
}

export async function getCurrentBranch(folderPath: string): Promise<string | null> {
  try {
    return await gitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folderPath })
  } catch {
    return null
  }
}

export async function hasOriginRemote(folderPath: string): Promise<boolean> {
  return gitOk(['remote', 'get-url', 'origin'], { cwd: folderPath })
}

export async function getOriginRemoteUrl(folderPath: string): Promise<string | null> {
  try {
    const remote = await gitStdout(['remote', 'get-url', 'origin'], { cwd: folderPath })
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

export async function resolveBaseBranch(folderPath: string): Promise<string | null> {
  try {
    const remoteHead = await gitStdout(['symbolic-ref', 'refs/remotes/origin/HEAD'], { cwd: folderPath })
    return remoteHead.replace('refs/remotes/origin/', '')
  } catch {
    if (await gitOk(['rev-parse', '--verify', 'origin/main'], { cwd: folderPath })) {
      return 'main'
    }
    if (await gitOk(['rev-parse', '--verify', 'origin/master'], { cwd: folderPath })) {
      return 'master'
    }
    return null
  }
}

export async function countCommitsBehind(folderPath: string, baseBranch: string): Promise<number> {
  if (!isSafeRefName(baseBranch)) return 0
  try {
    const count = await gitStdout(
      ['rev-list', '--count', `HEAD..origin/${baseBranch}`],
      { cwd: folderPath },
    )
    return parseInt(count, 10) || 0
  } catch {
    return 0
  }
}

export async function countCommitsAhead(folderPath: string, baseBranch: string): Promise<number> {
  if (!isSafeRefName(baseBranch)) return 0
  try {
    const count = await gitStdout(
      ['rev-list', '--count', `origin/${baseBranch}..HEAD`],
      { cwd: folderPath },
    )
    return parseInt(count, 10) || 0
  } catch {
    return 0
  }
}

/**
 * Count tracked working-tree changes that can block pull/checkout.
 * Untracked-only lines (?? / !!) are ignored — they do not block ff-only pull.
 */
export function countDirtyPorcelainLines(porcelain: string): number {
  return parsePorcelainPaths(porcelain).tracked.length
}

/** Strip optional double quotes from git-quoted path entries. */
function unquoteGitPath(path: string): string {
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    return path.slice(1, -1).replace(/\\(["\\])/g, '$1')
  }
  return path
}

/** Path from a porcelain v1 line: XY (2 chars) then whitespace then path. */
function pathFromPorcelainV1Line(line: string): string {
  let path = line.slice(2).trimStart()
  if (path.includes(' -> ')) {
    path = path.split(' -> ').pop()!.trim()
  }
  return unquoteGitPath(path)
}

/** Split porcelain status into tracked changes vs untracked paths. */
export function parsePorcelainPaths(porcelain: string): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = []
  const untracked: string[] = []
  if (!porcelain.trim()) return { tracked, untracked }

  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue
    // Porcelain v2 (1/2/?/! prefix) — path is the last space-separated field
    if (/^[12?!] /.test(line)) {
      const path = unquoteGitPath(line.split(/\s+/).pop() ?? '')
      if (!path) continue
      if (line.startsWith('? ') || line.startsWith('! ')) {
        untracked.push(path)
      } else {
        tracked.push(path)
      }
      continue
    }

    const xy = line.slice(0, 2)
    const path = pathFromPorcelainV1Line(line)
    if (!path) continue
    if (xy === '??' || xy === '!!') {
      untracked.push(path)
    } else {
      tracked.push(path)
    }
  }
  return { tracked, untracked }
}

export async function getWorkingTreeChanges(
  folderPath: string,
): Promise<{ tracked: string[]; untracked: string[] }> {
  try {
    const status = await gitStdout(['status', '--porcelain=1'], { cwd: folderPath })
    return parsePorcelainPaths(status)
  } catch {
    return { tracked: [], untracked: [] }
  }
}

async function stashLocalChanges(
  folderPath: string,
  includeUntracked: boolean,
): Promise<void> {
  const args = ['stash', 'push', '-m', 'DevHub-AI: auto-stash before pull']
  if (includeUntracked) args.push('-u')
  await execFileAsync('git', args, {
    cwd: folderPath,
    encoding: 'utf-8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  })
}

async function discardTrackedChanges(folderPath: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await execFileAsync('git', ['restore', '--staged', '--worktree', '--', ...paths], {
    cwd: folderPath,
    encoding: 'utf-8',
    timeout: 10000,
    maxBuffer: 1024 * 1024,
  })
}

export type PullFolderOptions = {
  localChanges?: 'stash' | 'discard'
  stashUntracked?: boolean
}

export async function countUncommitted(folderPath: string): Promise<number> {
  try {
    const status = await gitStdout(['status', '--porcelain=1'], { cwd: folderPath })
    return countDirtyPorcelainLines(status)
  } catch {
    return 0
  }
}

export async function gitFetchOrigin(folderPath: string): Promise<void> {
  await execFileAsync('git', ['fetch', 'origin'], {
    cwd: folderPath,
    encoding: 'utf-8',
    timeout: 15000,
    maxBuffer: 1024 * 1024,
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

export async function buildGitFolderMeta(folderPath: string, fetch = false): Promise<GitFolderMeta> {
  if (!(await isGitRepo(folderPath))) {
    return { ...emptyFolderMeta }
  }

  const hasRemote = await hasOriginRemote(folderPath)
  const currentBranch = await getCurrentBranch(folderPath)
  const gitBranch = currentBranch
  const gitRemote = hasRemote ? await getOriginRemoteUrl(folderPath) : null
  const baseBranch = await resolveBaseBranch(folderPath)

  let fetchError: string | undefined
  if (fetch && hasRemote) {
    try {
      await gitFetchOrigin(folderPath)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      fetchError = msg.slice(0, 200)
    }
  }

  const uncommitted = await countUncommitted(folderPath)
  let commitsBehind = 0
  let commitsAhead = 0
  if (baseBranch) {
    commitsBehind = await countCommitsBehind(folderPath, baseBranch)
    commitsAhead = await countCommitsAhead(folderPath, baseBranch)
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
    error: fetchError,
  }
}

export async function buildGitSyncStatus(folderPath: string, fetch = false): Promise<GitSyncStatus> {
  const meta = await buildGitFolderMeta(folderPath, fetch)
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

export async function pullFolderToBase(
  folderPath: string,
  options: PullFolderOptions = {},
): Promise<{
  success: boolean
  error?: string
  branch?: string | null
  behind?: number
  ahead?: number
}> {
  if (!(await isGitRepo(folderPath))) {
    return { success: false, error: 'Not a git repository' }
  }

  if (!(await hasOriginRemote(folderPath))) {
    return { success: false, error: 'No origin remote configured' }
  }

  const baseBranch = await resolveBaseBranch(folderPath)
  if (!baseBranch) {
    return { success: false, error: 'Could not determine main/master branch' }
  }
  if (!isSafeRefName(baseBranch)) {
    return { success: false, error: 'Invalid branch name' }
  }

  const { tracked, untracked } = await getWorkingTreeChanges(folderPath)
  if (tracked.length > 0) {
    if (!options.localChanges) {
      return {
        success: false,
        error:
          `${tracked.length} tracked file(s) have local changes — commit or stash before pull. ` +
          '(Untracked files such as new folders do not block pull.)',
      }
    }
    try {
      if (options.localChanges === 'stash') {
        await stashLocalChanges(folderPath, !!options.stashUntracked && untracked.length > 0)
      } else {
        await discardTrackedChanges(folderPath, tracked)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return { success: false, error: msg.slice(0, 200) }
    }
  }

  try {
    await gitFetchOrigin(folderPath)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: `Fetch failed: ${msg.slice(0, 200)}` }
  }

  try {
    await execFileAsync(
      'git',
      ['checkout', '-B', baseBranch, `origin/${baseBranch}`],
      {
        cwd: folderPath,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
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
    await execFileAsync(
      'git',
      ['pull', '--ff-only', 'origin', baseBranch],
      {
        cwd: folderPath,
        encoding: 'utf-8',
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg.slice(0, 200) }
  }

  const branch = await getCurrentBranch(folderPath)
  return {
    success: true,
    branch,
    behind: await countCommitsBehind(folderPath, baseBranch),
    ahead: await countCommitsAhead(folderPath, baseBranch),
  }
}
