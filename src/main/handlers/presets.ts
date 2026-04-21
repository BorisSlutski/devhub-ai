import { ipcMain } from 'electron'
import { presetManager, SessionPreset, SessionPresetCreate } from '../preset-manager'
import { ptyManager } from '../pty-manager'
import { loadState } from '../store'
import { ensureDevHubAIClaudeMd } from '../claude-md'
import { statuslineWatcher } from '../statusline-watcher'
import { execSync } from 'child_process'
import { join } from 'path'
import { homedir } from 'os'
import { mkdirSync } from 'fs'

/**
 * IPC handlers for session preset CRUD and launch.
 *
 * Note: execSync usage here mirrors the existing session.ts pattern.
 * All interpolated values (branch names, paths) are derived from the
 * filesystem — not from untrusted user input.
 */
export function registerPresetHandlers() {
  ipcMain.handle('preset-list', () => {
    return presetManager.getAll()
  })

  ipcMain.handle('preset-create', (_event, input: SessionPresetCreate) => {
    return presetManager.savePreset(input)
  })

  ipcMain.handle('preset-update', (_event, id: string, partial: Partial<SessionPreset>) => {
    return presetManager.updatePreset(id, partial)
  })

  ipcMain.handle('preset-delete', (_event, id: string) => {
    return presetManager.deletePreset(id)
  })

  ipcMain.handle('preset-get-pinned', () => {
    return presetManager.getPinned()
  })

  ipcMain.handle('preset-get-recent', (_event, limit?: number) => {
    return presetManager.getRecent(limit)
  })

  ipcMain.handle('preset-launch', (_event, opts: {
    presetId: string
    sessionId: string
  }) => {
    const preset = presetManager.getPreset(opts.presetId)
    if (!preset) {
      return { success: false, error: 'Preset not found' }
    }

    let worktreePath: string | null = null
    let branchName: string | null = null

    if (preset.useWorktree) {
      let isGitRepo = false
      try {
        execSync('git rev-parse --is-inside-work-tree', {
          cwd: preset.projectPath, encoding: 'utf-8', timeout: 3000,
          stdio: ['ignore', 'pipe', 'ignore']
        })
        isGitRepo = true
      } catch { /* not a git repo */ }

      if (isGitRepo) {
        try {
          const baseBranch = execSync('git rev-parse --abbrev-ref HEAD', {
            cwd: preset.projectPath, encoding: 'utf-8', timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore']
          }).trim()

          const timestamp = Date.now().toString(36)
          const slug = preset.projectName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()
          const worktreeBase = join(homedir(), '.devhub-ai', 'worktrees', slug)
          worktreePath = join(worktreeBase, timestamp, 'worktree')
          branchName = `devhub-ai/claude-${slug}-${timestamp}`

          mkdirSync(join(worktreeBase, timestamp), { recursive: true })
          execSync(
            `git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`,
            { cwd: preset.projectPath, encoding: 'utf-8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }
          )
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err)
          return { success: false, error: message }
        }
      }
    }

    const sessionCwd = worktreePath || preset.projectPath
    const currentState = loadState()
    ensureDevHubAIClaudeMd(sessionCwd, currentState.rtkEnabled)

    const permFlag = preset.dangerousMode ? ' --dangerously-skip-permissions' : ''
    const modelFlag = preset.model ? ` --model ${preset.model}` : ''
    const command = `claude${modelFlag}${permFlag}`

    const result = ptyManager.createSession(
      opts.sessionId,
      preset.projectName,
      preset.projectPath,
      worktreePath,
      branchName,
      command
    )

    if (result.success) {
      statuslineWatcher.watchSession(opts.sessionId)
      presetManager.recordUsage(opts.presetId)

      // Run initial commands after a brief delay to let the shell start
      if (preset.initialCommands && preset.initialCommands.length > 0) {
        const commands = preset.initialCommands.filter(c => c.trim().length > 0)
        if (commands.length > 0) {
          setTimeout(() => {
            for (const cmd of commands) {
              ptyManager.write(opts.sessionId, cmd + '\n')
            }
          }, 1500)
        }
      }
    }

    return {
      ...result,
      preset,
    }
  })
}
