export interface Project {
  id: string
  name: string
  path: string
  tags: string[]
  description: string
  techStack: string[]
  runCommand: string
  port: number | null
  lastOpened: string | null
  hidden: boolean
}

export interface RunningProcess {
  projectId: string
  pid: number
  port: number
  startedAt: string
}

export interface AppState {
  projects: Project[]
  tags: string[]
  scanPath: string
  scanDepth?: number
  removedPaths?: string[]
  rtkEnabled?: boolean
  dangerousMode?: boolean
  chatInputEnabled?: boolean
  defaultModel?: string
  workspaceChosen?: boolean
  activeTab?: 'launchpad' | 'folders' | 'claude' | 'agents' | 'db-access'
  selectedProjectId?: string | null
  /** Absolute paths of starred folders on the All Folders tab */
  favoriteFolderPaths?: string[]
  foldersSortBy?: 'name' | 'recent'
  usePtyDaemon?: boolean
  setupWizardDismissed?: boolean
}

export interface ProcessStatus {
  projectId: string
  running: boolean
  pid: number | null
  port: number | null
  logs: string[]
}

export interface SystemPortInfo {
  port: number
  pid: number
  command: string
  cwd: string
}

export interface WorkspaceFolder {
  name: string
  path: string
  modifiedAt: string
  gitBranch: string | null
  gitRemote: string | null
}

export type IpcChannels = {
  'scan-workspace': { scanPath: string; maxDepth?: number }
  'get-state': void
  'save-state': AppState
  'start-project': { projectId: string }
  'stop-project': { projectId: string }
  'get-process-status': void
  'update-project': Project
  'open-in-browser': { url: string }
  'process-log': { projectId: string; line: string }
  'process-status-changed': ProcessStatus
}
