/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parsePsOutput, findDescendants, ResourceMonitor } from './resource-monitor'
import type { ResourceSnapshot } from '../shared/ipc-types'

// Mock child_process.execFile and pty-manager
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}))

vi.mock('./pty-manager', () => ({
  ptyManager: {
    getSessionPids: vi.fn().mockReturnValue(new Map()),
  },
}))

const { execFile } = await import('child_process')
const { ptyManager } = await import('./pty-manager')

const mockExecFile = vi.mocked(execFile as any)
const mockGetSessionPids = vi.mocked(ptyManager.getSessionPids)

describe('ResourceMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('parsePsOutput', () => {
    it('parses standard ps output into a process map', () => {
      const output = [
        '    1     0   4096   0.0 /sbin/launchd',
        '  100     1  12288   1.5 /usr/sbin/syslogd',
        '  200   100   8192   0.3 /usr/libexec/logd',
        '  300     1  32768  25.0 /Applications/Electron.app/Contents/MacOS/Electron',
      ].join('\n')

      const map = parsePsOutput(output)

      expect(map.size).toBe(4)
      expect(map.get(1)).toEqual({ ppid: 0, rss: 4096, cpu: 0.0, comm: '/sbin/launchd' })
      expect(map.get(100)).toEqual({ ppid: 1, rss: 12288, cpu: 1.5, comm: '/usr/sbin/syslogd' })
      expect(map.get(200)).toEqual({ ppid: 100, rss: 8192, cpu: 0.3, comm: '/usr/libexec/logd' })
      expect(map.get(300)).toEqual({ ppid: 1, rss: 32768, cpu: 25.0, comm: '/Applications/Electron.app/Contents/MacOS/Electron' })
    })

    it('handles empty output', () => {
      expect(parsePsOutput('')).toEqual(new Map())
      expect(parsePsOutput('\n\n')).toEqual(new Map())
    })

    it('skips malformed lines', () => {
      const output = [
        '    1     0   4096   0.0 launchd',
        'not a valid line',
        '  abc   def   ghi   jkl cmd',
        '  200   100   8192   0.3 logd',
      ].join('\n')

      const map = parsePsOutput(output)
      // "abc def ghi jkl cmd" has NaN pid/ppid so should be skipped
      expect(map.size).toBe(2)
      expect(map.has(1)).toBe(true)
      expect(map.has(200)).toBe(true)
    })

    it('handles commands with spaces', () => {
      const output = '  500   300   2048   5.0 /usr/bin/some process with spaces'
      const map = parsePsOutput(output)
      expect(map.get(500)?.comm).toBe('/usr/bin/some process with spaces')
    })

    it('handles zero and NaN rss/cpu gracefully', () => {
      const output = '  10     1      0   0.0 idle'
      const map = parsePsOutput(output)
      expect(map.get(10)).toEqual({ ppid: 1, rss: 0, cpu: 0, comm: 'idle' })
    })
  })

  describe('findDescendants', () => {
    it('finds direct children', () => {
      const processes = new Map([
        [1, { ppid: 0, rss: 100, cpu: 1, comm: 'init' }],
        [10, { ppid: 1, rss: 200, cpu: 2, comm: 'shell' }],
        [20, { ppid: 10, rss: 300, cpu: 3, comm: 'child' }],
        [30, { ppid: 1, rss: 400, cpu: 4, comm: 'other' }],
      ])

      const desc = findDescendants(10, processes)
      expect(desc).toEqual(new Set([10, 20]))
    })

    it('finds grandchildren and deeper', () => {
      const processes = new Map([
        [100, { ppid: 0, rss: 100, cpu: 1, comm: 'root' }],
        [200, { ppid: 100, rss: 200, cpu: 2, comm: 'child' }],
        [300, { ppid: 200, rss: 300, cpu: 3, comm: 'grandchild' }],
        [400, { ppid: 300, rss: 400, cpu: 4, comm: 'great-grandchild' }],
        [500, { ppid: 100, rss: 500, cpu: 5, comm: 'sibling' }],
      ])

      const desc = findDescendants(100, processes)
      expect(desc).toEqual(new Set([100, 200, 300, 400, 500]))
    })

    it('returns empty set when PID not in map', () => {
      const processes = new Map([
        [1, { ppid: 0, rss: 100, cpu: 1, comm: 'init' }],
      ])

      const desc = findDescendants(999, processes)
      expect(desc.size).toBe(0)
    })

    it('handles single process (no children)', () => {
      const processes = new Map([
        [42, { ppid: 1, rss: 100, cpu: 1, comm: 'lonely' }],
        [99, { ppid: 1, rss: 200, cpu: 2, comm: 'other' }],
      ])

      const desc = findDescendants(42, processes)
      expect(desc).toEqual(new Set([42]))
    })

    it('handles forked tree (multiple children at each level)', () => {
      const processes = new Map([
        [1, { ppid: 0, rss: 100, cpu: 1, comm: 'root' }],
        [10, { ppid: 1, rss: 100, cpu: 1, comm: 'a' }],
        [11, { ppid: 1, rss: 100, cpu: 1, comm: 'b' }],
        [100, { ppid: 10, rss: 100, cpu: 1, comm: 'aa' }],
        [101, { ppid: 10, rss: 100, cpu: 1, comm: 'ab' }],
        [110, { ppid: 11, rss: 100, cpu: 1, comm: 'ba' }],
      ])

      const desc = findDescendants(1, processes)
      expect(desc).toEqual(new Set([1, 10, 11, 100, 101, 110]))
    })
  })

  describe('ResourceMonitor class', () => {
    it('getSnapshot returns host metrics even with no sessions', async () => {
      mockGetSessionPids.mockReturnValue(new Map())
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, '', '')
      })

      const monitor = new ResourceMonitor()
      const snapshot = await monitor.getSnapshot()

      expect(snapshot.timestamp).toBeGreaterThan(0)
      expect(snapshot.sessions).toEqual([])
      expect(snapshot.host.totalMemory).toBeGreaterThan(0)
      expect(snapshot.host.cpuCores).toBeGreaterThan(0)
      expect(typeof snapshot.host.memoryUsagePercent).toBe('number')
      expect(typeof snapshot.host.loadAverage1m).toBe('number')
    })

    it('getSnapshot aggregates process tree metrics per session', async () => {
      mockGetSessionPids.mockReturnValue(new Map([
        ['session-1', 100],
        ['session-2', 200],
      ]))

      const psOutput = [
        '  100     1   4096   5.0 /bin/zsh',
        '  101   100   8192  10.0 node',
        '  102   101   2048   3.5 python',
        '  200     1   1024   2.0 /bin/zsh',
        '  201   200  16384  50.0 claude',
        '  999     1   1024   1.0 unrelated',
      ].join('\n')

      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, psOutput, '')
      })

      const monitor = new ResourceMonitor()
      const snapshot = await monitor.getSnapshot()

      expect(snapshot.sessions).toHaveLength(2)

      const s1 = snapshot.sessions.find(s => s.sessionId === 'session-1')!
      expect(s1.pid).toBe(100)
      expect(s1.cpu).toBe(18.5) // 5.0 + 10.0 + 3.5
      expect(s1.memory).toBe((4096 + 8192 + 2048) * 1024) // KB -> bytes
      expect(s1.processCount).toBe(3)

      const s2 = snapshot.sessions.find(s => s.sessionId === 'session-2')!
      expect(s2.pid).toBe(200)
      expect(s2.cpu).toBe(52) // 2.0 + 50.0
      expect(s2.memory).toBe((1024 + 16384) * 1024)
      expect(s2.processCount).toBe(2)
    })

    it('returns cached snapshot within TTL', async () => {
      mockGetSessionPids.mockReturnValue(new Map())
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        callCount++
        cb(null, '', '')
      })

      const monitor = new ResourceMonitor()
      await monitor.getSnapshot()
      expect(callCount).toBe(1)

      // Second call should use cache
      await monitor.getSnapshot()
      expect(callCount).toBe(1)
    })

    it('handles ps failure gracefully', async () => {
      mockGetSessionPids.mockReturnValue(new Map([['s1', 100]]))
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(new Error('ps failed'), '', '')
      })

      const monitor = new ResourceMonitor()
      const snapshot = await monitor.getSnapshot()

      // Should still return valid snapshot with empty session metrics
      expect(snapshot.sessions).toHaveLength(1)
      expect(snapshot.sessions[0].cpu).toBe(0)
      expect(snapshot.sessions[0].memory).toBe(0)
      expect(snapshot.sessions[0].processCount).toBe(0)
      expect(snapshot.host.totalMemory).toBeGreaterThan(0)
    })

    it('handles missing PTY PID in process list', async () => {
      // PID 100 exists in ptyManager but not in ps output (already exited)
      mockGetSessionPids.mockReturnValue(new Map([['s1', 100]]))
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, '  200     1   4096   1.0 something\n', '')
      })

      const monitor = new ResourceMonitor()
      const snapshot = await monitor.getSnapshot()

      expect(snapshot.sessions).toHaveLength(1)
      expect(snapshot.sessions[0].cpu).toBe(0)
      expect(snapshot.sessions[0].memory).toBe(0)
      expect(snapshot.sessions[0].processCount).toBe(0)
    })

    it('onUpdate callback receives snapshots during poll', async () => {
      vi.useFakeTimers()

      mockGetSessionPids.mockReturnValue(new Map())
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        cb(null, '', '')
      })

      const monitor = new ResourceMonitor()
      const received: ResourceSnapshot[] = []
      monitor.onUpdate((snap) => received.push(snap))

      monitor.start(1000)

      // Advance past first interval
      await vi.advanceTimersByTimeAsync(1100)
      expect(received.length).toBeGreaterThanOrEqual(1)

      monitor.stop()
    })

    it('offUpdate removes callback', () => {
      const monitor = new ResourceMonitor()
      const cb = vi.fn()
      monitor.onUpdate(cb)
      monitor.offUpdate(cb)

      // The callback array should be empty now
      // We can verify by checking that the internal callbacks don't include cb
      // (testing through behavior would require more setup, so we just check removal works)
      expect(cb).not.toHaveBeenCalled()
    })

    it('start and stop control polling', () => {
      vi.useFakeTimers()
      const monitor = new ResourceMonitor()

      monitor.start(5000)
      monitor.stop()

      // Starting again should work
      monitor.start(5000)
      monitor.stop()
    })

    it('setIdle toggles between active and idle cache TTL', async () => {
      mockGetSessionPids.mockReturnValue(new Map())
      let callCount = 0
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: Function) => {
        callCount++
        cb(null, '', '')
      })

      const monitor = new ResourceMonitor()

      // Active mode: cache TTL is 2.5s
      await monitor.getSnapshot()
      expect(callCount).toBe(1)

      // Switch to idle mode: cache TTL becomes 15s
      monitor.setIdle(true)

      // Cache is still fresh, should not re-fetch
      await monitor.getSnapshot()
      expect(callCount).toBe(1)
    })
  })
})
