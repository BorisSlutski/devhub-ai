/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import { BrowserWindow } from 'electron'
import * as nodePtyMock from './__mocks__/node-pty'

const { mockPtyProcess, mockSpawn } = nodePtyMock

// Inject mock before pty-manager loads (it checks globalThis.__PTY_FOR_TEST__)
;(globalThis as any).__PTY_FOR_TEST__ = nodePtyMock

vi.mock('electron', () => {
  class MockBrowserWindow {
    isDestroyed = () => false
    webContents = { send: vi.fn() }
  }
  return { BrowserWindow: MockBrowserWindow }
})

vi.mock('./browser-bridge', () => ({
  getBridgePort: vi.fn().mockReturnValue(0),
}))

describe('PtyManager', () => {
  let ptyManager: typeof import('./pty-manager').ptyManager

  beforeAll(async () => {
    const mod = await import('./pty-manager')
    ptyManager = mod.ptyManager
  })
  let mockWindow: InstanceType<typeof BrowserWindow>

  beforeEach(() => {
    vi.clearAllMocks()
    ptyManager.destroyAll()

    mockWindow = new BrowserWindow()
    ptyManager.setMainWindow(mockWindow)

    mockPtyProcess.onData.mockImplementation((cb: (d: string) => void) => {
      ;(mockPtyProcess as any)._onData = cb
    })
    mockPtyProcess.onExit.mockImplementation((cb: (e: { exitCode: number }) => void) => {
      ;(mockPtyProcess as any)._onExit = cb
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('1. Session lifecycle', () => {
    it('createSession returns success', () => {
      const result = ptyManager.createSession(
        's1',
        'my-folder',
        '/path/to/folder',
        null,
        null,
        'ls'
      )
      expect(result).toEqual({
        success: true,
        id: 's1',
        folderName: 'my-folder',
        worktreePath: null,
        branchName: null,
      })
    })

    it('getSessions returns created session', () => {
      ptyManager.createSession('s1', 'my-folder', '/path/to/folder', null, null, 'ls')
      const sessions = ptyManager.getSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0]).toEqual({
        id: 's1',
        folderName: 'my-folder',
        worktreePath: null,
        branchName: null,
      })
    })

    it('destroySession removes session', () => {
      ptyManager.createSession('s1', 'my-folder', '/path/to/folder', null, null, 'ls')
      expect(ptyManager.getSessions()).toHaveLength(1)
      ptyManager.destroySession('s1')
      expect(ptyManager.getSessions()).toEqual([])
      expect(mockPtyProcess.kill).toHaveBeenCalled()
    })
  })

  describe('2. Duplicate session handling', () => {
    it('creating session with same ID destroys old session first', () => {
      ptyManager.createSession('s1', 'folder1', '/path/1', null, null, 'cmd1')
      expect(mockPtyProcess.kill).not.toHaveBeenCalled()

      ptyManager.createSession('s1', 'folder2', '/path/2', null, null, 'cmd2')
      expect(mockPtyProcess.kill).toHaveBeenCalledTimes(1)
      expect(ptyManager.getSessions()).toHaveLength(1)
      expect(ptyManager.getSessions()[0].folderName).toBe('folder2')
    })
  })

  describe('3. Data flow', () => {
    it('onData callback sends to mainWindow.webContents', () => {
      ptyManager.createSession('s1', 'f', '/p', null, null, 'ls')
      const onDataCb = (mockPtyProcess as any)._onData
      expect(onDataCb).toBeDefined()

      onDataCb('hello world')
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty-data', {
        sessionId: 's1',
        data: 'hello world',
      })
    })
  })

  describe('4. Exit flow', () => {
    it('onExit callback sends exit event and removes session', () => {
      ptyManager.createSession('s1', 'f', '/p', null, null, 'ls')
      const onExitCb = (mockPtyProcess as any)._onExit
      expect(onExitCb).toBeDefined()

      onExitCb({ exitCode: 0 })
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty-exit', {
        sessionId: 's1',
        exitCode: 0,
      })
      expect(ptyManager.getSessions()).toEqual([])
    })
  })

  describe('5. Write/Resize', () => {
    it('write() buffers input through readiness gate before shell is ready', () => {
      ptyManager.createSession('s1', 'f', '/p', null, null, 'ls')
      mockPtyProcess.write.mockClear()

      // Before the shell is ready, input is buffered (not written directly)
      ptyManager.write('s1', 'echo hi\n')
      expect(mockPtyProcess.write).not.toHaveBeenCalled()
    })

    it('write() forwards to ptyProcess after shell is ready', () => {
      ptyManager.createSession('s1', 'f', '/p', null, null, 'ls')
      const onDataCb = (mockPtyProcess as any)._onData

      // Simulate the shell emitting the readiness marker
      onDataCb('\x1b]777;devhub-ai-shell-ready\x07')
      mockPtyProcess.write.mockClear()

      ptyManager.write('s1', 'echo hi\n')
      expect(mockPtyProcess.write).toHaveBeenCalledWith('echo hi\n')
    })

    it('resize() forwards to ptyProcess when session exists', () => {
      ptyManager.createSession('s1', 'f', '/p', null, null, 'ls')
      ptyManager.resize('s1', 120, 30)
      expect(mockPtyProcess.resize).toHaveBeenCalledWith(120, 30)
    })

    it('write() does nothing when session does not exist', () => {
      mockPtyProcess.write.mockClear()
      ptyManager.write('nonexistent', 'ls\n')
      expect(mockPtyProcess.write).not.toHaveBeenCalled()
    })

    it('resize() does nothing when session does not exist', () => {
      ptyManager.resize('nonexistent', 120, 30)
      expect(mockPtyProcess.resize).not.toHaveBeenCalled()
    })
  })

  describe('6. Environment', () => {
    it('sets TERM, deletes CLAUDECODE, sets DEVHUB_AI_SESSION_ID in env', () => {
      const hadClaudecode = 'CLAUDECODE' in process.env
      process.env.CLAUDECODE = 'nested'
      try {
        ptyManager.createSession('my-session-id', 'f', '/p', null, null, 'ls')

        expect(mockSpawn).toHaveBeenCalled()
        const spawnCall = mockSpawn.mock.calls[0]
        const env = spawnCall[2].env
        expect(env.TERM).toBe('xterm-256color')
        expect(env.CLAUDECODE).toBeUndefined()
        expect(env.DEVHUB_AI_SESSION_ID).toBe('my-session-id')
        expect(env.DISABLE_AUTO_UPDATE).toBe('true')
      } finally {
        if (!hadClaudecode) delete process.env.CLAUDECODE
      }
    })
  })

  describe('7. Command execution via readiness gate', () => {
    it('injects readiness command immediately on spawn', () => {
      ptyManager.createSession('s1', 'f', '/p', null, null, 'cd /tmp')

      // The readiness printf command should be written immediately
      expect(mockPtyProcess.write).toHaveBeenCalledWith(
        expect.stringContaining('777;devhub-ai-shell-ready')
      )
    })

    it('sends command after readiness marker is detected', async () => {
      ptyManager.createSession('s1', 'f', '/p', null, null, 'cd /tmp')
      const onDataCb = (mockPtyProcess as any)._onData
      mockPtyProcess.write.mockClear()

      // Simulate the shell emitting the readiness marker
      onDataCb('\x1b]777;devhub-ai-shell-ready\x07')

      // Allow the waitForReady promise to resolve
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(mockPtyProcess.write).toHaveBeenCalledWith('cd /tmp\r')
    })

    it('does not send command before readiness marker', () => {
      ptyManager.createSession('s1', 'f', '/p', null, null, 'cd /tmp')

      // Only the readiness command was written, not the user command
      const writes = mockPtyProcess.write.mock.calls.map((c: string[]) => c[0])
      expect(writes).not.toContain('cd /tmp\r')
    })

    it('sends command on timeout if marker never arrives', async () => {
      vi.useFakeTimers()
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      ptyManager.createSession('s1', 'f', '/p', null, null, 'cd /tmp')
      mockPtyProcess.write.mockClear()

      // Advance past the 15s timeout
      await vi.advanceTimersByTimeAsync(15_000)

      expect(mockPtyProcess.write).toHaveBeenCalledWith('cd /tmp\r')
      vi.mocked(console.warn).mockRestore()
    })

    it('does not inject readiness command when command is empty', () => {
      ptyManager.createSession('s1', 'f', '/p', null, null, '')
      expect(mockPtyProcess.write).not.toHaveBeenCalled()
    })
  })

  describe('8. Spawn failure', () => {
    it('returns { success: false, error } when pty.spawn throws', () => {
      mockSpawn.mockImplementationOnce(() => {
        throw new Error('spawn ENOENT')
      })

      const result = ptyManager.createSession('s1', 'f', '/p', null, null, 'ls')

      expect(result.success).toBe(false)
      expect(result.error).toBe('spawn ENOENT')
      expect(ptyManager.getSessions()).toEqual([])
    })
  })

  describe('9. Window destroyed', () => {
    it('onData does not throw when mainWindow.isDestroyed() returns true', () => {
      mockWindow.isDestroyed = () => true
      ptyManager.createSession('s1', 'f', '/p', null, null, 'ls')
      const onDataCb = (mockPtyProcess as any)._onData

      expect(() => onDataCb('data')).not.toThrow()
      expect(mockWindow.webContents.send).not.toHaveBeenCalled()
    })

    it('onExit does not throw when mainWindow.isDestroyed() returns true', () => {
      mockWindow.isDestroyed = () => true
      ptyManager.createSession('s1', 'f', '/p', null, null, 'ls')
      const onExitCb = (mockPtyProcess as any)._onExit

      expect(() => onExitCb({ exitCode: 1 })).not.toThrow()
      expect(mockWindow.webContents.send).not.toHaveBeenCalled()
      expect(ptyManager.getSessions()).toEqual([])
    })
  })

  describe('10. destroyAll', () => {
    it('kills all sessions', () => {
      ptyManager.createSession('s1', 'f1', '/p1', null, null, 'ls')
      ptyManager.createSession('s2', 'f2', '/p2', null, null, 'ls')
      expect(ptyManager.getSessions()).toHaveLength(2)

      ptyManager.destroyAll()
      expect(ptyManager.getSessions()).toEqual([])
      expect(mockPtyProcess.kill).toHaveBeenCalledTimes(2)
    })
  })

  describe('Guard clauses (existing)', () => {
    it('getSessions() returns empty array initially', () => {
      expect(ptyManager.getSessions()).toEqual([])
    })

    it('destroySession() does nothing when session does not exist', () => {
      expect(() => ptyManager.destroySession('nonexistent')).not.toThrow()
    })
  })
})
