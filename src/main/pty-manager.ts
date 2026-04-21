import { BrowserWindow } from 'electron'
import { getBridgePort } from './browser-bridge'
import { join } from 'path'
import { homedir } from 'os'
import { createReadinessGate, READINESS_COMMAND, type ReadinessGate } from './shell-readiness'
import { ScrollbackWriter } from './scrollback-manager'

// node-pty is a native module — use eval to prevent vite from bundling it
// Tests inject mock via global __PTY_FOR_TEST__
// eslint-disable-next-line no-eval
const pty: typeof import('node-pty') =
  (typeof globalThis !== 'undefined' && (globalThis as any).__PTY_FOR_TEST__) ||
  eval("require('node-pty')")

export interface PtySession {
  id: string
  folderName: string
  folderPath: string
  ptyProcess: any
  worktreePath: string | null
  branchName: string | null
}

class PtyManager {
  private sessions = new Map<string, PtySession>()
  private readinessGates = new Map<string, ReadinessGate>()
  private scrollbackWriters = new Map<string, ScrollbackWriter>()
  private mainWindow: BrowserWindow | null = null
  private shellPath: string | null = null
  private dataHooks: ((sessionId: string, data: string) => void)[] = []
  private exitHooks: ((sessionId: string) => void)[] = []

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  setShellPath(path: string) {
    this.shellPath = path
  }

  /** Register a hook that receives all PTY data for every session */
  onData(hook: (sessionId: string, data: string) => void) {
    this.dataHooks.push(hook)
  }

  /** Register a hook that fires when a PTY session exits */
  onExit(hook: (sessionId: string) => void) {
    this.exitHooks.push(hook)
  }

  createSession(
    sessionId: string,
    folderName: string,
    folderPath: string,
    worktreePath: string | null,
    branchName: string | null,
    command: string
  ): { success: boolean; id: string; folderName: string; worktreePath: string | null; branchName: string | null; error?: string } {
    if (this.sessions.has(sessionId)) {
      this.destroySession(sessionId)
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
    // Remove CLAUDECODE env var so claude doesn't think it's nested
    delete env.CLAUDECODE

    // Suppress oh-my-zsh update prompt — it consumes the first char of the initial command
    env.DISABLE_AUTO_UPDATE = 'true'
    env.DISABLE_UPDATE_PROMPT = 'true'

    // Set DevHub-AI browser bridge env vars
    env.DEVHUB_AI_SESSION_ID = sessionId
    const port = getBridgePort()
    if (port > 0) {
      env.DEVHUB_AI_BROWSER_PORT = String(port)
    }
    // Add devhub-ai helper to PATH
    const devhubAiBin = join(homedir(), '.devhub-ai')
    env.PATH = devhubAiBin + ':' + (env.PATH || '')

    let ptyProcess: any
    try {
      // Use -i (interactive) instead of -l (login) to skip slow profile sourcing
      ptyProcess = pty.spawn('/bin/zsh', ['-i'], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd,
        env
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[PTY] Failed to spawn:', message)
      return { success: false, id: sessionId, folderName, worktreePath, branchName, error: message }
    }

    const session: PtySession = {
      id: sessionId,
      folderName,
      folderPath,
      ptyProcess,
      worktreePath,
      branchName
    }

    // Set up readiness gate for shell init detection
    const gate = createReadinessGate(sessionId, (d) => ptyProcess.write(d))
    this.readinessGates.set(sessionId, gate)

    // Create scrollback writer for crash recovery
    try {
      const writer = new ScrollbackWriter(sessionId, cwd, 80, 24)
      this.scrollbackWriters.set(sessionId, writer)
    } catch (err) {
      console.error(`[PTY] Failed to create scrollback writer for ${sessionId}:`, err)
    }

    ptyProcess.onData((data: string) => {
      // Pipe data through the readiness gate to strip OSC markers
      const filtered = gate.onData(data)
      if (filtered.length === 0) return

      try {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('pty-data', { sessionId, data: filtered })
        }
      } catch { /* window destroyed */ }
      // Persist to scrollback
      try { this.scrollbackWriters.get(sessionId)?.append(data) } catch { /* ignore */ }
      for (const hook of this.dataHooks) {
        try { hook(sessionId, filtered) } catch { /* ignore hook errors */ }
      }
    })

    ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
      try {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
          this.mainWindow.webContents.send('pty-exit', { sessionId, exitCode })
        }
      } catch { /* window destroyed */ }
      // Close scrollback writer (marks session as ended)
      try {
        this.scrollbackWriters.get(sessionId)?.close()
        this.scrollbackWriters.delete(sessionId)
      } catch { /* ignore */ }
      this.sessions.delete(sessionId)
      this.readinessGates.get(sessionId)?.dispose()
      this.readinessGates.delete(sessionId)
      for (const hook of this.exitHooks) {
        try { hook(sessionId) } catch { /* ignore hook errors */ }
      }
    })

    this.sessions.set(sessionId, session)

    // Inject the readiness marker command into PTY stdin.
    // This executes after shell init (zsh, oh-my-zsh, etc.) completes naturally
    // because the shell processes stdin only after initialization.
    if (command) {
      ptyProcess.write(READINESS_COMMAND)
      gate.waitForReady().then(() => {
        ptyProcess.write(command + '\r')
      })
    }

    return { success: true, id: sessionId, folderName, worktreePath, branchName }
  }

  write(sessionId: string, data: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    const gate = this.readinessGates.get(sessionId)
    if (gate) {
      gate.bufferInput(data)
    } else {
      session.ptyProcess.write(data)
    }
  }

  resize(sessionId: string, cols: number, rows: number) {
    this.sessions.get(sessionId)?.ptyProcess.resize(cols, rows)
    try { this.scrollbackWriters.get(sessionId)?.updateMeta({ cols, rows }) } catch { /* ignore */ }
  }

  destroySession(sessionId: string) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.readinessGates.get(sessionId)?.dispose()
    this.readinessGates.delete(sessionId)
    try {
      this.scrollbackWriters.get(sessionId)?.close()
      this.scrollbackWriters.delete(sessionId)
    } catch { /* ignore */ }
    try {
      session.ptyProcess.kill()
    } catch { /* already dead */ }
    this.sessions.delete(sessionId)
  }

  getSessions(): { id: string; folderName: string; worktreePath: string | null; branchName: string | null }[] {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      folderName: s.folderName,
      worktreePath: s.worktreePath,
      branchName: s.branchName
    }))
  }

  /** Return a map of sessionId → PID for all active PTY sessions */
  getSessionPids(): Map<string, number> {
    const pids = new Map<string, number>()
    for (const [id, session] of this.sessions) {
      const pid = session.ptyProcess?.pid
      if (typeof pid === 'number' && pid > 0) {
        pids.set(id, pid)
      }
    }
    return pids
  }

  destroyAll() {
    for (const [id] of this.sessions) {
      this.destroySession(id)
    }
  }
}

export const ptyManager = new PtyManager()
