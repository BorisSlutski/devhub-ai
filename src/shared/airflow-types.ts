export interface AirflowConnection {
  baseUrl: string
  username: string
  password: string
  apiVersion: 'v1' | 'v2'
}

export interface AirflowDag {
  dagId: string
  isPaused: boolean
  tags: string[]
  owners: string[]
  description: string
}

export interface AirflowDagRun {
  dagRunId: string
  state: string
  startDate: string | null
  endDate: string | null
  logicalDate: string | null
}

export interface AirflowTaskInstance {
  taskId: string
  state: string
  startDate: string | null
  endDate: string | null
  tryNumber: number
}

export interface AirflowDiscoverResult {
  isRepo: boolean
  repoRoot: string | null
  apiUrl: string | null
  uiPort: number | null
  setupScriptExists: boolean
}

export interface AirflowHealthResult {
  ok: boolean
  error?: string
}
