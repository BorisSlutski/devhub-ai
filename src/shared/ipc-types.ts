/**
 * Shared IPC type contracts between main, preload, and renderer.
 * Every IPC channel's request/response shape is defined here.
 */

import { AppState, ProcessStatus, Project, WorkspaceFolder } from './types'
import { AgentInfo } from './agent-types'
import { PipelineRun, PipelineConfig } from './pipeline-types'
import { EnhancerConfig, EnhanceResult, EnhancerSessionCost } from './enhancer-types'

// ── Common result types ──

export interface IpcResult {
  success: boolean
  error?: string
}

// ── Git types ──

export interface GitInfo {
  gitBranch: string | null
  gitRemote: string | null
}

export interface GitStatus {
  branch: string | null
  baseBranch: string | null
  remote: string | null
  filesChanged: number
  insertions: number
  deletions: number
  commitsAhead: number
  uncommitted: number
  isGitRepo: boolean
}

export type GitSyncState =
  | 'synced'
  | 'behind'
  | 'ahead'
  | 'diverged'
  | 'dirty'
  | 'no-remote'
  | 'no-base'
  | 'not-git'
  | 'error'

export interface GitSyncStatus {
  isGitRepo: boolean
  baseBranch: string | null
  currentBranch: string | null
  commitsBehind: number
  commitsAhead: number
  uncommitted: number
  state: GitSyncState
  error?: string
}

export interface GitPullResult extends IpcResult {
  branch?: string | null
  behind?: number
  ahead?: number
}

export interface GitPullAllResult {
  path: string
  success: boolean
  error?: string
  branch?: string | null
}

/** Emitted when a background pull completes (per folder). */
export type GitPullFinishedEvent = GitPullAllResult

export interface GitPullBatchFinishedEvent {
  total: number
  ok: number
  failed: number
}

export interface GitPullStartResult {
  started: boolean
  count?: number
}

export interface BranchList {
  current: string | null
  branches: string[]
}

export interface WorktreeResult extends IpcResult {
  worktreePath?: string
  branchName?: string
  baseBranch?: string
}

// ── PTY types ──

export interface PtyCreateOptions {
  sessionId: string
  folderName: string
  folderPath: string
  useWorktree: boolean
  resumeClaudeId?: string
  existingWorktreePath?: string
  dangerousMode?: boolean
  model?: string
}

export interface PtyCreateResult extends IpcResult {
  id?: string
  folderName?: string
  worktreePath?: string | null
  branchName?: string | null
}

export interface PtySessionInfo {
  id: string
  folderName: string
  worktreePath: string | null
  branchName: string | null
}

// ── File types ──

export interface DirectoryEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

export interface FileContent {
  content?: string
  error?: string
}

export interface FileSearchResult {
  results: {
    file: string
    relativePath: string
    matches: { line: number; text: string }[]
  }[]
  error?: string
}

export interface FileSearchEntry {
  name: string
  path: string
  relativePath: string
  isDir: boolean
}

export interface DiffResult {
  diff?: string
  error?: string
}

// ── System ports ──

export interface SystemPortInfo {
  port: number
  pid: number
  command: string
}

// ── RTK types ──

export interface RtkStatus {
  installed: boolean
  version: string | null
  hookActive: boolean
  path: string | null
}

export interface RtkToggleResult {
  success: boolean
  output: string
}

export interface RtkGainStats {
  totalSaved: number
  totalOriginal: number
  totalCompressed: number
  savingsPercent: number
  commandCount: number
  raw: string
}

// ── Browser bridge ──

export interface BrowserEvent {
  sessionId: string
  event: string
  data: any
}

// ── Active sessions (auto-resume) ──

export interface ActiveSession {
  id: string
  claudeSessionId: string | null
  folderName: string
  folderPath: string
  worktreePath: string | null
  branchName: string | null
  dangerousMode?: boolean
  nickname?: string
  accentColor?: string
}

// ── Session history ──

export interface ClaudeSessionInfo {
  claudeSessionId: string
  folderName: string
  folderPath: string
  dirName: string
  isWorktree: boolean
  branchHint: string | null
  worktreePath: string | null
  mtime: number
  size: number
}

export interface SessionTitle {
  title: string
  keywords: string[]
  messageCount: number
}

// ── MCP & Skills ──

export interface McpConfigEntry {
  scope: string
  path: string
  servers: Record<string, any>
}

export interface McpRawFileResult {
  success: boolean
  content?: string
  exists?: boolean
  error?: string
}

export interface SkillEntry {
  name: string
  scope: string
  path: string
  description: string
}

export interface CreateCommandOptions {
  name: string
  content: string
  scope: 'user' | 'project'
  projectPath?: string
}

// ── Statusline data (from Claude Code) ──

export interface StatuslineData {
  sessionId: string
  model?: string
  modelId?: string
  contextUsedPercent?: number
  contextRemainingPercent?: number
  contextWindowSize?: number
  inputTokens?: number
  outputTokens?: number
  cacheCreationTokens?: number
  cacheReadTokens?: number
  costUsd?: number
}

// ── Scrollback persistence ──

export interface ScrollbackMeta {
  sessionId: string
  cols: number
  rows: number
  cwd: string
  createdAt: string
  lastWriteAt: string
  endedAt?: string
  totalBytes: number
}

export interface RecoverableSession {
  sessionId: string
  cwd: string
  cols: number
  rows: number
  lastWriteAt: string
  totalBytes: number
}

export interface ScrollbackRestoreResult {
  data: string // base64-encoded binary
  meta: ScrollbackMeta
}

// ── Image handling ──

export interface SaveTempImageOptions {
  name: string
  data: number[]
  sessionId: string
}

// ── Resource monitoring ──

export interface SessionMetrics {
  sessionId: string
  pid: number
  cpu: number        // percentage (sum of process tree)
  memory: number     // bytes (sum of RSS in process tree)
  processCount: number // number of processes in tree
}

export interface HostMetrics {
  totalMemory: number
  freeMemory: number
  usedMemory: number
  memoryUsagePercent: number
  cpuCores: number
  loadAverage1m: number
}

export interface ResourceSnapshot {
  timestamp: number
  sessions: SessionMetrics[]
  host: HostMetrics
}

// ── Workspace init progress ──

export type InitStage =
  | 'pending'
  | 'checking_project'
  | 'fetching'
  | 'creating_worktree'
  | 'running_setup'
  | 'spawning_pty'
  | 'waiting_shell'
  | 'ready'
  | 'cancelled'
  | 'failed'

export interface InitProgress {
  sessionId: string
  stage: InitStage
  stageIndex: number
  totalStages: number
  message: string
  startedAt: number
  error?: string
}

// ── Notification settings ──

export interface NotificationSettings {
  enabled: boolean
  quietMode: boolean
}

// ── Session presets ──

export interface SessionPreset {
  id: string
  name: string
  projectPath: string
  projectName: string
  useWorktree: boolean
  dangerousMode: boolean
  model?: string
  initialCommands?: string[]
  pinned: boolean
  icon?: string
  nickname?: string
  accentColor?: string
  claudeArgs?: string
  envVars?: Record<string, string>
  createdAt: number
  lastUsedAt?: number
  useCount: number
}

export type SessionPresetCreate = Omit<SessionPreset, 'id' | 'createdAt' | 'useCount'>

export interface PresetLaunchOptions {
  presetId: string
  sessionId: string
}

export interface PresetLaunchResult extends PtyCreateResult {
  preset?: SessionPreset
}

// ── Airflow (wix-astronomer-dags local Astro) ──

export type {
  AirflowConnection,
  AirflowDag,
  AirflowDagRun,
  AirflowTaskInstance,
  AirflowDiscoverResult,
  AirflowHealthResult,
} from './airflow-types'

// ── Session summaries ──

export interface SessionSummary {
  id: string
  title: string
  projectName: string
  projectPath: string
  claudeSessionId: string | null
  sessionPtyId: string | null
  createdAt: number
  htmlFileName: string
}

export interface SaveSummaryOptions {
  title: string
  htmlContent: string
  projectName: string
  projectPath: string
  claudeSessionId: string | null
  sessionPtyId: string | null
}

// ── Re-exports for convenience ──

export type {
  AppState,
  ProcessStatus,
  Project,
  WorkspaceFolder,
  AgentInfo,
  PipelineRun,
  PipelineConfig,
  EnhancerConfig,
  EnhanceResult,
  EnhancerSessionCost,
}
