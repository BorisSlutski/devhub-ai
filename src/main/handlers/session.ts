import { ipcMain, dialog } from 'electron'
import { join } from 'path'
import { readdirSync, statSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs'
import { execSync, exec, ChildProcess } from 'child_process'
import { homedir } from 'os'
import { ptyManager } from '../pty-manager'
import { loadState } from '../store'
import { cleanupSessionRtkFlag } from '../rtk-manager'
import { promptEnhancer } from '../prompt-enhancer'
import { activeSessions, scanProjectSessions, getSessionTitle } from '../session-history'
import { ensureDevHubAIClaudeMd } from '../claude-md'
import { statuslineWatcher } from '../statusline-watcher'
import { workspaceInitTracker } from '../workspace-init-tracker'
import { notificationManager } from '../notification-manager'

let mainWindowRef: Electron.BrowserWindow | null = null

export function setSessionMainWindow(win: Electron.BrowserWindow) {
  mainWindowRef = win
}

export function registerSessionHandlers() {
  ipcMain.handle('select-folder', async () => {
    if (!mainWindowRef) return null
    const result = await dialog.showOpenDialog(mainWindowRef, {
      properties: ['openDirectory'],
      title: 'Select Workspace Folder'
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('open-claude-worktree', (_event, projectPath: string, projectName: string) => {
    try {
      try {
        execSync('git rev-parse --is-inside-work-tree', {
          cwd: projectPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
        })
      } catch {
        return { success: false, error: 'Not a git repository. Worktrees require git.' }
      }

      const baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
      }).trim()

      const timestamp = Date.now().toString(36)
      const slug = projectName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()
      const worktreeBase = join(homedir(), '.devhub-ai', 'worktrees', slug)
      const worktreePath = join(worktreeBase, timestamp, 'worktree')
      const branchName = `devhub-ai/claude-${slug}-${timestamp}`

      mkdirSync(join(worktreeBase, timestamp), { recursive: true })

      execSync(
        `git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`,
        { cwd: projectPath, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
      )

      const scriptPath = join(worktreeBase, timestamp, 'run-claude.sh')
      const appState = loadState()
      const wtPermFlag = appState.dangerousMode ? ' --dangerously-skip-permissions' : ''
      writeFileSync(scriptPath, [
        '#!/bin/zsh',
        'unset CLAUDECODE',
        `cd "${worktreePath}"`,
        `echo "\\033[1;34m[DevHub-AI]\\033[0m Worktree: ${worktreePath}"`,
        `echo "\\033[1;34m[DevHub-AI]\\033[0m Branch: ${branchName}"`,
        `echo "\\033[1;34m[DevHub-AI]\\033[0m Base: ${baseBranch}"`,
        `echo ""`,
        `claude${wtPermFlag}`,
      ].join('\n'), { mode: 0o755 })

      execSync(
        `open -a "Terminal" "${scriptPath}"`,
        { stdio: 'ignore' }
      )

      return { success: true, worktreePath, branchName, baseBranch }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('pty-create', async (_event, opts: {
    sessionId: string
    folderName: string
    folderPath: string
    useWorktree: boolean
    resumeClaudeId?: string
    existingWorktreePath?: string
    dangerousMode?: boolean
    model?: string
  }) => {
    const tracker = workspaceInitTracker.create(opts.sessionId)
    tracker.advance('pending', 'Initializing workspace...')

    let worktreePath: string | null = opts.existingWorktreePath || null
    let branchName: string | null = null

    // Stage: checking_project
    tracker.advance('checking_project', `Verifying ${opts.folderPath}...`)
    if (tracker.isCancelled()) return { success: false, error: 'Cancelled' }

    if (worktreePath) {
      try {
        branchName = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: worktreePath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
      } catch { /* ignore */ }
    }

    if (opts.useWorktree && !worktreePath) {
      let isGitRepo = false
      try {
        execSync('git rev-parse --is-inside-work-tree', {
          cwd: opts.folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
        })
        isGitRepo = true
      } catch { /* not a git repo */ }

      if (isGitRepo) {
        // Stage: fetching
        tracker.advance('fetching', 'Fetching latest changes...')
        if (tracker.isCancelled()) return { success: false, error: 'Cancelled' }

        try {
          execSync('git fetch --quiet', {
            cwd: opts.folderPath, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore']
          })
        } catch { /* fetch failure is non-fatal */ }

        // Stage: creating_worktree
        tracker.advance('creating_worktree', 'Creating git worktree...')
        if (tracker.isCancelled()) return { success: false, error: 'Cancelled' }

        try {
          const baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: opts.folderPath, encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore']
          }).trim()

          const timestamp = Date.now().toString(36)
          const slug = opts.folderName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()
          const worktreeBase = join(homedir(), '.devhub-ai', 'worktrees', slug)
          worktreePath = join(worktreeBase, timestamp, 'worktree')
          branchName = `devhub-ai/claude-${slug}-${timestamp}`

          mkdirSync(join(worktreeBase, timestamp), { recursive: true })

          // Use async exec for cancellation support during worktree creation
          const worktreeCreated = await new Promise<boolean>((resolve, reject) => {
            // Note: the branch/path values here are internally generated, not user input
            const child: ChildProcess = exec(
              `git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`,
              { cwd: opts.folderPath, encoding: 'utf-8', timeout: 15000 },
              (err) => {
                if (err) reject(err)
                else resolve(true)
              }
            )

            // Check cancellation while process is running
            const cancelCheck = setInterval(() => {
              if (tracker.isCancelled()) {
                clearInterval(cancelCheck)
                try { child.kill() } catch { /* already dead */ }
                // Attempt to clean up partial worktree
                cleanupPartialWorktree(worktreePath, opts.folderPath)
                resolve(false)
              }
            }, 100)

            child.on('close', () => clearInterval(cancelCheck))
          })

          if (!worktreeCreated || tracker.isCancelled()) {
            workspaceInitTracker.remove(opts.sessionId)
            return { success: false, error: 'Cancelled' }
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          tracker.fail(message)
          workspaceInitTracker.remove(opts.sessionId)
          return { success: false, error: message }
        }
      }
    }

    // Stage: running_setup
    tracker.advance('running_setup', 'Running setup scripts...')
    if (tracker.isCancelled()) {
      cleanupPartialWorktree(worktreePath, opts.folderPath)
      workspaceInitTracker.remove(opts.sessionId)
      return { success: false, error: 'Cancelled' }
    }

    const sessionCwd = worktreePath || opts.folderPath
    const currentState = loadState()
    ensureDevHubAIClaudeMd(sessionCwd, currentState.rtkEnabled)

    // Run workspace setup script if present
    runWorkspaceSetup(sessionCwd, opts.folderPath)

    // Stage: spawning_pty
    tracker.advance('spawning_pty', 'Spawning terminal...')
    if (tracker.isCancelled()) {
      cleanupPartialWorktree(worktreePath, opts.folderPath)
      workspaceInitTracker.remove(opts.sessionId)
      return { success: false, error: 'Cancelled' }
    }

    const permFlag = opts.dangerousMode ? ' --dangerously-skip-permissions' : ''
    const modelFlag = opts.model ? ` --model ${opts.model}` : ''
    let command = `claude${modelFlag}${permFlag}`
    if (opts.resumeClaudeId) {
      command = `claude --resume ${opts.resumeClaudeId}${modelFlag}${permFlag}`
    }

    const result = ptyManager.createSession(
      opts.sessionId,
      opts.folderName,
      opts.folderPath,
      worktreePath,
      branchName,
      command
    )

    if (result.success) {
      // Stage: waiting_shell
      tracker.advance('waiting_shell', 'Waiting for shell readiness...')
      statuslineWatcher.watchSession(opts.sessionId)
      notificationManager.trackSession(opts.sessionId, opts.folderName)

      // Stage: ready
      tracker.advance('ready', 'Ready')
    } else {
      tracker.fail(result.error || 'Failed to create PTY session')
    }

    workspaceInitTracker.remove(opts.sessionId)
    return result
  })

  // Workspace init cancellation
  ipcMain.handle('workspace-init-cancel', (_event, sessionId: string) => {
    const cancelled = workspaceInitTracker.cancel(sessionId)
    if (!cancelled) {
      // If tracker not found, the init may already be done — try to destroy the PTY
      ptyManager.destroySession(sessionId)
    }
  })

  ipcMain.on('pty-write', (_event, sessionId: string, data: string) => {
    ptyManager.write(sessionId, data)
  })

  ipcMain.on('pty-resize', (_event, sessionId: string, cols: number, rows: number) => {
    ptyManager.resize(sessionId, cols, rows)
  })

  ipcMain.handle('pty-destroy', (_event, sessionId: string) => {
    ptyManager.destroySession(sessionId)
    statuslineWatcher.unwatchSession(sessionId)
    cleanupSessionRtkFlag(sessionId)
    promptEnhancer.clearSession(sessionId)
  })

  ipcMain.handle('save-temp-image', (_event, opts: { name: string; data: number[]; sessionId: string }) => {
    try {
      const tmpDir = join(homedir(), '.devhub-ai', 'tmp-images')
      mkdirSync(tmpDir, { recursive: true })
      const ext = opts.name.split('.').pop() || 'png'
      const fileName = `${opts.sessionId.slice(0, 8)}-${Date.now()}.${ext}`
      const filePath = join(tmpDir, fileName)
      writeFileSync(filePath, Buffer.from(opts.data))
      return { path: filePath }
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('detect-claude-session-id', (_event, cwd: string) => {
    try {
      const encoded = cwd.replace(/\//g, '-')
      const claudeProjectDir = join(homedir(), '.claude', 'projects', encoded)
      if (!existsSync(claudeProjectDir)) return { sessionId: null }

      const files = readdirSync(claudeProjectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const fullPath = join(claudeProjectDir, f)
          return { name: f, mtime: statSync(fullPath).mtime.getTime() }
        })
        .sort((a, b) => b.mtime - a.mtime)

      if (files.length === 0) return { sessionId: null }
      const sessionId = files[0].name.replace('.jsonl', '')
      return { sessionId }
    } catch {
      return { sessionId: null }
    }
  })

  ipcMain.handle('cleanup-worktree', (_event, worktreePath: string, folderPath: string) => {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: folderPath, encoding: 'utf-8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
      })
      return { success: true }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  })

  ipcMain.handle('pty-list-sessions', () => {
    return ptyManager.getSessions()
  })

  // Active sessions (auto-resume)
  ipcMain.handle('active-sessions-set', (_event, session: any) => {
    activeSessions.set(session)
  })

  ipcMain.handle('active-sessions-update-claude-id', (_event, id: string, claudeSessionId: string) => {
    activeSessions.updateClaudeId(id, claudeSessionId)
  })

  ipcMain.handle('active-sessions-remove', (_event, id: string) => {
    activeSessions.remove(id)
  })

  ipcMain.handle('active-sessions-get-all', () => {
    return activeSessions.getAll()
  })

  ipcMain.handle('active-sessions-set-active-id', (_event, id: string | null) => {
    activeSessions.setActiveId(id)
  })

  ipcMain.handle('active-sessions-get-active-id', () => {
    return activeSessions.getActiveId()
  })

  // Session history
  ipcMain.handle('session-history-scan', (_event, folderPath: string, folderName: string) => {
    return scanProjectSessions(folderPath, folderName)
  })

  ipcMain.handle('session-history-title', (_event, claudeSessionId: string, dirName: string) => {
    return getSessionTitle(claudeSessionId, dirName)
  })
}

function cleanupPartialWorktree(worktreePath: string | null, folderPath: string) {
  if (!worktreePath) return
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, {
      cwd: folderPath, encoding: 'utf-8', timeout: 5000, stdio: 'ignore'
    })
  } catch { /* partial cleanup is best-effort */ }
}

function runWorkspaceSetup(sessionCwd: string, projectPath: string) {
  const configPath = join(projectPath, '.devhub-ai', 'config.json')
  if (!existsSync(configPath)) return

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (!config.setup || !Array.isArray(config.setup)) return

    for (const script of config.setup) {
      const scriptPath = join(projectPath, script)
      if (!existsSync(scriptPath)) continue
      try {
        execSync(`bash "${scriptPath}"`, {
          cwd: sessionCwd,
          encoding: 'utf-8',
          timeout: 30000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            DEVHUB_AI_WORKSPACE_PATH: sessionCwd,
            DEVHUB_AI_PROJECT_PATH: projectPath,
          }
        })
      } catch { /* setup script failed — non-fatal */ }
    }
  } catch { /* invalid config — ignore */ }
}
