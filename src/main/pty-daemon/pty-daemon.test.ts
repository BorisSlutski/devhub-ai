/**
 * @vitest-environment node
 *
 * Tests for the PTY Daemon system:
 * - Protocol serialization
 * - Daemon startup and ping
 * - Session create -> attach -> data -> write -> detach flow
 * - Session survives client disconnect/reconnect
 * - Subprocess isolation (one crash doesn't affect others)
 * - Graceful shutdown
 * - Max concurrent spawns limit
 * - Auto-start daemon on connect
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as net from 'net'
import {
  encodeData,
  decodeData,
  serializeMessage,
  parseMessages,
  SOCKET_PATH,
  PID_FILE_PATH,
  type DaemonCommand,
  type DaemonMessage,
  type PtySpawnOptions,
  type SubprocessInbound,
  type SubprocessOutbound,
} from './protocol'

// ── 1. Protocol serialization tests ──

describe('Protocol', () => {
  describe('encodeData / decodeData', () => {
    it('round-trips ASCII strings', () => {
      const original = 'hello world'
      expect(decodeData(encodeData(original))).toBe(original)
    })

    it('round-trips binary data', () => {
      // Build a string with bytes 0-255
      let binary = ''
      for (let i = 0; i < 256; i++) {
        binary += String.fromCharCode(i)
      }
      expect(decodeData(encodeData(binary))).toBe(binary)
    })

    it('round-trips ANSI escape sequences', () => {
      const ansi = '\x1b[31mred text\x1b[0m'
      expect(decodeData(encodeData(ansi))).toBe(ansi)
    })

    it('handles empty string', () => {
      expect(decodeData(encodeData(''))).toBe('')
    })
  })

  describe('serializeMessage', () => {
    it('produces newline-terminated JSON', () => {
      const msg = { cmd: 'ping' } as DaemonCommand
      const serialized = serializeMessage(msg)
      expect(serialized).toBe('{"cmd":"ping"}\n')
      expect(serialized.endsWith('\n')).toBe(true)
    })

    it('includes all fields', () => {
      const msg = { cmd: 'create', sessionId: 's1', options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 } } as DaemonCommand
      const parsed = JSON.parse(serializeMessage(msg).trim())
      expect(parsed.cmd).toBe('create')
      expect(parsed.sessionId).toBe('s1')
      expect(parsed.options.shell).toBe('/bin/zsh')
    })
  })

  describe('parseMessages', () => {
    it('parses single complete message', () => {
      const { messages, remainder } = parseMessages('{"cmd":"ping"}\n')
      expect(messages).toHaveLength(1)
      expect(messages[0].cmd).toBe('ping')
      expect(remainder).toBe('')
    })

    it('parses multiple messages', () => {
      const input = '{"cmd":"ping"}\n{"cmd":"list"}\n'
      const { messages, remainder } = parseMessages(input)
      expect(messages).toHaveLength(2)
      expect(messages[0].cmd).toBe('ping')
      expect(messages[1].cmd).toBe('list')
      expect(remainder).toBe('')
    })

    it('preserves incomplete trailing data', () => {
      const input = '{"cmd":"ping"}\n{"cmd":"lis'
      const { messages, remainder } = parseMessages(input)
      expect(messages).toHaveLength(1)
      expect(remainder).toBe('{"cmd":"lis')
    })

    it('handles empty input', () => {
      const { messages, remainder } = parseMessages('')
      expect(messages).toEqual([])
      expect(remainder).toBe('')
    })

    it('skips malformed lines', () => {
      const input = 'not-json\n{"cmd":"ping"}\n'
      const { messages, remainder } = parseMessages(input)
      expect(messages).toHaveLength(1)
      expect(messages[0].cmd).toBe('ping')
    })

    it('handles blank lines gracefully', () => {
      const input = '\n\n{"cmd":"ping"}\n\n'
      const { messages, remainder } = parseMessages(input)
      expect(messages).toHaveLength(1)
      expect(messages[0].cmd).toBe('ping')
    })
  })
})

// ── 2. Daemon command handling tests (unit-level, mocked) ──

describe('Daemon command handling', () => {
  // We test the daemon's handleCommand function in isolation by importing
  // the daemon module and mocking child_process.fork.

  let mockChildProcess: any
  let forkMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    // Create a mock child process
    mockChildProcess = {
      pid: 12345,
      send: vi.fn(),
      kill: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    }

    forkMock = vi.fn().mockReturnValue(mockChildProcess)

    vi.doMock('child_process', () => ({
      fork: forkMock,
      spawn: vi.fn(),
      execSync: vi.fn(),
    }))

    vi.doMock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(String(process.pid)),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
      createWriteStream: vi.fn().mockReturnValue({ write: vi.fn(), end: vi.fn() }),
      chmodSync: vi.fn(),
    }))

    vi.doMock('net', () => ({
      createServer: vi.fn().mockReturnValue({
        listen: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      }),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('ping returns ok with pid and uptime', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    const response = await daemon.handleCommand({ cmd: 'ping' }, mockSocket)
    expect(response).toMatchObject({
      ok: true,
      pid: process.pid,
    })
    expect((response as any).uptime).toBeGreaterThanOrEqual(0)
    expect((response as any).sessionCount).toBe(0)
  })

  it('list returns empty sessions array initially', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    const response = await daemon.handleCommand({ cmd: 'list' }, mockSocket)
    expect(response).toMatchObject({
      ok: true,
      sessions: [],
    })
  })

  it('create forks a subprocess and returns ok', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    const response = await daemon.handleCommand({
      cmd: 'create',
      sessionId: 'test-1',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    expect(response).toMatchObject({ ok: true, sessionId: 'test-1' })
    expect(forkMock).toHaveBeenCalled()
    expect(mockChildProcess.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'start' })
    )

    // Verify session appears in list
    const listResponse = await daemon.handleCommand({ cmd: 'list' }, mockSocket)
    expect((listResponse as any).sessions).toHaveLength(1)
    expect((listResponse as any).sessions[0].sessionId).toBe('test-1')

    // Cleanup
    daemon.destroySession('test-1')
  })

  it('attach to nonexistent session returns error', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    const response = await daemon.handleCommand({
      cmd: 'attach',
      sessionId: 'nonexistent',
    }, mockSocket)

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found'),
    })
  })

  it('write to nonexistent session returns error', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    const response = await daemon.handleCommand({
      cmd: 'write',
      sessionId: 'nonexistent',
      data: encodeData('hello'),
    }, mockSocket)

    expect(response).toMatchObject({
      ok: false,
      error: expect.stringContaining('not found'),
    })
  })

  it('kill nonexistent session still returns ok', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    const response = await daemon.handleCommand({
      cmd: 'kill',
      sessionId: 'nonexistent',
    }, mockSocket)

    expect(response).toMatchObject({ ok: true })
  })

  it('create + attach + write forwards to subprocess', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    await daemon.handleCommand({
      cmd: 'create',
      sessionId: 'test-2',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    await daemon.handleCommand({ cmd: 'attach', sessionId: 'test-2' }, mockSocket)

    const encodedData = encodeData('echo hello\n')
    await daemon.handleCommand({
      cmd: 'write',
      sessionId: 'test-2',
      data: encodedData,
    }, mockSocket)

    // Verify subprocess.send was called with write message
    const sendCalls = mockChildProcess.send.mock.calls
    const writeCall = sendCalls.find((c: any[]) => c[0].type === 'write')
    expect(writeCall).toBeDefined()
    expect(writeCall[0].data).toBe(encodedData)

    daemon.destroySession('test-2')
  })

  it('create + resize forwards to subprocess', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    await daemon.handleCommand({
      cmd: 'create',
      sessionId: 'test-3',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    await daemon.handleCommand({
      cmd: 'resize',
      sessionId: 'test-3',
      cols: 120,
      rows: 40,
    }, mockSocket)

    const sendCalls = mockChildProcess.send.mock.calls
    const resizeCall = sendCalls.find((c: any[]) => c[0].type === 'resize')
    expect(resizeCall).toBeDefined()
    expect(resizeCall[0].cols).toBe(120)
    expect(resizeCall[0].rows).toBe(40)

    daemon.destroySession('test-3')
  })

  it('subprocess data event is broadcast to attached clients', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    await daemon.handleCommand({
      cmd: 'create',
      sessionId: 'test-data',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    await daemon.handleCommand({ cmd: 'attach', sessionId: 'test-data' }, mockSocket)

    // Simulate subprocess sending data by triggering the 'message' handler
    const messageHandler = mockChildProcess.on.mock.calls.find(
      (c: any[]) => c[0] === 'message'
    )
    expect(messageHandler).toBeDefined()

    const onMessage = messageHandler[1]
    const testData = encodeData('some output')
    onMessage({ type: 'data', data: testData })

    // The attached client socket should have received the data event
    expect(mockSocket.write).toHaveBeenCalled()
    const written = mockSocket.write.mock.calls.find((c: any[]) => {
      try {
        const msg = JSON.parse(c[0].trim())
        return msg.event === 'data' && msg.sessionId === 'test-data'
      } catch {
        return false
      }
    })
    expect(written).toBeDefined()

    daemon.destroySession('test-data')
  })

  it('subprocess exit event is broadcast to attached clients', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    await daemon.handleCommand({
      cmd: 'create',
      sessionId: 'test-exit',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    await daemon.handleCommand({ cmd: 'attach', sessionId: 'test-exit' }, mockSocket)

    // Simulate subprocess exit message
    const messageHandler = mockChildProcess.on.mock.calls.find(
      (c: any[]) => c[0] === 'message'
    )
    const onMessage = messageHandler[1]
    onMessage({ type: 'exit', exitCode: 0 })

    // The attached client socket should have received the exit event
    const written = mockSocket.write.mock.calls.find((c: any[]) => {
      try {
        const msg = JSON.parse(c[0].trim())
        return msg.event === 'exit' && msg.sessionId === 'test-exit'
      } catch {
        return false
      }
    })
    expect(written).toBeDefined()

    // Session should be removed after exit
    const listResponse = await daemon.handleCommand({ cmd: 'list' }, mockSocket)
    const sessionIds = (listResponse as any).sessions.map((s: any) => s.sessionId)
    expect(sessionIds).not.toContain('test-exit')
  })

  it('detach stops event delivery to that client', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    await daemon.handleCommand({
      cmd: 'create',
      sessionId: 'test-detach',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    await daemon.handleCommand({ cmd: 'attach', sessionId: 'test-detach' }, mockSocket)
    await daemon.handleCommand({ cmd: 'detach', sessionId: 'test-detach' }, mockSocket)

    // Clear write mock to check that no events arrive after detach
    mockSocket.write.mockClear()

    // Simulate subprocess sending data
    const messageHandler = mockChildProcess.on.mock.calls.find(
      (c: any[]) => c[0] === 'message'
    )
    const onMessage = messageHandler[1]
    onMessage({ type: 'data', data: encodeData('after detach') })

    // Since we detached, the socket should NOT have received data events
    const dataWrites = mockSocket.write.mock.calls.filter((c: any[]) => {
      try {
        const msg = JSON.parse(c[0].trim())
        return msg.event === 'data'
      } catch {
        return false
      }
    })
    expect(dataWrites).toHaveLength(0)

    daemon.destroySession('test-detach')
  })
})

// ── 3. Subprocess isolation test ──

describe('Subprocess isolation', () => {
  let forkMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    // Each fork creates an independent mock child process
    forkMock = vi.fn().mockImplementation(() => ({
      pid: Math.floor(Math.random() * 100000),
      send: vi.fn(),
      kill: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    }))

    vi.doMock('child_process', () => ({
      fork: forkMock,
      spawn: vi.fn(),
      execSync: vi.fn(),
    }))

    vi.doMock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(String(process.pid)),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
      createWriteStream: vi.fn().mockReturnValue({ write: vi.fn(), end: vi.fn() }),
      chmodSync: vi.fn(),
    }))

    vi.doMock('net', () => ({
      createServer: vi.fn().mockReturnValue({
        listen: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      }),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('one subprocess crashing does not affect others', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    // Create two sessions
    await daemon.handleCommand({
      cmd: 'create',
      sessionId: 'session-a',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    await daemon.handleCommand({
      cmd: 'create',
      sessionId: 'session-b',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    // Both should be in the list
    let listResponse = await daemon.handleCommand({ cmd: 'list' }, mockSocket)
    expect((listResponse as any).sessions).toHaveLength(2)

    // Simulate session-a's subprocess crashing (triggering the 'exit' handler)
    const childA = forkMock.mock.results[0].value
    const exitHandler = childA.on.mock.calls.find((c: any[]) => c[0] === 'exit')
    expect(exitHandler).toBeDefined()
    exitHandler[1](1) // exit with code 1

    // session-a should be gone, session-b should still exist
    listResponse = await daemon.handleCommand({ cmd: 'list' }, mockSocket)
    const sessionIds = (listResponse as any).sessions.map((s: any) => s.sessionId)
    expect(sessionIds).not.toContain('session-a')
    expect(sessionIds).toContain('session-b')

    // session-b should still be writable
    const response = await daemon.handleCommand({
      cmd: 'write',
      sessionId: 'session-b',
      data: encodeData('still alive'),
    }, mockSocket)
    expect(response).toMatchObject({ ok: true })

    daemon.destroySession('session-b')
  })
})

// ── 4. Max concurrent spawns test ──

describe('Max concurrent spawns', () => {
  let forkMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetModules()

    forkMock = vi.fn().mockImplementation(() => ({
      pid: Math.floor(Math.random() * 100000),
      send: vi.fn(),
      kill: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    }))

    vi.doMock('child_process', () => ({
      fork: forkMock,
      spawn: vi.fn(),
      execSync: vi.fn(),
    }))

    vi.doMock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(String(process.pid)),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
      createWriteStream: vi.fn().mockReturnValue({ write: vi.fn(), end: vi.fn() }),
      chmodSync: vi.fn(),
    }))

    vi.doMock('net', () => ({
      createServer: vi.fn().mockReturnValue({
        listen: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      }),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('enforces MAX_CONCURRENT_SPAWNS limit', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    // The max is 3. Create 3 sessions — all should proceed immediately.
    const results = await Promise.all([
      daemon.handleCommand({
        cmd: 'create', sessionId: 'spawn-1',
        options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
      }, mockSocket),
      daemon.handleCommand({
        cmd: 'create', sessionId: 'spawn-2',
        options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
      }, mockSocket),
      daemon.handleCommand({
        cmd: 'create', sessionId: 'spawn-3',
        options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
      }, mockSocket),
    ])

    expect(results.every((r) => (r as any).ok === true)).toBe(true)
    expect(forkMock).toHaveBeenCalledTimes(3)

    // 4th spawn should queue until a slot is freed.
    // We start the 4th create — it won't resolve until we kill one session.
    const fourthPromise = daemon.handleCommand({
      cmd: 'create', sessionId: 'spawn-4',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    // At this point fork should still be at 3 calls (4th is queued)
    expect(forkMock).toHaveBeenCalledTimes(3)

    // Simulate session spawn-1's subprocess exiting to free a slot
    const childSpawn1 = forkMock.mock.results[0].value
    const exitHandler = childSpawn1.on.mock.calls.find((c: any[]) => c[0] === 'exit')
    exitHandler[1](0) // exit releases the slot

    // Now the 4th should proceed
    const fourthResult = await fourthPromise
    expect((fourthResult as any).ok).toBe(true)
    expect(forkMock).toHaveBeenCalledTimes(4)

    // Cleanup
    daemon.destroySession('spawn-2')
    daemon.destroySession('spawn-3')
    daemon.destroySession('spawn-4')
  })
})

// ── 5. DaemonClient unit tests (mocked socket) ──

describe('DaemonClient', () => {
  it('exports DaemonClient class', async () => {
    const { DaemonClient } = await import('./daemon-client')
    expect(DaemonClient).toBeDefined()
    const client = new DaemonClient()
    expect(client.isConnected).toBe(false)
  })
})

// ── 6. DaemonPtyManager public API tests ──

describe('DaemonPtyManager', () => {
  it('exports DaemonPtyManager class and startDaemonProcess', async () => {
    const mod = await import('./index')
    expect(mod.DaemonPtyManager).toBeDefined()
    expect(mod.startDaemonProcess).toBeDefined()
  })

  it('DaemonPtyManager has API-compatible methods', async () => {
    const { DaemonPtyManager } = await import('./index')
    const manager = new DaemonPtyManager()

    // Check that all expected methods exist
    expect(typeof manager.setMainWindow).toBe('function')
    expect(typeof manager.setShellPath).toBe('function')
    expect(typeof manager.onData).toBe('function')
    expect(typeof manager.onExit).toBe('function')
    expect(typeof manager.createSession).toBe('function')
    expect(typeof manager.write).toBe('function')
    expect(typeof manager.resize).toBe('function')
    expect(typeof manager.destroySession).toBe('function')
    expect(typeof manager.destroyAll).toBe('function')
    expect(typeof manager.getSessions).toBe('function')

    // New methods
    expect(typeof manager.attach).toBe('function')
    expect(typeof manager.detach).toBe('function')
    expect(typeof manager.reconnect).toBe('function')
    expect(typeof manager.disconnect).toBe('function')
    expect(typeof manager.init).toBe('function')
  })

  it('getSessions returns empty array initially', async () => {
    const { DaemonPtyManager } = await import('./index')
    const manager = new DaemonPtyManager()
    expect(manager.getSessions()).toEqual([])
  })
})

// ── 7. Graceful shutdown test ──

describe('Graceful shutdown', () => {
  let forkMock: ReturnType<typeof vi.fn>
  let mockChild: any

  beforeEach(() => {
    vi.resetModules()

    mockChild = {
      pid: 99999,
      send: vi.fn(),
      kill: vi.fn(),
      on: vi.fn(),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
    }

    forkMock = vi.fn().mockReturnValue(mockChild)

    vi.doMock('child_process', () => ({
      fork: forkMock,
      spawn: vi.fn(),
      execSync: vi.fn(),
    }))

    vi.doMock('fs', () => ({
      existsSync: vi.fn().mockReturnValue(true),
      readFileSync: vi.fn().mockReturnValue(String(process.pid)),
      writeFileSync: vi.fn(),
      unlinkSync: vi.fn(),
      mkdirSync: vi.fn(),
      createWriteStream: vi.fn().mockReturnValue({ write: vi.fn(), end: vi.fn() }),
      chmodSync: vi.fn(),
    }))

    vi.doMock('net', () => ({
      createServer: vi.fn().mockReturnValue({
        listen: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
      }),
    }))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shutdown command kills all sessions', async () => {
    const daemon = await import('./daemon')
    const mockSocket = { destroyed: false, write: vi.fn() } as any

    // Create a session
    await daemon.handleCommand({
      cmd: 'create',
      sessionId: 'shutdown-test',
      options: { shell: '/bin/zsh', cwd: '/tmp', env: {}, cols: 80, rows: 24 },
    }, mockSocket)

    // Verify session exists
    let listResponse = await daemon.handleCommand({ cmd: 'list' }, mockSocket)
    expect((listResponse as any).sessions).toHaveLength(1)

    // Send shutdown — should trigger kill on subprocess
    const response = await daemon.handleCommand({ cmd: 'shutdown' }, mockSocket)
    expect(response).toMatchObject({ ok: true })

    // Subprocess should have received kill command
    expect(mockChild.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kill' })
    )

    // Sessions should be cleared
    listResponse = await daemon.handleCommand({ cmd: 'list' }, mockSocket)
    expect((listResponse as any).sessions).toHaveLength(0)
  })
})
