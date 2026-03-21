import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState, ProcessStatus, Project, WorkspaceFolder,
  AgentInfo, PipelineRun, PipelineConfig,
  CoachConfig, CoachSuggestion, CoachAnalysis, CoachSessionCost,
  IpcResult, GitInfo, GitStatus, BranchList, WorktreeResult,
  PtyCreateOptions, PtyCreateResult, PtySessionInfo,
  DirectoryEntry, FileContent, FileSearchResult, FileSearchEntry, DiffResult,
  SystemPortInfo, RtkStatus, RtkToggleResult, RtkGainStats,
  BrowserEvent, ActiveSession, ClaudeSessionInfo, SessionTitle,
  McpConfigEntry, SkillEntry, CreateCommandOptions, SaveTempImageOptions,
  StatuslineData, RecoverableSession, ScrollbackRestoreResult, ResourceSnapshot,
} from '../shared/ipc-types'

const api = {
  // State
  getState: (): Promise<AppState> => ipcRenderer.invoke('get-state'),
  saveState: (state: AppState): Promise<boolean> => ipcRenderer.invoke('save-state', state),
  scanWorkspace: (scanPath: string, maxDepth?: number): Promise<Project[]> => ipcRenderer.invoke('scan-workspace', scanPath, maxDepth),

  // Process management
  startProject: (project: Project): Promise<ProcessStatus> => ipcRenderer.invoke('start-project', project),
  stopProject: (projectId: string): Promise<boolean> => ipcRenderer.invoke('stop-project', projectId),
  getProcessStatuses: (): Promise<ProcessStatus[]> => ipcRenderer.invoke('get-process-statuses'),
  getLogs: (projectId: string): Promise<string[]> => ipcRenderer.invoke('get-logs', projectId),
  openInBrowser: (url: string): Promise<void> => ipcRenderer.invoke('open-in-browser', url),
  detectSystemPorts: (ports: number[]): Promise<Record<number, SystemPortInfo>> =>
    ipcRenderer.invoke('detect-system-ports', ports),
  killSystemProcess: (pid: number): Promise<boolean> => ipcRenderer.invoke('kill-system-process', pid),

  // Workspace folders
  listWorkspaceFolders: (scanPath: string): Promise<WorkspaceFolder[]> =>
    ipcRenderer.invoke('list-workspace-folders', scanPath),

  // IDE / OS integration
  openInIde: (projectPath: string, ide: 'cursor' | 'zed'): Promise<boolean> =>
    ipcRenderer.invoke('open-in-ide', projectPath, ide),
  openInFinder: (projectPath: string): Promise<void> =>
    ipcRenderer.invoke('open-in-finder', projectPath),
  openInTerminal: (projectPath: string): Promise<boolean> =>
    ipcRenderer.invoke('open-in-terminal', projectPath),
  selectFolder: (): Promise<string | null> => ipcRenderer.invoke('select-folder'),

  // Git
  getGitInfo: (folderPath: string): Promise<GitInfo> =>
    ipcRenderer.invoke('get-git-info', folderPath),
  getGitStatus: (folderPath: string): Promise<GitStatus> =>
    ipcRenderer.invoke('get-git-status', folderPath),
  listBranches: (folderPath: string): Promise<BranchList> =>
    ipcRenderer.invoke('list-branches', folderPath),
  checkoutBranch: (folderPath: string, branchName: string): Promise<IpcResult> =>
    ipcRenderer.invoke('checkout-branch', folderPath, branchName),
  openClaudeWorktree: (projectPath: string, projectName: string): Promise<WorktreeResult> =>
    ipcRenderer.invoke('open-claude-worktree', projectPath, projectName),

  // PTY (embedded terminal)
  ptyCreate: (opts: PtyCreateOptions): Promise<PtyCreateResult> =>
    ipcRenderer.invoke('pty-create', opts),
  ptyWrite: (sessionId: string, data: string): void => {
    ipcRenderer.send('pty-write', sessionId, data)
  },
  ptyResize: (sessionId: string, cols: number, rows: number): void => {
    ipcRenderer.send('pty-resize', sessionId, cols, rows)
  },
  ptyDestroy: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('pty-destroy', sessionId),
  cleanupWorktree: (worktreePath: string, folderPath: string): Promise<IpcResult> =>
    ipcRenderer.invoke('cleanup-worktree', worktreePath, folderPath),
  ptyListSessions: (): Promise<PtySessionInfo[]> =>
    ipcRenderer.invoke('pty-list-sessions'),

  // File explorer
  listDirectory: (dirPath: string): Promise<DirectoryEntry[]> =>
    ipcRenderer.invoke('list-directory', dirPath),
  readFile: (filePath: string): Promise<FileContent> =>
    ipcRenderer.invoke('read-file', filePath),
  searchFiles: (rootPath: string, query: string): Promise<FileSearchResult> =>
    ipcRenderer.invoke('search-files', rootPath, query),
  findFilesByName: (rootPath: string, query: string): Promise<FileSearchEntry[]> =>
    ipcRenderer.invoke('find-files-by-name', rootPath, query),
  getWorktreeDiff: (worktreePath: string): Promise<DiffResult> =>
    ipcRenderer.invoke('get-worktree-diff', worktreePath),
  detectClaudeSessionId: (cwd: string): Promise<{ sessionId: string | null }> =>
    ipcRenderer.invoke('detect-claude-session-id', cwd),
  saveTempImage: (opts: SaveTempImageOptions): Promise<{ path?: string; error?: string }> =>
    ipcRenderer.invoke('save-temp-image', opts),

  // Browser bridge
  openBrowser: (sessionId: string, url?: string): Promise<{ opened: boolean }> =>
    ipcRenderer.invoke('open-browser', sessionId, url),
  closeBrowser: (sessionId: string): Promise<{ closed: boolean }> =>
    ipcRenderer.invoke('close-browser', sessionId),
  isBrowserOpen: (sessionId: string): Promise<boolean> =>
    ipcRenderer.invoke('is-browser-open', sessionId),
  onBrowserEvent: (callback: (data: BrowserEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: BrowserEvent) => callback(data)
    ipcRenderer.on('browser-event', handler)
    return () => ipcRenderer.removeListener('browser-event', handler)
  },

  // PTY events
  onPtyData: (callback: (data: { sessionId: string; data: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; data: string }) => callback(data)
    ipcRenderer.on('pty-data', handler)
    return () => ipcRenderer.removeListener('pty-data', handler)
  },
  onPtyExit: (callback: (data: { sessionId: string; exitCode: number }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string; exitCode: number }) => callback(data)
    ipcRenderer.on('pty-exit', handler)
    return () => ipcRenderer.removeListener('pty-exit', handler)
  },

  // Statusline data (structured context/model/cost from Claude Code)
  onStatuslineData: (callback: (data: StatuslineData) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: StatuslineData) => callback(data)
    ipcRenderer.on('statusline-data', handler)
    return () => ipcRenderer.removeListener('statusline-data', handler)
  },

  // Process events
  onProcessLog: (callback: (data: { projectId: string; line: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { projectId: string; line: string }) => callback(data)
    ipcRenderer.on('process-log', handler)
    return () => ipcRenderer.removeListener('process-log', handler)
  },
  onProcessStatusChanged: (callback: (status: ProcessStatus) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: ProcessStatus) => callback(status)
    ipcRenderer.on('process-status-changed', handler)
    return () => ipcRenderer.removeListener('process-status-changed', handler)
  },

  // Pipeline
  pipelineStart: (folderName: string, folderPath: string, taskDescription: string): Promise<PipelineRun> =>
    ipcRenderer.invoke('pipeline-start', folderName, folderPath, taskDescription),
  pipelineCancel: (pipelineId: string): Promise<void> =>
    ipcRenderer.invoke('pipeline-cancel', pipelineId),
  pipelineGetRuns: (): Promise<PipelineRun[]> =>
    ipcRenderer.invoke('pipeline-get-runs'),
  pipelineGetConfig: (folderPath: string): Promise<PipelineConfig> =>
    ipcRenderer.invoke('pipeline-get-config', folderPath),
  pipelineSetConfig: (folderPath: string, config: Partial<PipelineConfig>): Promise<void> =>
    ipcRenderer.invoke('pipeline-set-config', folderPath, config),
  onPipelineEvent: (callback: (run: PipelineRun) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, run: PipelineRun) => callback(run)
    ipcRenderer.on('pipeline-event', handler)
    return () => ipcRenderer.removeListener('pipeline-event', handler)
  },

  // RTK (Rust Token Killer)
  rtkDetect: (): Promise<RtkStatus> =>
    ipcRenderer.invoke('rtk-detect'),
  rtkEnable: (): Promise<RtkToggleResult> =>
    ipcRenderer.invoke('rtk-enable'),
  rtkDisable: (): Promise<RtkToggleResult> =>
    ipcRenderer.invoke('rtk-disable'),
  rtkGain: (): Promise<RtkGainStats | null> =>
    ipcRenderer.invoke('rtk-gain'),
  rtkSessionToggle: (sessionId: string, disabled: boolean): Promise<{ disabled: boolean }> =>
    ipcRenderer.invoke('rtk-session-toggle', sessionId, disabled),
  rtkSessionStatus: (sessionId: string): Promise<{ disabled: boolean }> =>
    ipcRenderer.invoke('rtk-session-status', sessionId),

  // Agent scanner
  scanAgents: (): Promise<AgentInfo[]> => ipcRenderer.invoke('scan-agents'),
  getAgentLogs: (agentId: string, logType: 'history' | 'stdout'): Promise<string[]> =>
    ipcRenderer.invoke('get-agent-logs', agentId, logType),
  triggerAgent: (agentId: string): Promise<IpcResult> =>
    ipcRenderer.invoke('trigger-agent', agentId),

  // Coach
  coachGetConfig: (): Promise<CoachConfig> =>
    ipcRenderer.invoke('coach-get-config'),
  coachSetConfig: (config: CoachConfig): Promise<void> =>
    ipcRenderer.invoke('coach-set-config', config),
  coachGetSuggestions: (sessionId: string): Promise<CoachSuggestion[]> =>
    ipcRenderer.invoke('coach-get-suggestions', sessionId),
  coachGetCost: (sessionId: string): Promise<CoachSessionCost> =>
    ipcRenderer.invoke('coach-get-cost', sessionId),
  coachGetTotalCost: (): Promise<CoachSessionCost> =>
    ipcRenderer.invoke('coach-get-total-cost'),
  coachDismiss: (sessionId: string, suggestionId: string): Promise<void> =>
    ipcRenderer.invoke('coach-dismiss', sessionId, suggestionId),
  onCoachSuggestion: (callback: (data: CoachAnalysis) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: CoachAnalysis) => callback(data)
    ipcRenderer.on('coach-suggestion', handler)
    return () => ipcRenderer.removeListener('coach-suggestion', handler)
  },

  // MCP & Skills
  mcpGetConfig: (projectPath?: string): Promise<McpConfigEntry[]> =>
    ipcRenderer.invoke('mcp-get-config', projectPath),
  mcpCheckStatus: (): Promise<Record<string, 'ok' | 'error' | 'warning' | 'unknown'>> =>
    ipcRenderer.invoke('mcp-check-status'),
  mcpSaveConfig: (filePath: string, servers: Record<string, any>): Promise<IpcResult> =>
    ipcRenderer.invoke('mcp-save-config', filePath, servers),
  skillsList: (projectPath?: string): Promise<SkillEntry[]> =>
    ipcRenderer.invoke('skills-list', projectPath),
  createCommand: (opts: CreateCommandOptions): Promise<IpcResult & { path?: string }> =>
    ipcRenderer.invoke('create-command', opts),
  deleteCommand: (filePath: string): Promise<IpcResult> =>
    ipcRenderer.invoke('delete-command', filePath),

  // Scrollback persistence (crash recovery)
  scrollbackListRecoverable: (): Promise<RecoverableSession[]> =>
    ipcRenderer.invoke('scrollback-list-recoverable'),
  scrollbackRestore: (sessionId: string): Promise<ScrollbackRestoreResult | null> =>
    ipcRenderer.invoke('scrollback-restore', sessionId),
  scrollbackDismiss: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('scrollback-dismiss', sessionId),
  scrollbackCleanupOld: (): Promise<void> =>
    ipcRenderer.invoke('scrollback-cleanup-old'),

  // Active sessions (auto-resume)
  activeSessionsSet: (session: ActiveSession): Promise<void> =>
    ipcRenderer.invoke('active-sessions-set', session),
  activeSessionsUpdateClaudeId: (id: string, claudeSessionId: string): Promise<void> =>
    ipcRenderer.invoke('active-sessions-update-claude-id', id, claudeSessionId),
  activeSessionsRemove: (id: string): Promise<void> =>
    ipcRenderer.invoke('active-sessions-remove', id),
  activeSessionsGetAll: (): Promise<ActiveSession[]> =>
    ipcRenderer.invoke('active-sessions-get-all'),

  // Session history
  sessionHistoryScan: (folderPath: string, folderName: string): Promise<ClaudeSessionInfo[]> =>
    ipcRenderer.invoke('session-history-scan', folderPath, folderName),
  sessionHistoryTitle: (claudeSessionId: string, dirName: string): Promise<SessionTitle | null> =>
    ipcRenderer.invoke('session-history-title', claudeSessionId, dirName),

  // Resource monitoring
  resourceGetSnapshot: (): Promise<ResourceSnapshot> =>
    ipcRenderer.invoke('resource-get-snapshot'),
  resourceSubscribe: (): Promise<void> =>
    ipcRenderer.invoke('resource-subscribe'),
  resourceUnsubscribe: (): Promise<void> =>
    ipcRenderer.invoke('resource-unsubscribe'),
  onResourceUpdate: (callback: (snapshot: ResourceSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: ResourceSnapshot) => callback(snapshot)
    ipcRenderer.on('resource-update', handler)
    return () => ipcRenderer.removeListener('resource-update', handler)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
