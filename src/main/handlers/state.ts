import { ipcMain } from 'electron'
import { loadState, saveState } from '../store'
import { scanWorkspaceAsync } from '../scanner'
import { AppState, Project } from '../../shared/types'

export function registerStateHandlers() {
  ipcMain.handle('get-state', () => loadState())

  ipcMain.handle('save-state', (_event, state: AppState) => {
    saveState(state)
    return true
  })

  ipcMain.handle('scan-workspace', async (_event, scanPath: string, maxDepth?: number) => {
    console.log('[scan-workspace] handler called — scanPath:', scanPath, 'maxDepth:', maxDepth)
    const t0 = Date.now()
    const result = await scanWorkspaceAsync(scanPath, maxDepth)
    console.log('[scan-workspace] handler done —', result.length, 'projects in', Date.now() - t0, 'ms')
    return result
  })
}
