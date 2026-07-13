import { BrowserWindow } from 'electron'
import { akeylessDb } from './akeyless-db'
import { mysqlClient } from './mysql-client'

/** Disconnect DB tunnels after this much inactivity (3–4h range; default 4h). */
export const DB_IDLE_DISCONNECT_MS = 4 * 60 * 60 * 1000

let mainWindowRef: BrowserWindow | null = null
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function setDbIdleMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

export function registerDbConnection(connectionId: string): void {
  scheduleIdleDisconnect(connectionId)
}

export function touchDbConnection(connectionId: string): void {
  if (!idleTimers.has(connectionId) && !mysqlClient.getConnections().some((c) => c.id === connectionId)) {
    return
  }
  scheduleIdleDisconnect(connectionId)
}

export function clearDbConnectionIdle(connectionId: string): void {
  const timer = idleTimers.get(connectionId)
  if (timer) {
    clearTimeout(timer)
    idleTimers.delete(connectionId)
  }
}

function scheduleIdleDisconnect(connectionId: string): void {
  clearDbConnectionIdle(connectionId)
  const timer = setTimeout(() => {
    idleTimers.delete(connectionId)
    void disconnectIdleConnection(connectionId)
  }, DB_IDLE_DISCONNECT_MS)
  idleTimers.set(connectionId, timer)
}

async function disconnectIdleConnection(connectionId: string): Promise<void> {
  try {
    await mysqlClient.disconnect(connectionId)
  } catch {
    // best effort
  }
  try {
    akeylessDb.closeTunnel(connectionId)
  } catch {
    // best effort
  }

  const win = mainWindowRef
  if (win && !win.isDestroyed()) {
    win.webContents.send('db-idle-disconnected', { connectionId })
  }
}

export function clearAllDbConnectionIdle(): void {
  for (const id of idleTimers.keys()) {
    clearDbConnectionIdle(id)
  }
}
