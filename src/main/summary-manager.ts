import { join } from 'path'
import { homedir } from 'os'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, unlinkSync, statSync
} from 'fs'

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

const BASE_DIR = join(homedir(), '.devhub-ai', 'summaries')
const INDEX_FILE = join(BASE_DIR, 'index.json')

class SummaryManager {
  private summaries: SessionSummary[] = []
  private loaded = false

  private ensureDir() {
    mkdirSync(BASE_DIR, { recursive: true })
  }

  private load() {
    if (this.loaded) return
    this.ensureDir()
    try {
      if (existsSync(INDEX_FILE)) {
        this.summaries = JSON.parse(readFileSync(INDEX_FILE, 'utf-8'))
      }
    } catch {
      this.summaries = []
    }
    this.loaded = true
  }

  private save() {
    this.ensureDir()
    writeFileSync(INDEX_FILE, JSON.stringify(this.summaries, null, 2), 'utf-8')
  }

  saveSummary(opts: SaveSummaryOptions): SessionSummary {
    this.load()

    const id = `summary-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    const htmlFileName = `${id}.html`
    const htmlPath = join(BASE_DIR, htmlFileName)

    this.ensureDir()
    writeFileSync(htmlPath, opts.htmlContent, 'utf-8')

    const summary: SessionSummary = {
      id,
      title: opts.title,
      projectName: opts.projectName,
      projectPath: opts.projectPath,
      claudeSessionId: opts.claudeSessionId,
      sessionPtyId: opts.sessionPtyId,
      createdAt: Date.now(),
      htmlFileName,
    }

    this.summaries.unshift(summary)
    this.save()
    return summary
  }

  saveFromFile(
    filePath: string,
    title: string,
    projectName: string,
    projectPath: string,
    claudeSessionId: string | null,
    sessionPtyId: string | null,
  ): SessionSummary | null {
    if (!existsSync(filePath)) return null
    try {
      const htmlContent = readFileSync(filePath, 'utf-8')
      return this.saveSummary({
        title,
        htmlContent,
        projectName,
        projectPath,
        claudeSessionId,
        sessionPtyId,
      })
    } catch {
      return null
    }
  }

  list(projectName?: string): SessionSummary[] {
    this.load()
    if (projectName) {
      return this.summaries.filter(s => s.projectName === projectName)
    }
    return [...this.summaries]
  }

  get(id: string): { summary: SessionSummary; html: string } | null {
    this.load()
    const summary = this.summaries.find(s => s.id === id)
    if (!summary) return null
    const htmlPath = join(BASE_DIR, summary.htmlFileName)
    if (!existsSync(htmlPath)) return null
    try {
      const html = readFileSync(htmlPath, 'utf-8')
      return { summary, html }
    } catch {
      return null
    }
  }

  getHtmlPath(id: string): string | null {
    this.load()
    const summary = this.summaries.find(s => s.id === id)
    if (!summary) return null
    const htmlPath = join(BASE_DIR, summary.htmlFileName)
    return existsSync(htmlPath) ? htmlPath : null
  }

  delete(id: string): boolean {
    this.load()
    const idx = this.summaries.findIndex(s => s.id === id)
    if (idx < 0) return false

    const summary = this.summaries[idx]
    const htmlPath = join(BASE_DIR, summary.htmlFileName)
    try { if (existsSync(htmlPath)) unlinkSync(htmlPath) } catch { /* ok */ }

    this.summaries.splice(idx, 1)
    this.save()
    return true
  }

  getBaseDir(): string {
    return BASE_DIR
  }
}

export const summaryManager = new SummaryManager()
