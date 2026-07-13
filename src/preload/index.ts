import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppState, ProcessStatus, Project, WorkspaceFolder,
  AgentInfo, PipelineRun, PipelineConfig,
  EnhancerConfig, EnhanceResult, EnhancerSessionCost,
  IpcResult, GitInfo, GitFolderMeta, GitStatus, GitSyncStatus, GitPullResult, GitPullAllResult,
  GitPullFinishedEvent, GitPullBatchFinishedEvent, GitPullStartResult,
  GitWorkingTreeChanges, GitPullOptions,
  BranchList, WorktreeResult,
  PtyCreateOptions, PtyCreateResult, PtySessionInfo,
  DirectoryEntry, FileContent, FileSearchResult, FileSearchEntry, DiffResult,
  SystemPortInfo, RtkStatus, RtkToggleResult, RtkGainStats,
  BrowserEvent, ActiveSession, ClaudeSessionInfo, SessionTitle,
  McpConfigEntry, McpRawFileResult, SkillEntry, CreateCommandOptions, SaveTempImageOptions,
  StatuslineData, RecoverableSession, ScrollbackRestoreResult, ResourceSnapshot,
  InitProgress, NotificationSettings,
  SessionPreset, SessionPresetCreate, PresetLaunchOptions, PresetLaunchResult,
  SessionSummary, SaveSummaryOptions,
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
  getFolderGitMeta: (folderPath: string, fetch?: boolean): Promise<GitFolderMeta> =>
    ipcRenderer.invoke('get-folder-git-meta', folderPath, fetch ?? false),
  getGitStatus: (folderPath: string): Promise<GitStatus> =>
    ipcRenderer.invoke('get-git-status', folderPath),
  getGitSyncStatus: (folderPath: string, fetch?: boolean): Promise<GitSyncStatus> =>
    ipcRenderer.invoke('get-git-sync-status', folderPath, fetch ?? false),
  getFolderWorkingTree: (folderPath: string): Promise<GitWorkingTreeChanges> =>
    ipcRenderer.invoke('get-folder-working-tree', folderPath),
  pullFolderToBase: (folderPath: string, options?: GitPullOptions): Promise<GitPullResult> =>
    ipcRenderer.invoke('pull-folder-to-base', folderPath, options),
  pullAllFoldersToBase: (folderPaths: string[]): Promise<GitPullAllResult[]> =>
    ipcRenderer.invoke('pull-all-folders-to-base', folderPaths),
  startPullFolderToBase: (
    folderPath: string,
    options?: GitPullOptions,
  ): Promise<GitPullStartResult> =>
    ipcRenderer.invoke('start-pull-folder-to-base', folderPath, options),
  startPullAllFoldersToBase: (folderPaths: string[]): Promise<GitPullStartResult> =>
    ipcRenderer.invoke('start-pull-all-folders-to-base', folderPaths),
  onGitPullFinished: (callback: (event: GitPullFinishedEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: GitPullFinishedEvent) => callback(data)
    ipcRenderer.on('git-pull-finished', handler)
    return () => ipcRenderer.removeListener('git-pull-finished', handler)
  },
  onGitPullBatchFinished: (callback: (event: GitPullBatchFinishedEvent) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, data: GitPullBatchFinishedEvent) => callback(data)
    ipcRenderer.on('git-pull-batch-finished', handler)
    return () => ipcRenderer.removeListener('git-pull-batch-finished', handler)
  },
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

  // Prompt Enhancer
  enhancerGetConfig: (): Promise<EnhancerConfig> =>
    ipcRenderer.invoke('enhancer-get-config'),
  enhancerSetConfig: (config: EnhancerConfig): Promise<void> =>
    ipcRenderer.invoke('enhancer-set-config', config),
  enhancePrompt: (sessionId: string, prompt: string): Promise<EnhanceResult | null> =>
    ipcRenderer.invoke('enhancer-enhance-prompt', sessionId, prompt),
  enhancerGetCost: (sessionId: string): Promise<EnhancerSessionCost> =>
    ipcRenderer.invoke('enhancer-get-cost', sessionId),
  enhancerGetTotalCost: (): Promise<EnhancerSessionCost> =>
    ipcRenderer.invoke('enhancer-get-total-cost'),

  // MCP & Skills
  mcpGetConfig: (projectPath?: string): Promise<McpConfigEntry[]> =>
    ipcRenderer.invoke('mcp-get-config', projectPath),
  mcpCheckStatus: (): Promise<Record<string, 'ok' | 'error' | 'warning' | 'unknown'>> =>
    ipcRenderer.invoke('mcp-check-status'),
  mcpSaveConfig: (filePath: string, servers: Record<string, any>): Promise<IpcResult> =>
    ipcRenderer.invoke('mcp-save-config', filePath, servers),
  mcpReadRawFile: (filePath: string): Promise<McpRawFileResult> =>
    ipcRenderer.invoke('mcp-read-raw-file', filePath),
  mcpSaveRawFile: (filePath: string, content: string): Promise<IpcResult> =>
    ipcRenderer.invoke('mcp-save-raw-file', filePath, content),
  mcpMergeServers: (
    filePath: string,
    servers: Record<string, any>,
    mode: 'merge' | 'replace'
  ): Promise<IpcResult> =>
    ipcRenderer.invoke('mcp-merge-servers', filePath, servers, mode),
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
  activeSessionsSetActiveId: (id: string | null): Promise<void> =>
    ipcRenderer.invoke('active-sessions-set-active-id', id),
  activeSessionsGetActiveId: (): Promise<string | null> =>
    ipcRenderer.invoke('active-sessions-get-active-id'),
  activeSessionsUpdateMeta: (id: string, meta: { nickname?: string; accentColor?: string }): Promise<void> =>
    ipcRenderer.invoke('active-sessions-update-meta', id, meta),
  activeSessionsSetOrder: (order: string[]): Promise<void> =>
    ipcRenderer.invoke('active-sessions-set-order', order),
  activeSessionsGetUi: (): Promise<{
    sessionOrder: string[]
    gridMode: boolean
    gridLayout: string
    gridSessionIds: string[]
  }> => ipcRenderer.invoke('active-sessions-get-ui'),
  activeSessionsSetUi: (partial: {
    sessionOrder?: string[]
    gridMode?: boolean
    gridLayout?: string
    gridSessionIds?: string[]
  }): Promise<void> => ipcRenderer.invoke('active-sessions-set-ui', partial),

  systemCheck: (): Promise<{
    node: { ok: boolean; version: string | null }
    claude: { ok: boolean; version: string | null }
    cursor: { ok: boolean; version: string | null }
    codex: { ok: boolean; version: string | null }
    git: { ok: boolean; version: string | null }
  }> => ipcRenderer.invoke('system-check'),

  appCheckUpdates: (): Promise<{ status: string; error: string | null; version: string | null; percent: number }> =>
    ipcRenderer.invoke('app-check-updates'),
  appDownloadUpdate: (): Promise<{ status: string; error: string | null; version: string | null; percent: number }> =>
    ipcRenderer.invoke('app-download-update'),
  appInstallUpdate: (): Promise<void> => ipcRenderer.invoke('app-install-update'),
  appGetUpdateStatus: (): Promise<{ status: string; error: string | null; version: string | null; percent: number }> =>
    ipcRenderer.invoke('app-get-update-status'),

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

  // Workspace init progress
  onWorkspaceInitProgress: (callback: (data: InitProgress) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: InitProgress) => callback(data)
    ipcRenderer.on('workspace-init-progress', handler)
    return () => ipcRenderer.removeListener('workspace-init-progress', handler)
  },
  workspaceInitCancel: (sessionId: string): Promise<void> =>
    ipcRenderer.invoke('workspace-init-cancel', sessionId),

  // Notifications
  notificationSetEnabled: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('notification-set-enabled', enabled),
  notificationSetQuietMode: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('notification-set-quiet-mode', enabled),
  notificationGetSettings: (): Promise<NotificationSettings> =>
    ipcRenderer.invoke('notification-get-settings'),
  onNotificationClicked: (callback: (data: { sessionId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { sessionId: string }) => callback(data)
    ipcRenderer.on('notification-clicked', handler)
    return () => ipcRenderer.removeListener('notification-clicked', handler)
  },

  // Session presets
  presetList: (): Promise<SessionPreset[]> =>
    ipcRenderer.invoke('preset-list'),
  presetCreate: (input: SessionPresetCreate): Promise<SessionPreset> =>
    ipcRenderer.invoke('preset-create', input),
  presetUpdate: (id: string, partial: Partial<SessionPreset>): Promise<SessionPreset | null> =>
    ipcRenderer.invoke('preset-update', id, partial),
  presetDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('preset-delete', id),
  presetGetPinned: (): Promise<SessionPreset[]> =>
    ipcRenderer.invoke('preset-get-pinned'),
  presetGetRecent: (limit?: number): Promise<SessionPreset[]> =>
    ipcRenderer.invoke('preset-get-recent', limit),
  presetLaunch: (opts: PresetLaunchOptions): Promise<PresetLaunchResult> =>
    ipcRenderer.invoke('preset-launch', opts),

  // Session summaries
  summarySave: (opts: SaveSummaryOptions): Promise<SessionSummary> =>
    ipcRenderer.invoke('summary-save', opts),
  summarySaveFromFile: (filePath: string, title: string, projectName: string, projectPath: string, claudeSessionId: string | null, sessionPtyId: string | null): Promise<SessionSummary | null> =>
    ipcRenderer.invoke('summary-save-from-file', filePath, title, projectName, projectPath, claudeSessionId, sessionPtyId),
  summaryList: (projectName?: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke('summary-list', projectName),
  summaryGet: (id: string): Promise<{ summary: SessionSummary; html: string } | null> =>
    ipcRenderer.invoke('summary-get', id),
  summaryDelete: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('summary-delete', id),
  summaryOpenInBrowser: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('summary-open-in-browser', id),

  // Akeyless DB Access
  akeylessCheckStatus: (): Promise<{
    cliInstalled: boolean; cliVersion: string | null;
    profileConfigured: boolean; connectRcConfigured: boolean;
    scriptExists: boolean; scriptPath: string;
  }> => ipcRenderer.invoke('akeyless-check-status'),
  akeylessInstallCli: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('akeyless-install-cli'),
  akeylessConfigure: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('akeyless-configure'),
  akeylessUpdateCli: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('akeyless-update-cli'),

  // DB Workbench
  dbListProducers: (
    type?: 'mysql' | 'mongo',
    forceRefresh?: boolean,
  ): Promise<{
    success: boolean; producers: any[]; error?: string; stale?: boolean;
  }> => ipcRenderer.invoke('db-list-producers', type, forceRefresh),
  dbConnect: (producerName: string): Promise<{
    success: boolean; connectionId?: string; tunnelId?: string;
    kgb?: string; dbName?: string; type?: string; error?: string;
  }> => ipcRenderer.invoke('db-connect', producerName),
  dbDisconnect: (connectionId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('db-disconnect', connectionId),
  dbListConnections: (): Promise<{
    success: boolean
    connections: { id: string; host: string; port: number; user: string; database: string; connected: boolean }[]
    error?: string
  }> => ipcRenderer.invoke('db-list-connections'),
  dbListSessions: (): Promise<{
    success: boolean
    sessions: { connectionId: string; tunnelId: string; kgb: string; dbName: string; producerName: string }[]
    error?: string
  }> => ipcRenderer.invoke('db-list-sessions'),
  onDbIdleDisconnected: (callback: (payload: { connectionId: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { connectionId: string }) => callback(payload)
    ipcRenderer.on('db-idle-disconnected', handler)
    return () => ipcRenderer.removeListener('db-idle-disconnected', handler)
  },
  onDbTunnelClosed: (callback: (payload: { connectionId: string; reason: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { connectionId: string; reason: string }) =>
      callback(payload)
    ipcRenderer.on('db-tunnel-closed', handler)
    return () => ipcRenderer.removeListener('db-tunnel-closed', handler)
  },
  dbExecuteQuery: (connectionId: string, sql: string): Promise<{
    columns: any[]; rows: any[][]; rowCount: number;
    affectedRows: number; executionTimeMs: number; error?: string;
  }> => ipcRenderer.invoke('db-execute-query', connectionId, sql),
  dbCancelQuery: (connectionId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('db-cancel-query', connectionId),
  dbReconnect: (connectionId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('db-reconnect', connectionId),
  dbListTables: (connectionId: string, forceRefresh?: boolean): Promise<{
    success: boolean; tables: any[]; error?: string;
  }> => ipcRenderer.invoke('db-list-tables', connectionId, forceRefresh),
  dbDescribeTable: (connectionId: string, tableName: string): Promise<{
    success: boolean; columns: any[]; error?: string;
  }> => ipcRenderer.invoke('db-describe-table', connectionId, tableName),
  dbListDatabases: (connectionId: string): Promise<{
    success: boolean; databases: string[]; error?: string;
  }> => ipcRenderer.invoke('db-list-databases', connectionId),

  // Trino Workbench
  trinoServerPresets: (): Promise<{
    success: boolean; presets: { label: string; server: string }[];
  }> => ipcRenderer.invoke('trino-server-presets'),
  trinoConnect: (
    connectionId: string,
    server: string,
    catalog: string,
    schema: string,
    user: string,
    password: string,
    savePassword?: boolean,
  ): Promise<{ success: boolean; connectionId?: string; error?: string; credentialWarning?: string }> =>
    ipcRenderer.invoke('trino-connect', connectionId, server, catalog, schema, user, password, savePassword),
  trinoHasSavedCredential: (
    server: string,
    user: string,
  ): Promise<{ success: boolean; hasCredential: boolean; error?: string }> =>
    ipcRenderer.invoke('trino-has-saved-credential', server, user),
  trinoDisconnect: (connectionId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('trino-disconnect', connectionId),
  trinoListConnections: (): Promise<{
    success: boolean
    connections: { id: string; server: string; catalog: string; schema: string; user: string; connected: boolean }[]
    error?: string
  }> => ipcRenderer.invoke('trino-list-connections'),
  trinoExecuteQuery: (connectionId: string, sql: string): Promise<{
    columns: any[]; rows: any[][]; rowCount: number;
    affectedRows: number; executionTimeMs: number; error?: string; truncated?: boolean;
  }> => ipcRenderer.invoke('trino-execute-query', connectionId, sql),
  trinoCancelQuery: (connectionId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('trino-cancel-query', connectionId),
  trinoListCatalogs: (connectionId: string): Promise<{
    success: boolean; catalogs: string[]; error?: string;
  }> => ipcRenderer.invoke('trino-list-catalogs', connectionId),
  trinoListSchemas: (connectionId: string, catalog: string): Promise<{
    success: boolean; schemas: string[]; error?: string;
  }> => ipcRenderer.invoke('trino-list-schemas', connectionId, catalog),
  trinoListTables: (connectionId: string, catalog?: string, schema?: string): Promise<{
    success: boolean; tables: any[]; error?: string;
  }> => ipcRenderer.invoke('trino-list-tables', connectionId, catalog, schema),
  trinoDescribeTable: (
    connectionId: string,
    tableName: string,
    catalog?: string,
    schema?: string,
  ): Promise<{ success: boolean; columns: any[]; error?: string }> =>
    ipcRenderer.invoke('trino-describe-table', connectionId, tableName, catalog, schema),
}

contextBridge.exposeInMainWorld('api', api)

export type ElectronAPI = typeof api
