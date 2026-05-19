/**
 * Routes PTY operations to in-process PtyManager or DaemonPtyManager based on settings.
 */
import { BrowserWindow } from 'electron'
import { ptyManager } from './pty-manager'
import { loadState } from './store'
import { DaemonPtyManager, startDaemonProcess } from './pty-daemon'

export interface PtyCreateResult {
  success: boolean
  id: string
  folderName: string
  worktreePath: string | null
  branchName: string | null
  error?: string
}

let daemonManager: DaemonPtyManager | null = null
let daemonReady = false

export function isPtyDaemonEnabled(): boolean {
  return loadState().usePtyDaemon === true
}

export async function initPtyBackend(mainWindow: BrowserWindow, shellPath: string): Promise<void> {
  if (!isPtyDaemonEnabled()) return
  try {
    await startDaemonProcess()
    daemonManager = new DaemonPtyManager()
    daemonManager.setMainWindow(mainWindow)
    daemonManager.setShellPath(shellPath)
    await daemonManager.init()
    daemonReady = true
    console.log('[PTY] Daemon backend active')
  } catch (err) {
    console.error('[PTY] Daemon init failed, falling back to in-process PTY:', err)
    daemonManager = null
    daemonReady = false
  }
}

function useDaemon(): boolean {
  return isPtyDaemonEnabled() && daemonReady && daemonManager !== null
}

export function getActivePtyManager() {
  return useDaemon() ? daemonManager! : ptyManager
}

export function attachPtyHooks(
  onData: (sessionId: string, data: string) => void,
  onExit: (sessionId: string) => void
): void {
  const mgr = getActivePtyManager()
  mgr.onData(onData)
  mgr.onExit(onExit)
}

export async function ptyCreateSession(
  sessionId: string,
  folderName: string,
  folderPath: string,
  worktreePath: string | null,
  branchName: string | null,
  command: string
): Promise<PtyCreateResult> {
  if (useDaemon()) {
    return daemonManager!.createSession(sessionId, folderName, folderPath, worktreePath, branchName, command)
  }
  return ptyManager.createSession(sessionId, folderName, folderPath, worktreePath, branchName, command)
}

export function ptyWrite(sessionId: string, data: string): void {
  if (useDaemon()) {
    void daemonManager!.write(sessionId, data)
    return
  }
  ptyManager.write(sessionId, data)
}

export function ptyResize(sessionId: string, cols: number, rows: number): void {
  if (useDaemon()) {
    void daemonManager!.resize(sessionId, cols, rows)
    return
  }
  ptyManager.resize(sessionId, cols, rows)
}

export async function ptyDestroy(sessionId: string): Promise<void> {
  if (useDaemon()) {
    await daemonManager!.destroySession(sessionId)
    return
  }
  ptyManager.destroySession(sessionId)
}

export function ptyGetSessions() {
  return getActivePtyManager().getSessions()
}

export function ptyGetSessionPids(): Map<string, number> {
  if (useDaemon() || !('getSessionPids' in ptyManager)) {
    return new Map()
  }
  return ptyManager.getSessionPids()
}
