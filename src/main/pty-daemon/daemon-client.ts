/**
 * DaemonClient — used by the Electron main process to communicate with the PTY daemon.
 *
 * Handles:
 * - Auto-starting the daemon if not running
 * - Connecting via Unix socket
 * - Sending commands and receiving responses
 * - Dispatching streamed events (data, exit, error) to registered callbacks
 * - Auto-reconnect on socket drop (3 retries with exponential backoff)
 */

import * as net from 'net'
import * as fs from 'fs'
import { spawn } from 'child_process'
import * as path from 'path'
import {
  SOCKET_PATH,
  PID_FILE_PATH,
  DEVDOCK_DIR_PATH,
  parseMessages,
  serializeMessage,
  type DaemonCommand,
  type DaemonResponse,
  type DaemonEvent,
  type PtySpawnOptions,
  type ErrorResponse,
  type ListResponse,
  type SessionListItem,
} from './protocol'

// ── Types ──

export type DataCallback = (data: string) => void
export type ExitCallback = (exitCode: number) => void
export type ErrorCallback = (message: string) => void

interface SessionCallbacks {
  onData?: DataCallback
  onExit?: ExitCallback
  onError?: ErrorCallback
}

interface PendingRequest {
  resolve: (msg: DaemonResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// ── Constants ──

const CONNECT_TIMEOUT_MS = 5000
const COMMAND_TIMEOUT_MS = 10000
const MAX_RECONNECT_RETRIES = 3
const RECONNECT_BASE_DELAY_MS = 500
const DAEMON_STARTUP_WAIT_MS = 2000
const DAEMON_STARTUP_POLL_INTERVAL_MS = 100

// ── DaemonClient ──

export class DaemonClient {
  private socket: net.Socket | null = null
  private connected = false
  private buffer = ''
  private requestId = 0
  private pendingRequests = new Map<number, PendingRequest>()
  private sessionCallbacks = new Map<string, SessionCallbacks>()
  private reconnectAttempts = 0
  private reconnecting = false

  /**
   * Connect to the daemon, starting it if necessary.
   * Resolves when the connection is established and verified with a ping.
   */
  async connect(): Promise<void> {
    await this.ensureDaemon()
    await this.connectSocket()
  }

  /**
   * Check if the daemon is running. If not, start it.
   */
  async ensureDaemon(): Promise<void> {
    if (await this.isDaemonRunning()) {
      return
    }
    await this.startDaemon()
  }

  /**
   * Create a new PTY session on the daemon.
   */
  async createSession(sessionId: string, options: PtySpawnOptions): Promise<boolean> {
    const response = await this.sendCommand({
      cmd: 'create',
      sessionId,
      options,
    })
    if (!response.ok) {
      throw new Error((response as ErrorResponse).error || 'create failed')
    }
    return true
  }

  /**
   * Attach to a session and start receiving data/exit/error events.
   */
  async attach(
    sessionId: string,
    onData?: DataCallback,
    onExit?: ExitCallback,
    onError?: ErrorCallback
  ): Promise<void> {
    this.sessionCallbacks.set(sessionId, { onData, onExit, onError })

    const response = await this.sendCommand({
      cmd: 'attach',
      sessionId,
    })

    if (!response.ok) {
      this.sessionCallbacks.delete(sessionId)
      throw new Error((response as ErrorResponse).error || 'attach failed')
    }
  }

  /**
   * Detach from a session (stop receiving events).
   */
  async detach(sessionId: string): Promise<void> {
    this.sessionCallbacks.delete(sessionId)

    if (this.connected) {
      try {
        await this.sendCommand({ cmd: 'detach', sessionId })
      } catch {
        // Best-effort detach
      }
    }
  }

  /**
   * Send input data to a PTY session.
   */
  async write(sessionId: string, data: string): Promise<void> {
    const encoded = Buffer.from(data, 'binary').toString('base64')
    const response = await this.sendCommand({
      cmd: 'write',
      sessionId,
      data: encoded,
    })
    if (!response.ok) {
      throw new Error((response as ErrorResponse).error || 'write failed')
    }
  }

  /**
   * Resize a PTY session.
   */
  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const response = await this.sendCommand({
      cmd: 'resize',
      sessionId,
      cols,
      rows,
    })
    if (!response.ok) {
      throw new Error((response as ErrorResponse).error || 'resize failed')
    }
  }

  /**
   * Kill a PTY session.
   */
  async kill(sessionId: string): Promise<void> {
    this.sessionCallbacks.delete(sessionId)
    const response = await this.sendCommand({
      cmd: 'kill',
      sessionId,
    })
    if (!response.ok) {
      throw new Error((response as ErrorResponse).error || 'kill failed')
    }
  }

  /**
   * List all active sessions on the daemon.
   */
  async list(): Promise<SessionListItem[]> {
    const response = await this.sendCommand({ cmd: 'list' })
    if (!response.ok) {
      throw new Error((response as ErrorResponse).error || 'list failed')
    }
    return (response as ListResponse).sessions
  }

  /**
   * Disconnect from the daemon. The daemon keeps running.
   */
  async disconnect(): Promise<void> {
    // Detach from all sessions
    for (const sessionId of Array.from(this.sessionCallbacks.keys())) {
      try {
        await this.detach(sessionId)
      } catch {
        // Best-effort
      }
    }
    this.sessionCallbacks.clear()
    this.cleanup()
  }

  /**
   * Whether the client is currently connected to the daemon.
   */
  get isConnected(): boolean {
    return this.connected
  }

  // ── Private methods ──

  private async isDaemonRunning(): Promise<boolean> {
    // Check PID file
    try {
      if (!fs.existsSync(PID_FILE_PATH)) return false
      const pidStr = fs.readFileSync(PID_FILE_PATH, 'utf-8').trim()
      const pid = parseInt(pidStr, 10)
      if (isNaN(pid)) return false

      // Check if process exists (signal 0 doesn't kill, just checks)
      process.kill(pid, 0)
    } catch {
      return false
    }

    // Also verify we can connect and ping
    try {
      const pong = await this.pingDirect()
      return pong
    } catch {
      return false
    }
  }

  private pingDirect(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = net.createConnection(SOCKET_PATH)
      let buf = ''
      const timer = setTimeout(() => {
        sock.destroy()
        resolve(false)
      }, 2000)

      sock.on('connect', () => {
        sock.write(serializeMessage({ cmd: 'ping' }))
      })

      sock.on('data', (chunk) => {
        buf += chunk.toString()
        const { messages } = parseMessages(buf)
        for (const msg of messages) {
          if (msg.ok && typeof msg.pid === 'number') {
            clearTimeout(timer)
            sock.destroy()
            resolve(true)
            return
          }
        }
      })

      sock.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
  }

  private async startDaemon(): Promise<void> {
    fs.mkdirSync(DEVDOCK_DIR_PATH, { recursive: true })

    // Clean up stale socket file if it exists
    try {
      if (fs.existsSync(SOCKET_PATH)) {
        fs.unlinkSync(SOCKET_PATH)
      }
    } catch {
      // Ignore
    }

    const entryPath = this.getDaemonEntryPath()

    // Spawn the daemon as a detached process that survives parent exit
    const child = spawn(process.execPath, [entryPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    })
    child.unref()

    // Wait for daemon to start by polling for the socket
    const deadline = Date.now() + DAEMON_STARTUP_WAIT_MS
    while (Date.now() < deadline) {
      if (fs.existsSync(SOCKET_PATH)) {
        // Give it a moment to start listening
        await this.sleep(100)
        if (await this.pingDirect()) {
          return
        }
      }
      await this.sleep(DAEMON_STARTUP_POLL_INTERVAL_MS)
    }

    throw new Error('Daemon failed to start within timeout')
  }

  private getDaemonEntryPath(): string {
    const base = path.join(__dirname, 'daemon-entry')
    if (fs.existsSync(base + '.js')) return base + '.js'
    if (fs.existsSync(base + '.ts')) return base + '.ts'
    return base + '.js'
  }

  private async connectSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Connection timeout'))
        this.socket?.destroy()
      }, CONNECT_TIMEOUT_MS)

      this.socket = net.createConnection(SOCKET_PATH)

      this.socket.on('connect', () => {
        clearTimeout(timer)
        this.connected = true
        this.reconnectAttempts = 0
        this.buffer = ''
        resolve()
      })

      this.socket.on('data', (chunk: Buffer) => {
        this.handleData(chunk)
      })

      this.socket.on('close', () => {
        this.connected = false
        this.rejectAllPending(new Error('Socket closed'))
        this.attemptReconnect()
      })

      this.socket.on('error', (err) => {
        clearTimeout(timer)
        if (!this.connected) {
          reject(err)
        }
        // If already connected, close handler will handle reconnect
      })
    })
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString()
    const { messages, remainder } = parseMessages(this.buffer)
    this.buffer = remainder

    for (const msg of messages) {
      if (this.isEvent(msg)) {
        this.dispatchEvent(msg as DaemonEvent)
      } else {
        this.resolveNextPending(msg as DaemonResponse)
      }
    }
  }

  private isEvent(msg: any): boolean {
    return typeof msg.event === 'string'
  }

  private dispatchEvent(event: DaemonEvent): void {
    const callbacks = this.sessionCallbacks.get(event.sessionId)
    if (!callbacks) return

    switch (event.event) {
      case 'data':
        if (callbacks.onData) {
          const decoded = Buffer.from(event.data, 'base64').toString('binary')
          callbacks.onData(decoded)
        }
        break
      case 'exit':
        if (callbacks.onExit) {
          callbacks.onExit(event.exitCode)
        }
        // Auto-cleanup callbacks on exit
        this.sessionCallbacks.delete(event.sessionId)
        break
      case 'error':
        if (callbacks.onError) {
          callbacks.onError(event.message)
        }
        break
    }
  }

  private resolveNextPending(msg: DaemonResponse): void {
    // Resolve the oldest pending request (FIFO — commands are processed in order)
    const entries = Array.from(this.pendingRequests.entries())
    if (entries.length > 0) {
      const [id, pending] = entries[0]
      clearTimeout(pending.timer)
      this.pendingRequests.delete(id)
      pending.resolve(msg)
    }
  }

  private rejectAllPending(err: Error): void {
    Array.from(this.pendingRequests.values()).forEach((pending) => {
      clearTimeout(pending.timer)
      pending.reject(err)
    })
    this.pendingRequests.clear()
  }

  private async sendCommand(cmd: DaemonCommand): Promise<DaemonResponse> {
    if (!this.connected || !this.socket) {
      throw new Error('Not connected to daemon')
    }

    return new Promise<DaemonResponse>((resolve, reject) => {
      const id = ++this.requestId
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Command timeout: ${cmd.cmd}`))
      }, COMMAND_TIMEOUT_MS)

      this.pendingRequests.set(id, { resolve, reject, timer })
      this.socket!.write(serializeMessage(cmd))
    })
  }

  private async attemptReconnect(): Promise<void> {
    if (this.reconnecting) return
    if (this.reconnectAttempts >= MAX_RECONNECT_RETRIES) {
      return
    }

    this.reconnecting = true
    this.reconnectAttempts++

    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1)

    await this.sleep(delay)

    try {
      await this.ensureDaemon()
      await this.connectSocket()

      // Re-attach to all sessions we were tracking
      for (const [sessionId] of Array.from(this.sessionCallbacks.entries())) {
        try {
          await this.sendCommand({ cmd: 'attach', sessionId })
        } catch {
          // Session may no longer exist
          this.sessionCallbacks.delete(sessionId)
        }
      }
    } catch {
      // Reconnect failed — will be tried again on next operation
    } finally {
      this.reconnecting = false
    }
  }

  private cleanup(): void {
    if (this.socket) {
      this.socket.removeAllListeners()
      this.socket.destroy()
      this.socket = null
    }
    this.connected = false
    this.buffer = ''
    this.rejectAllPending(new Error('Client disconnected'))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
