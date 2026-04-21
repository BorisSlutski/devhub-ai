import { Notification, BrowserWindow } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

const SETTINGS_PATH = join(homedir(), '.devhub-ai', 'notification-settings.json')

interface NotificationState {
  enabled: boolean
  quietMode: boolean
}

export class NotificationManager {
  private mainWindow: BrowserWindow | null = null
  private enabled = true
  private quietMode = true
  private sessionFolderNames = new Map<string, string>()
  private sessionTitles = new Map<string, string>()

  constructor() {
    this.loadSettings()
  }

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win
  }

  /** Track a session's metadata for notification content */
  trackSession(sessionId: string, folderName: string, title?: string): void {
    this.sessionFolderNames.set(sessionId, folderName)
    if (title) {
      this.sessionTitles.set(sessionId, title)
    }
  }

  /** Update a session's title */
  updateSessionTitle(sessionId: string, title: string): void {
    this.sessionTitles.set(sessionId, title)
  }

  /** Remove tracking for a session */
  untrackSession(sessionId: string): void {
    this.sessionFolderNames.delete(sessionId)
    this.sessionTitles.delete(sessionId)
  }

  /** Show a notification that a session is now waiting for input */
  notifySessionComplete(sessionId: string, summary?: string): void {
    if (!this.enabled) return
    if (!Notification.isSupported()) return

    // Quiet mode: suppress when app is focused
    if (this.quietMode && this.isAppFocused()) return

    const folderName = this.sessionFolderNames.get(sessionId) || 'Session'
    const title = this.sessionTitles.get(sessionId)

    const notification = new Notification({
      title: `Session Ready -- ${folderName}`,
      body: summary || title || 'Waiting for input',
      silent: false,
    })

    notification.on('click', () => {
      this.focusAppAndSession(sessionId)
    })

    notification.show()
  }

  /** Show a notification that a session encountered an error */
  notifySessionError(sessionId: string, error: string): void {
    if (!this.enabled) return
    if (!Notification.isSupported()) return

    // Always show error notifications, even when focused (useful feedback)
    const folderName = this.sessionFolderNames.get(sessionId) || 'Session'

    const notification = new Notification({
      title: `Session Error -- ${folderName}`,
      body: error.slice(0, 200),
      silent: false,
    })

    notification.on('click', () => {
      this.focusAppAndSession(sessionId)
    })

    notification.show()
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.saveSettings()
  }

  setQuietMode(enabled: boolean): void {
    this.quietMode = enabled
    this.saveSettings()
  }

  getSettings(): NotificationState {
    return { enabled: this.enabled, quietMode: this.quietMode }
  }

  private isAppFocused(): boolean {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return false
    return this.mainWindow.isFocused()
  }

  private focusAppAndSession(sessionId: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return
    if (this.mainWindow.isMinimized()) {
      this.mainWindow.restore()
    }
    this.mainWindow.focus()
    // Send an event to the renderer so it can switch to the session
    try {
      this.mainWindow.webContents.send('notification-clicked', { sessionId })
    } catch { /* window destroyed */ }
  }

  private loadSettings(): void {
    try {
      if (existsSync(SETTINGS_PATH)) {
        const data = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'))
        if (typeof data.enabled === 'boolean') this.enabled = data.enabled
        if (typeof data.quietMode === 'boolean') this.quietMode = data.quietMode
      }
    } catch { /* use defaults */ }
  }

  private saveSettings(): void {
    try {
      const dir = join(homedir(), '.devhub-ai')
      mkdirSync(dir, { recursive: true })
      writeFileSync(SETTINGS_PATH, JSON.stringify({
        enabled: this.enabled,
        quietMode: this.quietMode,
      }, null, 2))
    } catch { /* non-fatal */ }
  }
}

export const notificationManager = new NotificationManager()
