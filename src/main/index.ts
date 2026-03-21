import { app, BrowserWindow, nativeImage, shell } from 'electron'
import { join } from 'path'
import { processManager, getShellPath } from './process-manager'
import { ptyManager } from './pty-manager'
import { ScrollbackReader } from './scrollback-manager'
import { startBrowserBridge, setBrowserBridgeWindow, stopBrowserBridge } from './browser-bridge'
import { pipelineManager } from './pipeline-manager'
import { loadState } from './store'
import { writeRtkWrapper } from './rtk-manager'
import { coachManager } from './coach-manager'
import { statuslineWatcher } from './statusline-watcher'

import {
  registerStateHandlers,
  registerProcessHandlers,
  registerGitHandlers,
  registerFileHandlers,
  registerSessionHandlers,
  setSessionMainWindow,
  registerBrowserHandlers,
  registerPipelineHandlers,
  registerRtkHandlers,
  registerAgentHandlers,
  registerCoachHandlers,
  loadCoachConfig,
  registerMcpHandlers,
  registerScrollbackHandlers,
  registerResourceHandlers,
} from './handlers'
import { resourceMonitor } from './resource-monitor'

let mainWindow: BrowserWindow | null = null

async function createWindow() {
  const iconPng = join(__dirname, '../../resources/icon.png')
  const iconIcns = join(__dirname, '../../resources/icon.icns')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DevDock',
    titleBarStyle: 'hiddenInset',
    icon: iconPng,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.platform === 'darwin') {
    try {
      let icon = nativeImage.createFromPath(iconPng)
      if (icon.isEmpty()) {
        icon = nativeImage.createFromPath(iconIcns)
      }
      if (!icon.isEmpty()) {
        app.dock.setIcon(icon)
      }
    } catch { /* ignore */ }
  }

  processManager.setMainWindow(mainWindow)
  ptyManager.setMainWindow(mainWindow)
  ptyManager.setShellPath(getShellPath())
  setBrowserBridgeWindow(mainWindow)
  pipelineManager.setMainWindow(mainWindow)
  pipelineManager.loadConfigs()
  pipelineManager.loadRuns()
  coachManager.setMainWindow(mainWindow)
  loadCoachConfig()
  setSessionMainWindow(mainWindow)
  ptyManager.onData((sessionId, data) => coachManager.feedData(sessionId, data))

  // Statusline: deploy script, inject settings, watch sessions
  statuslineWatcher.setMainWindow(mainWindow)
  statuslineWatcher.setup()
  ptyManager.onExit((sessionId) => statuslineWatcher.unwatchSession(sessionId))

  await startBrowserBridge()

  // Start resource monitor and toggle idle mode on focus/blur
  resourceMonitor.start(3000)
  mainWindow.on('focus', () => resourceMonitor.setIdle(false))
  mainWindow.on('blur', () => resourceMonitor.setIdle(true))

  const appState = loadState()
  if (appState.rtkEnabled) {
    writeRtkWrapper()
  }

  // Clean up old scrollback files (older than 7 days)
  try { ScrollbackReader.cleanupOld(7) } catch { /* non-fatal */ }

  // Open external links in the system browser, not inside the Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Allow navigation to the app itself (dev server or file://)
    const currentURL = mainWindow?.webContents.getURL() || ''
    const isSameOrigin = currentURL && new URL(url).origin === new URL(currentURL).origin
    if (!isSameOrigin) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function setupIPC() {
  registerStateHandlers()
  registerProcessHandlers()
  registerGitHandlers()
  registerFileHandlers()
  registerSessionHandlers()
  registerBrowserHandlers()
  registerPipelineHandlers()
  registerRtkHandlers()
  registerAgentHandlers()
  registerCoachHandlers()
  registerMcpHandlers()
  registerScrollbackHandlers()
  registerResourceHandlers()
}

app.whenReady().then(() => {
  setupIPC()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  processManager.stopAll()
  ptyManager.destroyAll()
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  resourceMonitor.stop()
  processManager.stopAll()
  ptyManager.destroyAll()
  pipelineManager.destroyAll()
  statuslineWatcher.unwatchAll()
  stopBrowserBridge()
})
