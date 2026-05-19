import { ipcMain, shell, BrowserWindow, type WebContents } from 'electron'
import { join } from 'path'
import { readdirSync, statSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { execSync, exec } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { WorkspaceFolder } from '../../shared/types'
import { buildGitSyncStatus, pullFolderToBase } from '../git-sync'

const execAsync = promisify(exec)

export function registerGitHandlers() {
  ipcMain.handle('list-workspace-folders', (_event, scanPath: string) => {
    const folders: WorkspaceFolder[] = []
    try {
      const entries = readdirSync(scanPath)
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules') continue
        const fullPath = join(scanPath, entry)
        try {
          const stat = statSync(fullPath)
          if (!stat.isDirectory()) continue
          folders.push({
            name: entry,
            path: fullPath,
            modifiedAt: stat.mtime.toISOString(),
            gitBranch: null,
            gitRemote: null
          })
        } catch { continue }
      }
    } catch { /* ignore */ }
    return folders.sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle('get-git-info', async (_event, folderPath: string) => {
    let gitBranch: string | null = null
    let gitRemote: string | null = null
    try {
      const { stdout: branch } = await execAsync('git rev-parse --abbrev-ref HEAD', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000
      })
      gitBranch = branch.trim()
      try {
        const { stdout: remote } = await execAsync('git remote get-url origin', {
          cwd: folderPath, encoding: 'utf-8', timeout: 3000
        })
        const r = remote.trim()
        if (r.includes('github.com')) {
          gitRemote = r.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '')
        } else {
          gitRemote = r
        }
      } catch { /* no remote */ }
    } catch { /* not a git repo */ }
    return { gitBranch, gitRemote }
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
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return { current: null, branches: [] }
    }

    let current: string | null = null
    try {
      current = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch { /* detached HEAD */ }

    const branches: string[] = []
    try {
      const raw = execSync('git branch --format="%(refname:short)"', {
        cwd: folderPath, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
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

  ipcMain.handle('pull-folder-to-base', async (_event, folderPath: string) => {
    return pullFolderToBase(folderPath)
  })

  ipcMain.handle('pull-all-folders-to-base', async (_event, folderPaths: string[]) => {
    const results: Array<{
      path: string
      success: boolean
      error?: string
      branch?: string | null
    }> = []
    for (const folderPath of folderPaths) {
      const result = pullFolderToBase(folderPath)
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

  ipcMain.handle('start-pull-folder-to-base', (event, folderPath: string) => {
    const sender = event.sender
    setImmediate(() => {
      const result = pullFolderToBase(folderPath)
      emitPullFinished(sender, {
        path: folderPath,
        success: result.success,
        error: result.error,
        branch: result.branch,
      })
    })
    return { started: true }
  })

  ipcMain.handle('start-pull-all-folders-to-base', (event, folderPaths: string[]) => {
    const sender = event.sender
    const paths = [...folderPaths]
    setImmediate(async () => {
      let ok = 0
      let failed = 0
      for (const folderPath of paths) {
        const result = pullFolderToBase(folderPath)
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
    })
    return { started: true, count: paths.length }
  })

  ipcMain.handle('checkout-branch', async (_event, folderPath: string, branchName: string) => {
    try {
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      return { success: false, error: 'Not a git repository' }
    }

    try {
      execSync(`git checkout "${branchName}"`, {
        cwd: folderPath, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
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

  ipcMain.handle('open-in-ide', (_event, projectPath: string, ide: 'cursor' | 'zed') => {
    try {
      if (ide === 'cursor') {
        execSync(`cursor "${projectPath}"`, { stdio: 'ignore' })
      } else {
        execSync(`zed "${projectPath}"`, { stdio: 'ignore' })
      }
      return true
    } catch {
      try {
        if (ide === 'cursor') {
          execSync(`open -a "Cursor" "${projectPath}"`, { stdio: 'ignore' })
        } else {
          execSync(`open -a "Zed" "${projectPath}"`, { stdio: 'ignore' })
        }
        return true
      } catch {
        return false
      }
    }
  })

  ipcMain.handle('open-in-finder', (_event, projectPath: string) => {
    shell.showItemInFolder(projectPath)
  })

  ipcMain.handle('open-in-terminal', (_event, projectPath: string) => {
    try {
      execSync(`open -a "Terminal" "${projectPath}"`, { stdio: 'ignore' })
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
