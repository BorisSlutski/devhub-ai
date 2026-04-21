/**
 * Public API for the daemon-based PTY management.
 *
 * DaemonPtyManager is a drop-in replacement for PtyManager that routes
 * all PTY operations through the daemon process. Sessions survive
 * Electron restarts.
 *
 * Usage:
 *   import { DaemonPtyManager, startDaemonProcess } from './pty-daemon'
 *   await startDaemonProcess()
 *   const manager = new DaemonPtyManager()
 *   await manager.init()
 *   // ... use like PtyManager
 */

import { BrowserWindow } from 'electron'
import { DaemonClient } from './daemon-client'
import { type PtySpawnOptions } from './protocol'

// ── Types matching the current PtyManager interface ──

export interface DaemonPtySession {
  id: string
  folderName: string
  folderPath: string
  worktreePath: string | null
  branchName: string | null
}

export interface CreateSessionResult {
  success: boolean
  id: string
  folderName: string
  worktreePath: string | null
  branchName: string | null
  error?: string
}

// ── DaemonPtyManager ──

export class DaemonPtyManager {
  private client: DaemonClient
  private mainWindow: BrowserWindow | null = null
  private shellPath: string | null = null
  private sessions = new Map<string, DaemonPtySession>()
  private dataHooks: ((sessionId: string, data: string) => void)[] = []
  private exitHooks: ((sessionId: string) => void)[] = []
  private initialized = false

  constructor() {
    this.client = new DaemonClient()
  }

  /**
   * Initialize the manager: connect to daemon (starting it if needed).
   * Must be called before any other method.
   */
  async init(): Promise<void> {
    if (this.initialized) return
    await this.client.connect()
    this.initialized = true

    // Recover any sessions that were running before (e.g., after Electron restart)
    try {
      const remoteSessions = await this.client.list()
      // We don't have local metadata for recovered sessions,
      // but we track them so getSessions() returns something.
      for (const rs of remoteSessions) {
        if (!this.sessions.has(rs.sessionId)) {
          this.sessions.set(rs.sessionId, {
            id: rs.sessionId,
            folderName: 'recovered',
            folderPath: '',
            worktreePath: null,
            branchName: null,
          })
        }
      }
    } catch {
      // Non-fatal — just means we can't recover old sessions
    }
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  setShellPath(path: string): void {
    this.shellPath = path
  }

  /** Register a hook that receives all PTY data for every session */
  onData(hook: (sessionId: string, data: string) => void): void {
    this.dataHooks.push(hook)
  }

  /** Register a hook that fires when a PTY session exits */
  onExit(hook: (sessionId: string) => void): void {
    this.exitHooks.push(hook)
  }

  /**
   * Create a new PTY session through the daemon.
   * API-compatible with PtyManager.createSession().
   */
  async createSession(
    sessionId: string,
    folderName: string,
    folderPath: string,
    worktreePath: string | null,
    branchName: string | null,
    command: string
  ): Promise<CreateSessionResult> {
    // If session already exists, destroy it first
    if (this.sessions.has(sessionId)) {
      await this.destroySession(sessionId)
    }

    const cwd = worktreePath || folderPath
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: 'xterm-256color',
      LANG: process.env.LANG || 'en_US.UTF-8',
      HOME: process.env.HOME || '/',
    }
    if (this.shellPath) {
      env.PATH = this.shellPath
    }
    delete env.CLAUDECODE

    env.DISABLE_AUTO_UPDATE = 'true'
    env.DISABLE_UPDATE_PROMPT = 'true'
    env.DEVHUB_AI_SESSION_ID = sessionId

    const options: PtySpawnOptions = {
      shell: '/bin/zsh',
      cwd,
      env,
      cols: 80,
      rows: 24,
    }

    try {
      await this.client.createSession(sessionId, options)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[DaemonPtyManager] Failed to create session:', message)
      return { success: false, id: sessionId, folderName, worktreePath, branchName, error: message }
    }

    const session: DaemonPtySession = {
      id: sessionId,
      folderName,
      folderPath,
      worktreePath,
      branchName,
    }
    this.sessions.set(sessionId, session)

    // Attach to receive data and events
    try {
      await this.client.attach(
        sessionId,
        (data: string) => {
          // Forward to renderer window
          try {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send('pty-data', { sessionId, data })
            }
          } catch { /* window destroyed */ }
          // Invoke data hooks
          for (const hook of this.dataHooks) {
            try { hook(sessionId, data) } catch { /* ignore hook errors */ }
          }
        },
        (exitCode: number) => {
          // Forward to renderer window
          try {
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
              this.mainWindow.webContents.send('pty-exit', { sessionId, exitCode })
            }
          } catch { /* window destroyed */ }
          this.sessions.delete(sessionId)
          // Invoke exit hooks
          for (const hook of this.exitHooks) {
            try { hook(sessionId) } catch { /* ignore hook errors */ }
          }
        },
        (message: string) => {
          console.error(`[DaemonPtyManager] PTY error for ${sessionId}:`, message)
        }
      )
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[DaemonPtyManager] Failed to attach:', message)
      // Session was created but attach failed — try to clean up
      try { await this.client.kill(sessionId) } catch { /* best effort */ }
      this.sessions.delete(sessionId)
      return { success: false, id: sessionId, folderName, worktreePath, branchName, error: message }
    }

    // Send the initial command after shell prompt appears
    setTimeout(async () => {
      try {
        await this.client.write(sessionId, command + '\r')
      } catch {
        // Session may have already exited
      }
    }, 800)

    return { success: true, id: sessionId, folderName, worktreePath, branchName }
  }

  /**
   * Write data to a PTY session.
   */
  async write(sessionId: string, data: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return
    try {
      await this.client.write(sessionId, data)
    } catch {
      // Session may be gone
    }
  }

  /**
   * Resize a PTY session.
   */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    if (!this.sessions.has(sessionId)) return
    try {
      await this.client.resize(sessionId, cols, rows)
    } catch {
      // Session may be gone
    }
  }

  /**
   * Destroy a single PTY session.
   */
  async destroySession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId)
    try {
      await this.client.kill(sessionId)
    } catch {
      // Already dead
    }
  }

  /**
   * Destroy all PTY sessions.
   */
  async destroyAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys())
    for (const id of ids) {
      await this.destroySession(id)
    }
  }

  /**
   * Get all active sessions (local metadata).
   */
  getSessions(): { id: string; folderName: string; worktreePath: string | null; branchName: string | null }[] {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      folderName: s.folderName,
      worktreePath: s.worktreePath,
      branchName: s.branchName,
    }))
  }

  // ── New methods (not in original PtyManager) ──

  /**
   * Attach to an existing daemon session (e.g., after Electron restart).
   */
  async attach(
    sessionId: string,
    onData?: (data: string) => void,
    onExit?: (exitCode: number) => void
  ): Promise<void> {
    await this.client.attach(sessionId, onData, onExit)
  }

  /**
   * Detach from a session without killing it.
   */
  async detach(sessionId: string): Promise<void> {
    await this.client.detach(sessionId)
  }

  /**
   * Reconnect to the daemon (e.g., after connection drop).
   */
  async reconnect(): Promise<void> {
    await this.client.disconnect()
    await this.client.connect()

    // Re-attach to all tracked sessions
    for (const sessionId of Array.from(this.sessions.keys())) {
      try {
        await this.client.attach(sessionId)
      } catch {
        // Session may no longer exist on daemon
        this.sessions.delete(sessionId)
      }
    }
  }

  /**
   * Disconnect from daemon without killing sessions.
   * Sessions continue running on the daemon.
   */
  async disconnect(): Promise<void> {
    await this.client.disconnect()
  }
}

// ── Standalone helper to start the daemon from app initialization ──

/**
 * Launches the daemon process if it's not already running.
 * Called from src/main/index.ts on app startup.
 */
export async function startDaemonProcess(): Promise<void> {
  const client = new DaemonClient()
  try {
    await client.ensureDaemon()
    await client.disconnect()
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[DaemonPtyManager] Failed to start daemon:', message)
  }
}
