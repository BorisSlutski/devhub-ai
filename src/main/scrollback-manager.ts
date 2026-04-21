import { join } from 'path'
import { homedir } from 'os'
import {
  existsSync, mkdirSync, writeFileSync, readFileSync,
  readdirSync, rmSync, renameSync,
  appendFileSync, openSync, closeSync, fstatSync, readSync,
} from 'fs'

// ── Types ──

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

export interface ScrollbackWriterOptions {
  maxSizeBytes?: number
  flushIntervalMs?: number
}

// ── Constants ──

const DEFAULT_MAX_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_FLUSH_INTERVAL = 1000 // 1s
const BUFFER_FLUSH_THRESHOLD = 64 * 1024 // 64KB

/** Override in tests via setScrollbackBase() */
let scrollbackBase = join(homedir(), '.devhub-ai', 'scrollback')

/** Set a custom base directory (for tests). */
export function setScrollbackBase(dir: string): void {
  scrollbackBase = dir
}

/** Get the current base directory. */
export function getScrollbackBase(): string {
  return scrollbackBase
}

function sessionDir(sessionId: string): string {
  return join(scrollbackBase, sessionId)
}

function scrollbackPath(sessionId: string): string {
  return join(sessionDir(sessionId), 'scrollback.bin')
}

function metaPath(sessionId: string): string {
  return join(sessionDir(sessionId), 'meta.json')
}

// ── ScrollbackWriter ──

export class ScrollbackWriter {
  private sessionId: string
  private maxSizeBytes: number
  private flushIntervalMs: number
  private buffer: Buffer[] = []
  private bufferSize = 0
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private meta: ScrollbackMeta
  private closed = false

  constructor(sessionId: string, cwd: string, cols: number, rows: number, options?: ScrollbackWriterOptions) {
    this.sessionId = sessionId
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE
    this.flushIntervalMs = options?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL

    this.meta = {
      sessionId,
      cols,
      rows,
      cwd,
      createdAt: new Date().toISOString(),
      lastWriteAt: new Date().toISOString(),
      totalBytes: 0,
    }

    try {
      mkdirSync(sessionDir(sessionId), { recursive: true })
      this.writeMetaAtomic()
    } catch (err) {
      console.error(`[ScrollbackWriter] Failed to init directory for ${sessionId}:`, err)
    }

    this.flushTimer = setInterval(() => {
      this.flush()
    }, this.flushIntervalMs)
  }

  append(data: Buffer | string): void {
    if (this.closed) return

    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
    this.buffer.push(chunk)
    this.bufferSize += chunk.length

    if (this.bufferSize >= BUFFER_FLUSH_THRESHOLD) {
      this.flush()
    }
  }

  getMeta(): ScrollbackMeta {
    return { ...this.meta }
  }

  updateMeta(partial: Partial<ScrollbackMeta>): void {
    if (this.closed) return
    Object.assign(this.meta, partial)
    try {
      this.writeMetaAtomic()
    } catch (err) {
      console.error(`[ScrollbackWriter] Failed to update meta for ${this.sessionId}:`, err)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    this.flush()

    this.meta.endedAt = new Date().toISOString()
    try {
      this.writeMetaAtomic()
    } catch (err) {
      console.error(`[ScrollbackWriter] Failed to write final meta for ${this.sessionId}:`, err)
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true

    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }

    // Flush remaining buffer but do NOT set endedAt — allows crash recovery detection
    this.flush()

    try {
      this.writeMetaAtomic()
    } catch (err) {
      console.error(`[ScrollbackWriter] Failed to write meta on dispose for ${this.sessionId}:`, err)
    }
  }

  // ── Private helpers ──

  private flush(): void {
    if (this.buffer.length === 0) return

    const combined = Buffer.concat(this.buffer)
    this.buffer = []
    this.bufferSize = 0

    const binPath = scrollbackPath(this.sessionId)

    try {
      appendFileSync(binPath, combined)
      this.meta.totalBytes += combined.length
      this.meta.lastWriteAt = new Date().toISOString()

      // Check if rotation is needed
      if (this.meta.totalBytes > this.maxSizeBytes) {
        this.rotate(binPath)
      }

      this.writeMetaAtomic()
    } catch (err) {
      console.error(`[ScrollbackWriter] Flush failed for ${this.sessionId}:`, err)
    }
  }

  private rotate(binPath: string): void {
    try {
      const fd = openSync(binPath, 'r')
      try {
        const stat = fstatSync(fd)
        const fileSize = stat.size
        if (fileSize <= this.maxSizeBytes) return

        // Keep the second half of the file
        const keepOffset = Math.floor(fileSize / 2)
        const keepSize = fileSize - keepOffset
        const keepBuffer = Buffer.alloc(keepSize)
        readSync(fd, keepBuffer, 0, keepSize, keepOffset)
        closeSync(fd)

        // Rewrite file with only the kept portion
        writeFileSync(binPath, keepBuffer)
        this.meta.totalBytes = keepSize
      } catch (innerErr) {
        try { closeSync(fd) } catch { /* ignore */ }
        throw innerErr
      }
    } catch (err) {
      console.error(`[ScrollbackWriter] Rotation failed for ${this.sessionId}:`, err)
    }
  }

  private writeMetaAtomic(): void {
    const dir = sessionDir(this.sessionId)
    const finalPath = metaPath(this.sessionId)
    const tmpPath = join(dir, 'meta.json.tmp')

    writeFileSync(tmpPath, JSON.stringify(this.meta, null, 2), 'utf-8')
    renameSync(tmpPath, finalPath)
  }
}

// ── ScrollbackReader ──

export class ScrollbackReader {
  static canRestore(sessionId: string): boolean {
    const mPath = metaPath(sessionId)
    if (!existsSync(mPath)) return false

    try {
      const meta: ScrollbackMeta = JSON.parse(readFileSync(mPath, 'utf-8'))
      // Restorable if endedAt is not set (unclean shutdown)
      return !meta.endedAt
    } catch {
      return false
    }
  }

  static listRecoverable(): RecoverableSession[] {
    if (!existsSync(scrollbackBase)) return []

    const results: RecoverableSession[] = []

    try {
      const dirs = readdirSync(scrollbackBase)
      for (const dir of dirs) {
        const mPath = metaPath(dir)
        if (!existsSync(mPath)) continue

        try {
          const meta: ScrollbackMeta = JSON.parse(readFileSync(mPath, 'utf-8'))
          if (meta.endedAt) continue // cleanly closed

          // Verify scrollback.bin exists
          if (!existsSync(scrollbackPath(dir))) continue

          results.push({
            sessionId: meta.sessionId,
            cwd: meta.cwd,
            cols: meta.cols,
            rows: meta.rows,
            lastWriteAt: meta.lastWriteAt,
            totalBytes: meta.totalBytes,
          })
        } catch { /* skip unreadable meta */ }
      }
    } catch { /* base dir not readable */ }

    return results.sort((a, b) =>
      new Date(b.lastWriteAt).getTime() - new Date(a.lastWriteAt).getTime()
    )
  }

  static readScrollback(sessionId: string): { data: Buffer; meta: ScrollbackMeta } {
    const mPath = metaPath(sessionId)
    const bPath = scrollbackPath(sessionId)

    const meta: ScrollbackMeta = JSON.parse(readFileSync(mPath, 'utf-8'))
    const data = existsSync(bPath) ? readFileSync(bPath) : Buffer.alloc(0)

    return { data, meta }
  }

  static cleanup(sessionId: string): void {
    const dir = sessionDir(sessionId)
    if (!existsSync(dir)) return

    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.error(`[ScrollbackReader] Cleanup failed for ${sessionId}:`, err)
    }
  }

  static cleanupOld(maxAgeDays: number): void {
    if (!existsSync(scrollbackBase)) return

    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000

    try {
      const dirs = readdirSync(scrollbackBase)
      for (const dir of dirs) {
        const mPath = metaPath(dir)
        if (!existsSync(mPath)) {
          // No meta — remove orphan directory
          try { rmSync(sessionDir(dir), { recursive: true, force: true }) } catch { /* ignore */ }
          continue
        }

        try {
          const meta: ScrollbackMeta = JSON.parse(readFileSync(mPath, 'utf-8'))
          const lastWrite = new Date(meta.lastWriteAt).getTime()
          if (lastWrite < cutoff) {
            rmSync(sessionDir(dir), { recursive: true, force: true })
          }
        } catch {
          // Unreadable meta — skip (don't delete in case it's recent)
        }
      }
    } catch { /* base dir not readable */ }
  }
}
