import { app } from 'electron'

type AutoUpdater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on: (event: string, cb: (...args: any[]) => void) => void
  checkForUpdates: () => Promise<unknown>
  downloadUpdate: () => Promise<unknown>
  quitAndInstall: () => void
}

let autoUpdater: AutoUpdater | null = null
try {
  // Optional dependency — install electron-updater for packaged auto-updates
  autoUpdater = require('electron-updater').autoUpdater as AutoUpdater
} catch {
  autoUpdater = null
}

let updateStatus: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' = 'idle'
let updateError: string | null = null
let updateVersion: string | null = null
let downloadPercent = 0

export function getUpdateStatus() {
  return { status: updateStatus, error: updateError, version: updateVersion, percent: downloadPercent }
}

export function initAutoUpdater(onStatus?: () => void): void {
  if (!app.isPackaged || !autoUpdater) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    updateStatus = 'checking'
    updateError = null
    onStatus?.()
  })

  autoUpdater.on('update-available', (info: { version: string }) => {
    updateStatus = 'available'
    updateVersion = info.version
    onStatus?.()
  })

  autoUpdater.on('update-not-available', () => {
    updateStatus = 'idle'
    updateVersion = null
    onStatus?.()
  })

  autoUpdater.on('error', (err: Error) => {
    updateStatus = 'error'
    updateError = err.message
    onStatus?.()
  })

  autoUpdater.on('download-progress', (p: { percent: number }) => {
    updateStatus = 'downloading'
    downloadPercent = p.percent
    onStatus?.()
  })

  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    updateStatus = 'ready'
    updateVersion = info.version
    onStatus?.()
  })
}

export async function checkForUpdates(): Promise<ReturnType<typeof getUpdateStatus>> {
  if (!app.isPackaged) {
    return { status: 'idle' as const, error: 'Updates are only available in packaged builds', version: null, percent: 0 }
  }
  if (!autoUpdater) {
    return { status: 'idle' as const, error: 'Install electron-updater for auto-update support', version: null, percent: 0 }
  }
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    updateStatus = 'error'
    updateError = err instanceof Error ? err.message : String(err)
  }
  return getUpdateStatus()
}

export async function downloadUpdate(): Promise<ReturnType<typeof getUpdateStatus>> {
  if (!app.isPackaged || !autoUpdater) return getUpdateStatus()
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    updateStatus = 'error'
    updateError = err instanceof Error ? err.message : String(err)
  }
  return getUpdateStatus()
}

export function installUpdate(): void {
  if (updateStatus === 'ready' && autoUpdater) {
    autoUpdater.quitAndInstall()
  }
}
