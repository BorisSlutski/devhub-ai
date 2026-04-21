/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import {
  ScrollbackWriter, ScrollbackReader,
  setScrollbackBase, getScrollbackBase,
} from './scrollback-manager'

// Unique temp dir per test run
const TEST_ROOT = join(tmpdir(), `devhub-ai-scrollback-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
let originalBase: string

beforeEach(() => {
  originalBase = getScrollbackBase()
  setScrollbackBase(TEST_ROOT)
  mkdirSync(TEST_ROOT, { recursive: true })
})

afterEach(() => {
  setScrollbackBase(originalBase)
  try { rmSync(TEST_ROOT, { recursive: true, force: true }) } catch { /* ignore */ }
})

function sessionDir(sessionId: string): string {
  return join(TEST_ROOT, sessionId)
}

function scrollbackPath(sessionId: string): string {
  return join(sessionDir(sessionId), 'scrollback.bin')
}

function metaPath(sessionId: string): string {
  return join(sessionDir(sessionId), 'meta.json')
}

function readMeta(sessionId: string) {
  return JSON.parse(readFileSync(metaPath(sessionId), 'utf-8'))
}

describe('ScrollbackWriter', () => {
  describe('1. Append and flush to disk', () => {
    it('creates session directory and meta.json on construction', () => {
      const writer = new ScrollbackWriter('test-1', '/tmp/test', 80, 24)
      try {
        expect(existsSync(sessionDir('test-1'))).toBe(true)
        expect(existsSync(metaPath('test-1'))).toBe(true)

        const meta = readMeta('test-1')
        expect(meta.sessionId).toBe('test-1')
        expect(meta.cols).toBe(80)
        expect(meta.rows).toBe(24)
        expect(meta.cwd).toBe('/tmp/test')
        expect(meta.totalBytes).toBe(0)
        expect(meta.endedAt).toBeUndefined()
      } finally {
        writer.close()
      }
    })

    it('flushes data to scrollback.bin on close', () => {
      const writer = new ScrollbackWriter('test-2', '/tmp/test', 80, 24)
      writer.append('hello world')
      writer.append(' more data')
      writer.close()

      const binPath = scrollbackPath('test-2')
      expect(existsSync(binPath)).toBe(true)
      const content = readFileSync(binPath, 'utf-8')
      expect(content).toBe('hello world more data')
    })

    it('flushes buffer when exceeding 64KB threshold', () => {
      const writer = new ScrollbackWriter('test-3', '/tmp/test', 80, 24, {
        flushIntervalMs: 60000, // long interval so only threshold triggers
      })
      try {
        // Write more than 64KB
        const bigChunk = 'x'.repeat(65 * 1024)
        writer.append(bigChunk)

        // Data should be flushed to disk immediately
        const binPath = scrollbackPath('test-3')
        expect(existsSync(binPath)).toBe(true)
        const content = readFileSync(binPath)
        expect(content.length).toBe(bigChunk.length)
      } finally {
        writer.close()
      }
    })

    it('accepts Buffer input', () => {
      const writer = new ScrollbackWriter('test-buf', '/tmp/test', 80, 24)
      writer.append(Buffer.from([0x1b, 0x5b, 0x31, 0x6d])) // ESC[1m
      writer.close()

      const content = readFileSync(scrollbackPath('test-buf'))
      expect(content).toEqual(Buffer.from([0x1b, 0x5b, 0x31, 0x6d]))
    })
  })

  describe('2. Meta.json creation and updates', () => {
    it('getMeta returns current metadata', () => {
      const writer = new ScrollbackWriter('test-meta-1', '/work/project', 120, 40)
      try {
        const meta = writer.getMeta()
        expect(meta.sessionId).toBe('test-meta-1')
        expect(meta.cwd).toBe('/work/project')
        expect(meta.cols).toBe(120)
        expect(meta.rows).toBe(40)
        expect(meta.totalBytes).toBe(0)
        expect(meta.createdAt).toBeDefined()
        expect(meta.endedAt).toBeUndefined()
      } finally {
        writer.close()
      }
    })

    it('updateMeta persists partial updates', () => {
      const writer = new ScrollbackWriter('test-meta-2', '/work/project', 80, 24)
      writer.updateMeta({ cols: 200, rows: 50 })

      const meta = readMeta('test-meta-2')
      expect(meta.cols).toBe(200)
      expect(meta.rows).toBe(50)
      expect(meta.cwd).toBe('/work/project') // unchanged

      writer.close()
    })

    it('totalBytes tracks appended data after flush', () => {
      const writer = new ScrollbackWriter('test-meta-3', '/tmp', 80, 24)
      writer.append('12345') // 5 bytes
      writer.close()

      const meta = readMeta('test-meta-3')
      expect(meta.totalBytes).toBe(5)
    })

    it('lastWriteAt is updated on flush', () => {
      const writer = new ScrollbackWriter('test-meta-4', '/tmp', 80, 24)
      const initialMeta = readMeta('test-meta-4')
      const initialLastWrite = initialMeta.lastWriteAt

      writer.append('data')
      writer.close()

      const finalMeta = readMeta('test-meta-4')
      expect(new Date(finalMeta.lastWriteAt).getTime()).toBeGreaterThanOrEqual(
        new Date(initialLastWrite).getTime()
      )
    })
  })

  describe('3. File rotation at max size', () => {
    it('truncates file when exceeding maxSize, keeping recent half', () => {
      const maxSize = 1024 // 1KB for testing
      const writer = new ScrollbackWriter('test-rotate', '/tmp', 80, 24, {
        maxSizeBytes: maxSize,
        flushIntervalMs: 60000,
      })

      // Write enough to trigger rotation
      const chunk1 = 'A'.repeat(600)
      const chunk2 = 'B'.repeat(600)
      writer.append(chunk1)
      writer.append(chunk2)

      // Force flush by closing
      writer.close()

      const content = readFileSync(scrollbackPath('test-rotate'), 'utf-8')
      // File should be truncated — second half of original content
      expect(content.length).toBeLessThanOrEqual(maxSize)
      // Should contain some 'B' characters (recent data)
      expect(content).toContain('B')

      const meta = readMeta('test-rotate')
      expect(meta.totalBytes).toBeLessThanOrEqual(maxSize)
    })
  })

  describe('4. canRestore detection', () => {
    it('returns true for session without endedAt', () => {
      const writer = new ScrollbackWriter('test-can-restore', '/tmp', 80, 24)
      writer.append('data')
      writer.dispose() // does NOT set endedAt

      expect(ScrollbackReader.canRestore('test-can-restore')).toBe(true)
    })

    it('returns false for session with endedAt (cleanly closed)', () => {
      const writer = new ScrollbackWriter('test-no-restore', '/tmp', 80, 24)
      writer.append('data')
      writer.close() // sets endedAt

      expect(ScrollbackReader.canRestore('test-no-restore')).toBe(false)
    })

    it('returns false for non-existent session', () => {
      expect(ScrollbackReader.canRestore('nonexistent')).toBe(false)
    })
  })

  describe('5. listRecoverable', () => {
    it('returns sessions without endedAt', () => {
      // Create a recoverable session (dispose without endedAt)
      const w1 = new ScrollbackWriter('recoverable-1', '/proj/a', 80, 24)
      w1.append('data1')
      w1.dispose()

      // Create a closed session (not recoverable)
      const w2 = new ScrollbackWriter('closed-1', '/proj/b', 80, 24)
      w2.append('data2')
      w2.close()

      // Create another recoverable
      const w3 = new ScrollbackWriter('recoverable-2', '/proj/c', 100, 30)
      w3.append('data3')
      w3.dispose()

      const list = ScrollbackReader.listRecoverable()
      expect(list).toHaveLength(2)

      const ids = list.map(s => s.sessionId)
      expect(ids).toContain('recoverable-1')
      expect(ids).toContain('recoverable-2')
      expect(ids).not.toContain('closed-1')
    })

    it('returns empty array when no scrollback exists', () => {
      const list = ScrollbackReader.listRecoverable()
      expect(list).toEqual([])
    })

    it('includes correct metadata in results', () => {
      const w = new ScrollbackWriter('meta-check', '/my/project', 120, 40)
      w.append('hello')
      w.dispose()

      const list = ScrollbackReader.listRecoverable()
      const session = list.find(s => s.sessionId === 'meta-check')
      expect(session).toBeDefined()
      expect(session!.cwd).toBe('/my/project')
      expect(session!.cols).toBe(120)
      expect(session!.rows).toBe(40)
      expect(session!.totalBytes).toBe(5)
    })
  })

  describe('6. readScrollback', () => {
    it('returns buffer data and meta', () => {
      const writer = new ScrollbackWriter('read-test', '/tmp', 80, 24)
      writer.append('terminal output here')
      writer.dispose()

      const { data, meta } = ScrollbackReader.readScrollback('read-test')
      expect(data.toString('utf-8')).toBe('terminal output here')
      expect(meta.sessionId).toBe('read-test')
      expect(meta.totalBytes).toBe(20)
    })
  })

  describe('7. cleanup and cleanupOld', () => {
    it('cleanup removes session directory', () => {
      const writer = new ScrollbackWriter('cleanup-test', '/tmp', 80, 24)
      writer.append('data')
      writer.close()

      expect(existsSync(sessionDir('cleanup-test'))).toBe(true)
      ScrollbackReader.cleanup('cleanup-test')
      expect(existsSync(sessionDir('cleanup-test'))).toBe(false)
    })

    it('cleanup does nothing for non-existent session', () => {
      expect(() => ScrollbackReader.cleanup('nonexistent')).not.toThrow()
    })

    it('cleanupOld removes sessions older than N days', () => {
      // Create a session with old lastWriteAt
      const oldSessionId = 'old-session'
      const dir = sessionDir(oldSessionId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'scrollback.bin'), 'old data')
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        sessionId: oldSessionId,
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        createdAt: '2020-01-01T00:00:00Z',
        lastWriteAt: '2020-01-01T00:00:00Z',
        totalBytes: 8,
      }))

      // Create a recent session
      const recentWriter = new ScrollbackWriter('recent-session', '/tmp', 80, 24)
      recentWriter.append('recent data')
      recentWriter.close()

      expect(existsSync(sessionDir(oldSessionId))).toBe(true)
      expect(existsSync(sessionDir('recent-session'))).toBe(true)

      ScrollbackReader.cleanupOld(1) // older than 1 day

      expect(existsSync(sessionDir(oldSessionId))).toBe(false)
      expect(existsSync(sessionDir('recent-session'))).toBe(true)
    })

    it('cleanupOld removes orphan directories without meta.json', () => {
      const orphanDir = sessionDir('orphan')
      mkdirSync(orphanDir, { recursive: true })
      writeFileSync(join(orphanDir, 'scrollback.bin'), 'orphan data')
      // No meta.json

      ScrollbackReader.cleanupOld(1)
      expect(existsSync(orphanDir)).toBe(false)
    })
  })

  describe('8. Concurrent writes', () => {
    it('multiple rapid appends accumulate correctly', () => {
      const writer = new ScrollbackWriter('concurrent', '/tmp', 80, 24, {
        flushIntervalMs: 60000, // long interval
      })

      for (let i = 0; i < 100; i++) {
        writer.append(`line-${i}\n`)
      }
      writer.close()

      const content = readFileSync(scrollbackPath('concurrent'), 'utf-8')
      for (let i = 0; i < 100; i++) {
        expect(content).toContain(`line-${i}\n`)
      }
    })
  })

  describe('9. dispose vs close behavior', () => {
    it('close() sets endedAt in meta', () => {
      const writer = new ScrollbackWriter('close-test', '/tmp', 80, 24)
      writer.append('data')
      writer.close()

      const meta = readMeta('close-test')
      expect(meta.endedAt).toBeDefined()
      expect(typeof meta.endedAt).toBe('string')
    })

    it('dispose() does NOT set endedAt in meta', () => {
      const writer = new ScrollbackWriter('dispose-test', '/tmp', 80, 24)
      writer.append('data')
      writer.dispose()

      const meta = readMeta('dispose-test')
      expect(meta.endedAt).toBeUndefined()
    })

    it('both close() and dispose() flush remaining buffer', () => {
      const w1 = new ScrollbackWriter('flush-close', '/tmp', 80, 24, {
        flushIntervalMs: 60000,
      })
      w1.append('close-data')
      w1.close()
      expect(readFileSync(scrollbackPath('flush-close'), 'utf-8')).toBe('close-data')

      const w2 = new ScrollbackWriter('flush-dispose', '/tmp', 80, 24, {
        flushIntervalMs: 60000,
      })
      w2.append('dispose-data')
      w2.dispose()
      expect(readFileSync(scrollbackPath('flush-dispose'), 'utf-8')).toBe('dispose-data')
    })

    it('append() is no-op after close()', () => {
      const writer = new ScrollbackWriter('noop-after-close', '/tmp', 80, 24)
      writer.append('before')
      writer.close()
      writer.append('after') // should be ignored

      const content = readFileSync(scrollbackPath('noop-after-close'), 'utf-8')
      expect(content).toBe('before')
    })

    it('append() is no-op after dispose()', () => {
      const writer = new ScrollbackWriter('noop-after-dispose', '/tmp', 80, 24)
      writer.append('before')
      writer.dispose()
      writer.append('after') // should be ignored

      const content = readFileSync(scrollbackPath('noop-after-dispose'), 'utf-8')
      expect(content).toBe('before')
    })

    it('updateMeta() is no-op after close()', () => {
      const writer = new ScrollbackWriter('meta-after-close', '/tmp', 80, 24)
      writer.close()
      writer.updateMeta({ cols: 200 })

      const meta = readMeta('meta-after-close')
      expect(meta.cols).toBe(80) // unchanged
    })
  })

  describe('10. Resilience', () => {
    it('writer handles missing scrollback.bin gracefully for readScrollback', () => {
      // Create meta but no bin
      const sid = 'no-bin'
      const dir = sessionDir(sid)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        sessionId: sid,
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        createdAt: new Date().toISOString(),
        lastWriteAt: new Date().toISOString(),
        totalBytes: 0,
      }))

      const { data, meta } = ScrollbackReader.readScrollback(sid)
      expect(data.length).toBe(0)
      expect(meta.sessionId).toBe(sid)
    })

    it('listRecoverable skips sessions with missing scrollback.bin', () => {
      const sid = 'meta-only'
      const dir = sessionDir(sid)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({
        sessionId: sid,
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        createdAt: new Date().toISOString(),
        lastWriteAt: new Date().toISOString(),
        totalBytes: 0,
      }))

      const list = ScrollbackReader.listRecoverable()
      expect(list.find(s => s.sessionId === sid)).toBeUndefined()
    })

    it('meta.json is written atomically (via tmp + rename)', () => {
      const writer = new ScrollbackWriter('atomic-test', '/tmp', 80, 24)
      writer.append('data')
      writer.close()

      // .tmp file should not exist after write
      const tmpPath = join(sessionDir('atomic-test'), 'meta.json.tmp')
      expect(existsSync(tmpPath)).toBe(false)
      // meta.json should exist and be valid JSON
      expect(() => readMeta('atomic-test')).not.toThrow()
    })
  })
})
