import { ipcMain, BrowserWindow } from 'electron'
import { resourceMonitor } from '../resource-monitor'
import type { ResourceSnapshot } from '../../shared/ipc-types'

let subscribedWindow: BrowserWindow | null = null
let updateHandler: ((snapshot: ResourceSnapshot) => void) | null = null

export function registerResourceHandlers() {
  ipcMain.handle('resource-get-snapshot', async () => {
    return resourceMonitor.getSnapshot()
  })

  ipcMain.handle('resource-subscribe', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return

    // Remove previous subscription if any
    unsubscribe()

    subscribedWindow = win
    updateHandler = (snapshot: ResourceSnapshot) => {
      try {
        if (subscribedWindow && !subscribedWindow.isDestroyed()) {
          subscribedWindow.webContents.send('resource-update', snapshot)
        }
      } catch { /* window destroyed */ }
    }
    resourceMonitor.onUpdate(updateHandler)
  })

  ipcMain.handle('resource-unsubscribe', () => {
    unsubscribe()
  })
}

function unsubscribe() {
  if (updateHandler) {
    resourceMonitor.offUpdate(updateHandler)
    updateHandler = null
  }
  subscribedWindow = null
}
