import { join, basename } from 'path'
import { homedir } from 'os'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs'
import type { GridLayout, SessionUiState } from '../shared/session-ui'
import { DEFAULT_SESSION_UI } from '../shared/session-ui'

// ── Active session tracking (for auto-resume on restart) ──

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

const DEVHUB_AI_DIR = join(homedir(), '.devhub-ai')
const ACTIVE_FILE = join(DEVHUB_AI_DIR, 'active-sessions.json')

interface ActiveSessionsFile {
  sessions: ActiveSession[]
  activeId?: string | null
  sessionOrder?: string[]
  gridMode?: boolean
  gridLayout?: GridLayout
  gridSessionIds?: string[]
}

class ActiveSessionStore {
  private sessions: ActiveSession[] = []
  private activeId: string | null = null
  private sessionOrder: string[] = []
  private gridMode = false
  private gridLayout: GridLayout = '1x1'
  private gridSessionIds: string[] = []

  private load() {
    try {
      if (existsSync(ACTIVE_FILE)) {
        const raw = JSON.parse(readFileSync(ACTIVE_FILE, 'utf-8'))
        // Support legacy format (bare array) and new format ({ sessions, activeId })
        if (Array.isArray(raw)) {
          this.sessions = raw
          this.activeId = null
          this.sessionOrder = raw.map((s: ActiveSession) => s.id)
        } else {
          const parsed = raw as ActiveSessionsFile
          this.sessions = parsed.sessions || []
          this.activeId = parsed.activeId ?? null
          this.sessionOrder = parsed.sessionOrder ?? this.sessions.map(s => s.id)
          this.gridMode = parsed.gridMode ?? false
          this.gridLayout = parsed.gridLayout ?? '1x1'
          this.gridSessionIds = parsed.gridSessionIds ?? []
        }
      }
    } catch {
      this.sessions = []
      this.activeId = null
      this.sessionOrder = []
      this.gridMode = false
      this.gridLayout = '1x1'
      this.gridSessionIds = []
    }
  }

  private save() {
    try {
      mkdirSync(DEVHUB_AI_DIR, { recursive: true })
      const payload: ActiveSessionsFile = {
        sessions: this.sessions,
        activeId: this.activeId,
        sessionOrder: this.sessionOrder,
        gridMode: this.gridMode,
        gridLayout: this.gridLayout,
        gridSessionIds: this.gridSessionIds,
      }
      writeFileSync(ACTIVE_FILE, JSON.stringify(payload, null, 2), 'utf-8')
    } catch (err) {
      console.error('[ActiveSessions] save failed:', err)
    }
  }

  set(session: ActiveSession) {
    this.load()
    const idx = this.sessions.findIndex(s => s.id === session.id)
    if (idx >= 0) this.sessions[idx] = session
    else this.sessions.push(session)
    this.save()
  }

  updateClaudeId(id: string, claudeSessionId: string) {
    this.load()
    const s = this.sessions.find(r => r.id === id)
    if (s) { s.claudeSessionId = claudeSessionId; this.save() }
  }

  updateMeta(id: string, meta: { nickname?: string; accentColor?: string }) {
    this.load()
    const s = this.sessions.find(r => r.id === id)
    if (!s) return
    if (meta.nickname !== undefined) s.nickname = meta.nickname
    if (meta.accentColor !== undefined) s.accentColor = meta.accentColor
    this.save()
  }

  setSessionOrder(order: string[]) {
    this.load()
    this.sessionOrder = order
    this.save()
  }

  getSessionOrder(): string[] {
    this.load()
    return [...this.sessionOrder]
  }

  getUiState(): SessionUiState {
    this.load()
    return {
      sessionOrder: [...this.sessionOrder],
      gridMode: this.gridMode,
      gridLayout: this.gridLayout,
      gridSessionIds: [...this.gridSessionIds],
    }
  }

  setUiState(partial: Partial<SessionUiState>) {
    this.load()
    if (partial.sessionOrder !== undefined) this.sessionOrder = partial.sessionOrder
    if (partial.gridMode !== undefined) this.gridMode = partial.gridMode
    if (partial.gridLayout !== undefined) this.gridLayout = partial.gridLayout
    if (partial.gridSessionIds !== undefined) this.gridSessionIds = partial.gridSessionIds
    this.save()
  }

  remove(id: string) {
    this.load()
    this.sessions = this.sessions.filter(s => s.id !== id)
    this.sessionOrder = this.sessionOrder.filter(sid => sid !== id)
    this.gridSessionIds = this.gridSessionIds.filter(sid => sid !== id)
    if (this.activeId === id) this.activeId = null
    this.save()
  }

  getAll(): ActiveSession[] {
    this.load()
    return [...this.sessions]
  }

  setActiveId(id: string | null) {
    this.load()
    this.activeId = id
    this.save()
  }

  getActiveId(): string | null {
    this.load()
    return this.activeId
  }

  clear() {
    this.sessions = []
    this.activeId = null
    this.save()
  }
}

export const activeSessions = new ActiveSessionStore()

// ── Claude session history (scan Claude's own files) ──

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

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')

/**
 * Claude encodes CWD paths: replace / with -, replace . with -
 * e.g. /Users/shayk/.dev3.0/worktrees/foo → -Users-shayk--dev3-0-worktrees-foo
 */
function encodePath(p: string): string {
  return p.replace(/\//g, '-').replace(/\./g, '-')
}

/**
 * Build a lookup map: encoded-dir-name → real filesystem path
 * by scanning known worktree base directories.
 */
function buildWorktreePathMap(): Map<string, string> {
  const map = new Map<string, string>()
  const home = homedir()
  const baseDirs = [
    join(home, '.devhub-ai', 'worktrees'),
    join(home, '.dev3.0', 'worktrees'),
  ]

  for (const base of baseDirs) {
    if (!existsSync(base)) continue
    try {
      for (const slug of readdirSync(base)) {
        const slugDir = join(base, slug)
        try { if (!statSync(slugDir).isDirectory()) continue } catch { continue }
        for (const ts of readdirSync(slugDir)) {
          const wtDir = join(slugDir, ts, 'worktree')
          if (existsSync(wtDir)) {
            map.set(encodePath(wtDir), wtDir)
          }
          // Also check if the ts dir itself is a worktree (no nested /worktree)
          const tsDir = join(slugDir, ts)
          try {
            if (statSync(tsDir).isDirectory()) {
              map.set(encodePath(tsDir), tsDir)
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }
  return map
}

export function scanProjectSessions(folderPath: string, folderName: string): ClaudeSessionInfo[] {
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return []

  const encodedMainPath = encodePath(folderPath)
  const slug = basename(folderPath).toLowerCase()

  // Build worktree lookup once per scan
  const wtMap = buildWorktreePathMap()

  const results: ClaudeSessionInfo[] = []
  const seen = new Set<string>()

  try {
    const allDirs = readdirSync(CLAUDE_PROJECTS_DIR)

    for (const dirName of allDirs) {
      const isMainPath = dirName === encodedMainPath
      const isWorktree = !isMainPath &&
        dirName.toLowerCase().includes('worktrees') &&
        dirName.toLowerCase().includes(slug)

      if (!isMainPath && !isWorktree) continue

      const projDir = join(CLAUDE_PROJECTS_DIR, dirName)
      try {
        if (!statSync(projDir).isDirectory()) continue
      } catch { continue }

      try {
        const files = readdirSync(projDir).filter(f => f.endsWith('.jsonl'))
        for (const f of files) {
          const sessionId = f.replace('.jsonl', '')
          if (seen.has(sessionId)) continue
          seen.add(sessionId)

          try {
            const fileStat = statSync(join(projDir, f))

            let branchHint: string | null = null
            let worktreePath: string | null = null
            if (isWorktree) {
              const wtIdx = dirName.toLowerCase().indexOf('worktrees-')
              if (wtIdx >= 0) {
                branchHint = dirName.slice(wtIdx + 'worktrees-'.length).replace(/-worktree$/, '')
              }
              worktreePath = wtMap.get(dirName) || null
            }

            results.push({
              claudeSessionId: sessionId,
              folderName,
              folderPath,
              dirName,
              isWorktree,
              branchHint,
              worktreePath,
              mtime: fileStat.mtime.getTime(),
              size: fileStat.size,
            })
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch { /* projects dir not readable */ }

  return results.sort((a, b) => b.mtime - a.mtime)
}

export interface SessionTitleInfo {
  title: string
  keywords: string[]
  messageCount: number
}

/** Extract text from a Claude Code JSONL message entry */
function extractText(entry: any): string {
  const msg = entry.message
  if (!msg) return ''

  if (typeof msg === 'string') return msg
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    for (const item of content) {
      if (typeof item === 'string') return item
      if (item?.type === 'text' && item.text) return item.text
    }
  }
  return ''
}

/** Check if text is a system/command message (not real user input) */
function isSystemMessage(text: string): boolean {
  const t = text.trim()
  return t.startsWith('<local-command') ||
    t.startsWith('<command-') ||
    t.startsWith('<local-') ||
    t.startsWith('Unknown skill:') ||
    t.length < 3
}

/**
 * Extract title, keywords, and message count from a Claude session file.
 * Reads the first real user messages and key assistant summaries.
 */
export function getSessionTitle(claudeSessionId: string, dirName: string): SessionTitleInfo | null {
  const filePath = join(CLAUDE_PROJECTS_DIR, dirName, `${claudeSessionId}.jsonl`)
  if (!existsSync(filePath)) return null

  try {
    const raw = readFileSync(filePath, 'utf-8')
    const lines = raw.split('\n').filter(Boolean)

    const userMessages: string[] = []
    let totalUserMsgs = 0
    let firstAssistantText = ''

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.type === 'user' || entry.type === 'human') {
          totalUserMsgs++
          const text = extractText(entry)
          if (text && !isSystemMessage(text) && userMessages.length < 5) {
            userMessages.push(text.trim())
          }
        }
        if ((entry.type === 'assistant') && !firstAssistantText) {
          const text = extractText(entry)
          if (text && text.length > 20) firstAssistantText = text.trim()
        }
      } catch { continue }
    }

    if (userMessages.length === 0) {
      return { title: `Session (${totalUserMsgs} messages)`, keywords: [], messageCount: totalUserMsgs }
    }

    // Title from first real user message (clean and truncate)
    let title = userMessages[0]
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (title.length > 80) title = title.slice(0, 77) + '...'

    // Extract keywords from all user messages
    const allText = userMessages.join(' ') + ' ' + firstAssistantText
    const keywords = extractKeywords(allText)

    return { title, keywords, messageCount: totalUserMsgs }
  } catch { /* unreadable */ }
  return null
}

/** Extract meaningful keywords from session text */
function extractKeywords(text: string): string[] {
  const words = new Set<string>()
  const lower = text.toLowerCase()

  // File patterns (*.ts, *.tsx, etc.)
  const fileMatches = text.match(/[\w-]+\.\w{1,5}/g) || []
  for (const f of fileMatches) {
    if (!f.match(/^\d/) && f.length > 3) words.add(f)
  }

  // Technical terms: CamelCase, UPPER_CASE, kebab-case identifiers
  const identifiers = text.match(/\b[A-Z][a-zA-Z]{5,}\b/g) || []
  for (const id of identifiers.slice(0, 5)) words.add(id)

  // Common action words
  const actions = ['fix', 'add', 'create', 'update', 'remove', 'refactor', 'implement', 'debug',
    'test', 'deploy', 'migrate', 'optimize', 'review', 'investigate', 'build', 'configure']
  for (const a of actions) {
    if (lower.includes(a)) words.add(a)
  }

  // Domain terms from the text (3+ letter words that appear meaningful)
  const domainTerms = text.match(/\b[a-z][a-z-]{3,20}\b/g) || []
  const stopWords = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'been', 'about',
    'what', 'when', 'where', 'which', 'there', 'their', 'would', 'could', 'should', 'also',
    'just', 'like', 'make', 'some', 'more', 'than', 'them', 'then', 'into', 'only', 'very',
    'each', 'much', 'your', 'does', 'these', 'other', 'after', 'before', 'please', 'need',
    'want', 'look', 'sure', 'here', 'code', 'file', 'line', 'text', 'help', 'know'])
  for (const t of domainTerms) {
    if (!stopWords.has(t) && t.length > 3) words.add(t)
  }

  return [...words].slice(0, 8)
}
