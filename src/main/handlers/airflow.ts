import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import type { AirflowConnection } from '../../shared/airflow-types'
import {
  findAstronomerDagsRoot,
  localAirflowApiUrl,
  discoverLocalAirflowPort,
  setupWorktreeScriptPath,
} from '../../shared/astronomer-dags'
import {
  airflowHealth,
  listDags,
  patchDagPaused,
  triggerDag,
  listDagRuns,
  listTaskInstances,
  getTaskLog,
} from '../airflow-client'

const DEFAULT_CONN = {
  username: 'admin',
  password: 'admin',
  apiVersion: 'v1' as const,
}

function connectionForRepo(repoRoot: string, apiVersion?: 'v1' | 'v2'): AirflowConnection {
  const version = apiVersion ?? DEFAULT_CONN.apiVersion
  return {
    ...DEFAULT_CONN,
    apiVersion: version,
    baseUrl: localAirflowApiUrl(repoRoot, version),
  }
}

export function registerAirflowHandlers() {
  ipcMain.handle('airflow-discover', (_event, scanPath: string) => {
    const repoRoot = findAstronomerDagsRoot(scanPath)
    if (!repoRoot) {
      return {
        isRepo: false,
        repoRoot: null,
        apiUrl: null,
        uiPort: null,
        setupScriptExists: false,
      }
    }
    return {
      isRepo: true,
      repoRoot,
      apiUrl: localAirflowApiUrl(repoRoot),
      uiPort: discoverLocalAirflowPort(repoRoot),
      setupScriptExists: existsSync(setupWorktreeScriptPath(repoRoot)),
    }
  })

  ipcMain.handle('airflow-health', async (_event, repoRoot: string) => {
    try {
      return await airflowHealth(connectionForRepo(repoRoot))
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('airflow-list-dags', async (_event, repoRoot: string) => {
    try {
      const dags = await listDags(connectionForRepo(repoRoot))
      return { success: true, dags }
    } catch (err) {
      return { success: false, dags: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('airflow-patch-dag', async (_event, repoRoot: string, dagId: string, isPaused: boolean) => {
    try {
      await patchDagPaused(connectionForRepo(repoRoot), dagId, isPaused)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'airflow-trigger-dag',
    async (_event, repoRoot: string, dagId: string, confJson?: string) => {
      try {
        let conf: Record<string, unknown> | undefined
        if (confJson?.trim()) {
          conf = JSON.parse(confJson)
        }
        const dagRunId = await triggerDag(connectionForRepo(repoRoot), dagId, conf)
        return { success: true, dagRunId }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle('airflow-list-dag-runs', async (_event, repoRoot: string, dagId: string) => {
    try {
      const runs = await listDagRuns(connectionForRepo(repoRoot), dagId)
      return { success: true, runs }
    } catch (err) {
      return { success: false, runs: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'airflow-list-task-instances',
    async (_event, repoRoot: string, dagId: string, dagRunId: string) => {
      try {
        const tasks = await listTaskInstances(connectionForRepo(repoRoot), dagId, dagRunId)
        return { success: true, tasks }
      } catch (err) {
        return { success: false, tasks: [], error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(
    'airflow-get-task-log',
    async (_event, repoRoot: string, dagId: string, dagRunId: string, taskId: string, tryNumber?: number) => {
      try {
        const log = await getTaskLog(
          connectionForRepo(repoRoot),
          dagId,
          dagRunId,
          taskId,
          tryNumber ?? 1,
        )
        return { success: true, log }
      } catch (err) {
        return { success: false, log: '', error: err instanceof Error ? err.message : String(err) }
      }
    },
  )
}
