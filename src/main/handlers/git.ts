import { ipcMain, shell, BrowserWindow, type WebContents } from 'electron'
import { join } from 'path'
import { readdir, stat } from 'fs/promises'
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { execSync, exec, execFile } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { WorkspaceFolder } from '../../shared/types'
import {
  buildGitFolderMeta,
  buildGitSyncStatus,
  getWorkingTreeChanges,
  pullFolderToBase,
  isSafeRefName,
  type PullFolderOptions,
} from '../git-sync'
import { getCachedFolderMeta, setCachedFolderMeta, invalidateFolderMeta } from '../git-meta-cache'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

export function registerGitHandlers() {
  ipcMain.handle('list-workspace-folders', async (_event, scanPath: string) => {
    const folders: WorkspaceFolder[] = []
    const STAT_BATCH = 32
    try {
      const entries = await readdir(scanPath)
      const candidates = entries.filter(
        (entry) => !entry.startsWith('.') && entry !== 'node_modules',
      )
      for (let i = 0; i < candidates.length; i += STAT_BATCH) {
        const batch = candidates.slice(i, i + STAT_BATCH)
        const batchResults = await Promise.all(
          batch.map(async (entry) => {
            const fullPath = join(scanPath, entry)
            try {
              const st = await stat(fullPath)
              if (!st.isDirectory()) return null
              return {
                name: entry,
                path: fullPath,
                modifiedAt: st.mtime.toISOString(),
                gitBranch: null,
                gitRemote: null,
              } satisfies WorkspaceFolder
            } catch {
              return null
            }
          }),
        )
        for (const item of batchResults) {
          if (item) folders.push(item)
        }
      }
    } catch { /* ignore */ }
    return folders.sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle('get-folder-git-meta', async (_event, folderPath: string, fetch = false) => {
    if (!fetch) {
      const cached = getCachedFolderMeta(folderPath)
      if (cached) return cached
    }
    const meta = await buildGitFolderMeta(folderPath, fetch)
    setCachedFolderMeta(folderPath, meta)
    return meta
  })

  ipcMain.handle('get-git-info', async (_event, folderPath: string) => {
    const cached = getCachedFolderMeta(folderPath)
    if (cached) {
      return { gitBranch: cached.gitBranch, gitRemote: cached.gitRemote }
    }
    const meta = await buildGitFolderMeta(folderPath, false)
    setCachedFolderMeta(folderPath, meta)
    return { gitBranch: meta.gitBranch, gitRemote: meta.gitRemote }
  })

  ipcMain.handle('get-git-status', async (_event, folderPath: string) => {
    const result: {
      branch: string | null; baseBranch: string | null; remote: string | null
      filesChanged: number; insertions: number; deletions: number
      commitsAhead: number; uncommitted: number; isGitRepo: boolean
    } = {
      branch: null, baseBranch: null, remote: null,
      filesChanged: 0, insertions: 0, deletions: 0,
      commitsAhead: 0, uncommitted: 0, isGitRepo: false
    }
    try {
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      })
      result.isGitRepo = true
    } catch { return result }

    try {
      result.branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch { /* ignore */ }

    try {
      const remote = execSync('git remote get-url origin', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      result.remote = remote.includes('github.com')
        ? remote.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
        : remote
    } catch { /* no remote */ }

    try {
      const remoteHead = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      result.baseBranch = remoteHead.replace('refs/remotes/origin/', '')
    } catch {
      try {
        execSync('git rev-parse --verify origin/main', {
          cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
        })
        result.baseBranch = 'main'
      } catch {
        try {
          execSync('git rev-parse --verify origin/master', {
            cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
          })
          result.baseBranch = 'master'
        } catch { /* no remote base */ }
      }
    }

    if (result.baseBranch) {
      try {
        const stat = execSync(`git diff --shortstat origin/${result.baseBranch}...HEAD`, {
          cwd: folderPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
        const filesMatch = stat.match(/(\d+) files? changed/)
        const insMatch = stat.match(/(\d+) insertions?/)
        const delMatch = stat.match(/(\d+) deletions?/)
        if (filesMatch) result.filesChanged = parseInt(filesMatch[1])
        if (insMatch) result.insertions = parseInt(insMatch[1])
        if (delMatch) result.deletions = parseInt(delMatch[1])
      } catch { /* ignore */ }

      try {
        const count = execSync(`git rev-list --count origin/${result.baseBranch}..HEAD`, {
          cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
        result.commitsAhead = parseInt(count) || 0
      } catch { /* ignore */ }
    }

    try {
      const status = execSync('git status --porcelain', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
      result.uncommitted = status ? status.split('\n').length : 0
    } catch { /* ignore */ }

    return result
  })

  ipcMain.handle('list-branches', async (_event, folderPath: string) => {
    try {
      await execAsync('git rev-parse --is-inside-work-tree', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000,
      })
    } catch {
      return { current: null, branches: [] }
    }

    let current: string | null = null
    try {
      const { stdout } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000,
      })
      current = stdout.trim()
    } catch { /* detached HEAD */ }

    const branches: string[] = []
    try {
      const { stdout } = await execAsync('git branch --format="%(refname:short)"', {
        cwd: folderPath, encoding: 'utf-8', timeout: 5000,
      })
      const raw = stdout.trim()
      if (raw) {
        for (const b of raw.split('\n')) {
          const name = b.trim()
          if (name) branches.push(name)
        }
      }
    } catch { /* ignore */ }

    return { current, branches }
  })

  ipcMain.handle('get-git-sync-status', async (_event, folderPath: string, fetch = false) => {
    return buildGitSyncStatus(folderPath, fetch)
  })

  ipcMain.handle('get-folder-working-tree', async (_event, folderPath: string) => {
    return getWorkingTreeChanges(folderPath)
  })

  ipcMain.handle(
    'pull-folder-to-base',
    async (_event, folderPath: string, options?: PullFolderOptions) => {
      return pullFolderToBase(folderPath, options)
    },
  )

  ipcMain.handle('pull-all-folders-to-base', async (_event, folderPaths: string[]) => {
    const results: Array<{
      path: string
      success: boolean
      error?: string
      branch?: string | null
    }> = []
    for (const folderPath of folderPaths) {
      const result = await pullFolderToBase(folderPath)
      results.push({
        path: folderPath,
        success: result.success,
        error: result.error,
        branch: result.branch,
      })
    }
    return results
  })

  function emitPullFinished(sender: WebContents, payload: {
    path: string
    success: boolean
    error?: string
    branch?: string | null
  }) {
    invalidateFolderMeta(payload.path)
    const win = BrowserWindow.fromWebContents(sender)
    if (win && !win.isDestroyed()) {
      win.webContents.send('git-pull-finished', payload)
    }
  }

  function emitPullBatchFinished(sender: WebContents, payload: { total: number; ok: number; failed: number }) {
    const win = BrowserWindow.fromWebContents(sender)
    if (win && !win.isDestroyed()) {
      win.webContents.send('git-pull-batch-finished', payload)
    }
  }

  ipcMain.handle(
    'start-pull-folder-to-base',
    (event, folderPath: string, options?: PullFolderOptions) => {
    const sender = event.sender
    void (async () => {
      const result = await pullFolderToBase(folderPath, options)
      emitPullFinished(sender, {
        path: folderPath,
        success: result.success,
        error: result.error,
        branch: result.branch,
      })
    })()
    return { started: true }
  })

  ipcMain.handle('start-pull-all-folders-to-base', (event, folderPaths: string[]) => {
    const sender = event.sender
    const paths = [...folderPaths]
    void (async () => {
      let ok = 0
      let failed = 0
      for (const folderPath of paths) {
        const result = await pullFolderToBase(folderPath)
        if (result.success) ok++
        else failed++
        emitPullFinished(sender, {
          path: folderPath,
          success: result.success,
          error: result.error,
          branch: result.branch,
        })
      }
      emitPullBatchFinished(sender, { total: paths.length, ok, failed })
    })()
    return { started: true, count: paths.length }
  })

  ipcMain.handle('checkout-branch', async (_event, folderPath: string, branchName: string) => {
    try {
      await execAsync('git rev-parse --is-inside-work-tree', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000,
      })
    } catch {
      return { success: false, error: 'Not a git repository' }
    }

    if (!isSafeRefName(branchName)) {
      return { success: false, error: 'Invalid branch name' }
    }

    try {
      await execFileAsync('git', ['checkout', branchName], {
        cwd: folderPath, encoding: 'utf-8', timeout: 10000,
      })
      return { success: true }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('Your local changes') || msg.includes('would be overwritten')) {
        return { success: false, error: 'You have uncommitted changes. Commit or stash them first.' }
      }
      return { success: false, error: msg.slice(0, 200) }
    }
  })

  ipcMain.handle('open-in-ide', async (_event, projectPath: string, ide: 'cursor' | 'zed') => {
    const launch = async (cmd: string) => {
      try {
        await execAsync(cmd, { timeout: 5000 })
        return true
      } catch {
        return false
      }
    }
    if (ide === 'cursor') {
      if (await launch(`cursor "${projectPath}"`)) return true
      return launch(`open -a "Cursor" "${projectPath}"`)
    }
    if (await launch(`zed "${projectPath}"`)) return true
    return launch(`open -a "Zed" "${projectPath}"`)
  })

  ipcMain.handle('open-in-finder', (_event, projectPath: string) => {
    shell.showItemInFolder(projectPath)
  })

  ipcMain.handle('open-in-terminal', async (_event, projectPath: string) => {
    try {
      await execAsync(`open -a "Terminal" "${projectPath}"`, { timeout: 5000 })
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('get-worktree-diff', async (_event, worktreePath: string) => {
    try {
      const { stdout: diff } = await execAsync(
        'git diff HEAD --stat && echo "---FULL---" && git diff HEAD',
        { cwd: worktreePath, encoding: 'utf-8', timeout: 10000 }
      )
      return { diff }
    } catch (err: unknown) {
      try {
        const { stdout: diff } = await execAsync(
          'git diff --cached --stat && echo "---FULL---" && git diff --cached',
          { cwd: worktreePath, encoding: 'utf-8', timeout: 10000 }
        )
        return { diff }
      } catch {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }
  })
}
