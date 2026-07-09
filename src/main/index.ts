// Suppress EPIPE errors on stdout/stderr (happens when dev-mode pipes close)
process.stdout?.on?.('error', () => {})
process.stderr?.on?.('error', () => {})

import { app, BrowserWindow, shell } from 'electron'
import { applyMacDockIcon, resolveAppIconPath } from './app-icon'
import { join } from 'path'
import { processManager, getShellPath } from './process-manager'
import { ptyManager } from './pty-manager'
import { initPtyBackend, attachPtyHooks, isPtyDaemonEnabled } from './pty-backend'
import { initAutoUpdater } from './updater'
import { ScrollbackReader } from './scrollback-manager'
import { startBrowserBridge, setBrowserBridgeWindow, stopBrowserBridge } from './browser-bridge'
import { pipelineManager } from './pipeline-manager'
import { loadState } from './store'
import { writeRtkWrapper } from './rtk-manager'
import { promptEnhancer } from './prompt-enhancer'
import { statuslineWatcher } from './statusline-watcher'
import { workspaceInitTracker } from './workspace-init-tracker'
import { notificationManager } from './notification-manager'

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
  registerEnhancerHandlers,
  loadEnhancerConfig,
  registerMcpHandlers,
  registerScrollbackHandlers,
  registerResourceHandlers,
  registerNotificationHandlers,
  registerPresetHandlers,
  registerAkeylessHandlers,
  registerDbWorkbenchHandlers,
  registerTrinoWorkbenchHandlers,
  registerSummaryHandlers,
} from './handlers'
import { resourceMonitor } from './resource-monitor'
import { setDbIdleMainWindow } from './db-connection-idle'
import { setAkeylessDbMainWindow } from './akeyless-db'

let mainWindow: BrowserWindow | null = null

async function createWindow() {
  const iconPng = resolveAppIconPath('png')

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'DevHub-AI',
    titleBarStyle: 'hiddenInset',
    icon: iconPng,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.maximize()

  processManager.setMainWindow(mainWindow)
  const shellPath = getShellPath()
  ptyManager.setMainWindow(mainWindow)
  ptyManager.setShellPath(shellPath)
  if (isPtyDaemonEnabled()) {
    await initPtyBackend(mainWindow, shellPath)
  }
  setBrowserBridgeWindow(mainWindow)
  pipelineManager.setMainWindow(mainWindow)
  pipelineManager.loadConfigs()
  pipelineManager.loadRuns()
  loadEnhancerConfig()
  setSessionMainWindow(mainWindow)
  setDbIdleMainWindow(mainWindow)
  setAkeylessDbMainWindow(mainWindow)
  workspaceInitTracker.setMainWindow(mainWindow)
  notificationManager.setMainWindow(mainWindow)

  // Idle detection for desktop notifications (mirrors XTerminal 8s idle)
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const sessionWaiting = new Set<string>()

  attachPtyHooks(
    (sessionId, data) => {
      promptEnhancer.feedContext(sessionId, data)
      if (sessionWaiting.has(sessionId)) sessionWaiting.delete(sessionId)
      const existing = idleTimers.get(sessionId)
      if (existing) clearTimeout(existing)
      idleTimers.set(sessionId, setTimeout(() => {
        if (!sessionWaiting.has(sessionId)) {
          sessionWaiting.add(sessionId)
          notificationManager.notifySessionComplete(sessionId)
        }
      }, 8000))
    },
    (sessionId) => {
      const timer = idleTimers.get(sessionId)
      if (timer) clearTimeout(timer)
      idleTimers.delete(sessionId)
      sessionWaiting.delete(sessionId)
      notificationManager.untrackSession(sessionId)
      statuslineWatcher.unwatchSession(sessionId)
    }
  )

  statuslineWatcher.setMainWindow(mainWindow)
  statuslineWatcher.setup()
  initAutoUpdater()

  await startBrowserBridge()

  // Resource monitor polls only while a renderer client is subscribed (see resources handler)
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
  registerEnhancerHandlers()
  registerMcpHandlers()
  registerScrollbackHandlers()
  registerResourceHandlers()
  registerNotificationHandlers()
  registerPresetHandlers()
  registerAkeylessHandlers()
  registerDbWorkbenchHandlers()
  registerTrinoWorkbenchHandlers()
  registerSummaryHandlers()
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.setName('DevHub-AI')
    applyMacDockIcon()
  }
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
  try {
    const { flushSaveStateSync } = require('./store')
    flushSaveStateSync()
  } catch { /* store may not be loaded */ }
  resourceMonitor.stop()
  processManager.stopAll()
  ptyManager.destroyAll()
  pipelineManager.destroyAll()
  statuslineWatcher.unwatchAll()
  stopBrowserBridge()
  // Clean up DB workbench connections and tunnels
  try {
    const { mysqlClient } = require('./mysql-client')
    const { akeylessDb } = require('./akeyless-db')
    mysqlClient.disconnectAll().catch(() => {})
    akeylessDb.closeAllTunnels()
  } catch { /* modules may not be loaded yet */ }
})
