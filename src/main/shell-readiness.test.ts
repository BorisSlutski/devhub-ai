/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createReadinessGate, READINESS_MARKER, READINESS_COMMAND } from './shell-readiness'

describe('shell-readiness', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('READINESS_MARKER constant', () => {
    it('is the expected OSC 777 escape sequence', () => {
      expect(READINESS_MARKER).toBe('\x1b]777;devhub-ai-shell-ready\x07')
    })
  })

  describe('READINESS_COMMAND constant', () => {
    it('is a printf command that emits the marker', () => {
      expect(READINESS_COMMAND).toContain('printf')
      expect(READINESS_COMMAND).toContain('777;devhub-ai-shell-ready')
      expect(READINESS_COMMAND.endsWith('\n')).toBe(true)
    })
  })

  describe('marker detection', () => {
    it('detects the marker in a data chunk and resolves waitForReady', async () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      let resolved = false
      gate.waitForReady().then(() => { resolved = true })

      // Feed data containing the marker
      gate.onData(`some shell output${READINESS_MARKER}`)

      // Flush microtasks
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(true)

      gate.dispose()
    })

    it('detects the marker embedded in mixed data', async () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      const result = gate.onData(`before${READINESS_MARKER}after`)
      expect(result).toBe('beforeafter')

      gate.dispose()
    })

    it('returns data unchanged when no marker is present', () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      const data = 'normal shell output\r\nprompt$ '
      const result = gate.onData(data)
      expect(result).toBe(data)

      gate.dispose()
    })
  })

  describe('marker stripping', () => {
    it('strips the marker when it appears alone in a chunk', () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      const result = gate.onData(READINESS_MARKER)
      expect(result).toBe('')

      gate.dispose()
    })

    it('strips the marker from the beginning of a chunk', () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      const result = gate.onData(`${READINESS_MARKER}prompt$ `)
      expect(result).toBe('prompt$ ')

      gate.dispose()
    })

    it('strips the marker from the end of a chunk', () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      const result = gate.onData(`shell init done\r\n${READINESS_MARKER}`)
      expect(result).toBe('shell init done\r\n')

      gate.dispose()
    })

    it('passes data through unchanged after marker has been detected', () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      // First chunk with marker
      gate.onData(READINESS_MARKER)

      // Subsequent chunks pass through unchanged
      const result = gate.onData('subsequent data')
      expect(result).toBe('subsequent data')

      gate.dispose()
    })
  })

  describe('timeout fallback', () => {
    it('resolves waitForReady after timeout if marker never arrives', async () => {
      const writeFn = vi.fn()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const gate = createReadinessGate('test-session', writeFn, 5000)

      let resolved = false
      gate.waitForReady().then(() => { resolved = true })

      // Not resolved before timeout
      await vi.advanceTimersByTimeAsync(4999)
      expect(resolved).toBe(false)

      // Resolved after timeout
      await vi.advanceTimersByTimeAsync(1)
      expect(resolved).toBe(true)

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Timeout after 5000ms')
      )

      warnSpy.mockRestore()
      gate.dispose()
    })

    it('does not warn when marker arrives before timeout', async () => {
      const writeFn = vi.fn()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const gate = createReadinessGate('test-session', writeFn, 5000)

      // Marker arrives quickly
      gate.onData(READINESS_MARKER)

      // Advance past the timeout
      await vi.advanceTimersByTimeAsync(6000)
      expect(warnSpy).not.toHaveBeenCalled()

      warnSpy.mockRestore()
      gate.dispose()
    })
  })

  describe('input buffering', () => {
    it('buffers input before shell is ready and flushes on ready', async () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      // Buffer some input before ready
      gate.bufferInput('keystroke1')
      gate.bufferInput('keystroke2')
      expect(writeFn).not.toHaveBeenCalled()

      // Trigger readiness
      gate.onData(READINESS_MARKER)

      // Buffered input should have been flushed
      expect(writeFn).toHaveBeenCalledTimes(2)
      expect(writeFn).toHaveBeenNthCalledWith(1, 'keystroke1')
      expect(writeFn).toHaveBeenNthCalledWith(2, 'keystroke2')

      gate.dispose()
    })

    it('passes input directly to writeFn after shell is ready', () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      // Trigger readiness first
      gate.onData(READINESS_MARKER)
      writeFn.mockClear()

      // Input after ready goes straight through
      gate.bufferInput('direct input')
      expect(writeFn).toHaveBeenCalledWith('direct input')

      gate.dispose()
    })

    it('flushes buffered input on timeout', async () => {
      const writeFn = vi.fn()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const gate = createReadinessGate('test-session', writeFn, 1000)

      gate.bufferInput('waiting-input')
      expect(writeFn).not.toHaveBeenCalled()

      // Timeout triggers flush
      await vi.advanceTimersByTimeAsync(1000)
      expect(writeFn).toHaveBeenCalledWith('waiting-input')

      vi.mocked(console.warn).mockRestore()
      gate.dispose()
    })
  })

  describe('disposal', () => {
    it('resolves waitForReady on dispose so pending awaits do not hang', async () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      let resolved = false
      gate.waitForReady().then(() => { resolved = true })

      gate.dispose()
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(true)
    })

    it('clears the input buffer on dispose', () => {
      const writeFn = vi.fn()
      const gate = createReadinessGate('test-session', writeFn)

      gate.bufferInput('will-be-lost')
      gate.dispose()

      // The writeFn should not have been called (buffer cleared, not flushed)
      expect(writeFn).not.toHaveBeenCalled()
    })

    it('does not fire timeout callback after dispose', async () => {
      const writeFn = vi.fn()
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const gate = createReadinessGate('test-session', writeFn, 1000)

      gate.dispose()
      await vi.advanceTimersByTimeAsync(2000)

      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })
})
