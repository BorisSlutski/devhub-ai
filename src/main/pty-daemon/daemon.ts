/**
 * PTY Daemon — standalone Node.js process that manages PTY sessions.
 *
 * Runs independently from Electron. Clients connect via Unix socket at
 * ~/.devdock/daemon.sock using newline-delimited JSON.
 *
 * Each PTY session is isolated in its own forked child process for
 * crash isolation and resource management.
 */

import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { fork, ChildProcess } from 'child_process'
import {
  SOCKET_PATH,
  PID_FILE_PATH,
  LOG_FILE_PATH,
  DEVDOCK_DIR_PATH,
  parseMessages,
  serializeMessage,
  type DaemonCommand,
  type DaemonMessage,
  type DaemonEvent,
  type SubprocessOutbound,
  type SessionListItem,
} from './protocol'

// ── Constants ──

const MAX_CONCURRENT_SPAWNS = 3

// ── Types ──

interface ManagedSession {
  sessionId: string
  subprocess: ChildProcess
  pid: number | null
  createdAt: number
  /** Set of connected client sockets currently attached to this session */
  attachedClients: Set<net.Socket>
}

// ── Logging ──

let logStream: fs.WriteStream | null = null

function initLogging(): void {
  fs.mkdirSync(DEVDOCK_DIR_PATH, { recursive: true })
  logStream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a' })
}

function log(level: string, msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] [${level}] ${msg}\n`
  if (logStream) {
    logStream.write(line)
  }
}

// ── Session management ──

const sessions = new Map<string, ManagedSession>()
let activeSpawnCount = 0
const spawnQueue: (() => void)[] = []

function acquireSpawnSlot(): Promise<void> {
  if (activeSpawnCount < MAX_CONCURRENT_SPAWNS) {
    activeSpawnCount++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    spawnQueue.push(() => {
      activeSpawnCount++
      resolve()
    })
  })
}

function releaseSpawnSlot(): void {
  activeSpawnCount--
  const next = spawnQueue.shift()
  if (next) next()
}

function getSubprocessPath(): string {
  // The subprocess file lives next to this daemon file.
  // In dev it's .ts, compiled it's .js — resolve whichever exists.
  const base = path.join(__dirname, 'pty-subprocess')
  if (fs.existsSync(base + '.js')) return base + '.js'
  if (fs.existsSync(base + '.ts')) return base + '.ts'
  return base + '.js'
}

async function createSession(
  sessionId: string,
  options: DaemonCommand & { cmd: 'create' }
): Promise<DaemonMessage> {
  // If session already exists, kill it first
  if (sessions.has(sessionId)) {
    destroySession(sessionId)
  }

  await acquireSpawnSlot()

  try {
    const subprocessPath = getSubprocessPath()
    log('info', `Forking subprocess for session ${sessionId}: ${subprocessPath}`)

    const child = fork(subprocessPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env },
    })

    const session: ManagedSession = {
      sessionId,
      subprocess: child,
      pid: child.pid ?? null,
      createdAt: Date.now(),
      attachedClients: new Set(),
    }

    // Handle messages from subprocess
    child.on('message', (msg: SubprocessOutbound) => {
      handleSubprocessMessage(sessionId, msg)
    })

    child.on('error', (err) => {
      log('error', `Subprocess error for session ${sessionId}: ${err.message}`)
      broadcastToAttached(sessionId, {
        event: 'error',
        sessionId,
        message: `subprocess error: ${err.message}`,
      })
    })

    child.on('exit', (code) => {
      log('info', `Subprocess exited for session ${sessionId} with code ${code}`)
      // If we haven't already broadcast exit from the PTY itself, do it now
      const s = sessions.get(sessionId)
      if (s) {
        broadcastToAttached(sessionId, {
          event: 'exit',
          sessionId,
          exitCode: code ?? 1,
        })
        sessions.delete(sessionId)
      }
      releaseSpawnSlot()
    })

    // Capture subprocess stdout/stderr to daemon log
    child.stdout?.on('data', (chunk: Buffer) => {
      log('subprocess-stdout', `[${sessionId}] ${chunk.toString().trim()}`)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      log('subprocess-stderr', `[${sessionId}] ${chunk.toString().trim()}`)
    })

    sessions.set(sessionId, session)

    // Tell subprocess to start the PTY
    child.send({ type: 'start', options: options.options })

    return { ok: true, sessionId }
  } catch (err: unknown) {
    releaseSpawnSlot()
    const message = err instanceof Error ? err.message : String(err)
    log('error', `Failed to create session ${sessionId}: ${message}`)
    return { ok: false, error: message, sessionId }
  }
}

function destroySession(sessionId: string): void {
  const session = sessions.get(sessionId)
  if (!session) return

  log('info', `Destroying session ${sessionId}`)
  try {
    session.subprocess.send({ type: 'kill' })
  } catch {
    // IPC channel may be closed
  }

  // Force kill after timeout
  setTimeout(() => {
    try {
      session.subprocess.kill('SIGKILL')
    } catch {
      // Already dead
    }
  }, 2000)

  sessions.delete(sessionId)
}

function handleSubprocessMessage(sessionId: string, msg: SubprocessOutbound): void {
  switch (msg.type) {
    case 'data':
      broadcastToAttached(sessionId, {
        event: 'data',
        sessionId,
        data: msg.data, // already base64
      })
      break

    case 'exit':
      broadcastToAttached(sessionId, {
        event: 'exit',
        sessionId,
        exitCode: msg.exitCode,
      })
      sessions.delete(sessionId)
      break

    case 'error':
      log('error', `PTY error for session ${sessionId}: ${msg.message}`)
      broadcastToAttached(sessionId, {
        event: 'error',
        sessionId,
        message: msg.message,
      })
      break
  }
}

function broadcastToAttached(sessionId: string, event: DaemonEvent): void {
  const session = sessions.get(sessionId)
  if (!session) return

  const serialized = serializeMessage(event)
  for (const client of Array.from(session.attachedClients)) {
    try {
      if (!client.destroyed) {
        client.write(serialized)
      }
    } catch {
      // Client disconnected
      session.attachedClients.delete(client)
    }
  }
}

// ── Command handling ──

async function handleCommand(
  cmd: DaemonCommand,
  client: net.Socket
): Promise<DaemonMessage> {
  switch (cmd.cmd) {
    case 'ping':
      return {
        ok: true,
        pid: process.pid,
        uptime: process.uptime(),
        sessionCount: sessions.size,
      }

    case 'create':
      return createSession(cmd.sessionId, cmd)

    case 'attach': {
      const session = sessions.get(cmd.sessionId)
      if (!session) {
        return { ok: false, error: `session ${cmd.sessionId} not found`, sessionId: cmd.sessionId }
      }
      session.attachedClients.add(client)
      log('info', `Client attached to session ${cmd.sessionId}`)
      return { ok: true, sessionId: cmd.sessionId }
    }

    case 'detach': {
      const session = sessions.get(cmd.sessionId)
      if (session) {
        session.attachedClients.delete(client)
        log('info', `Client detached from session ${cmd.sessionId}`)
      }
      return { ok: true, sessionId: cmd.sessionId }
    }

    case 'write': {
      const session = sessions.get(cmd.sessionId)
      if (!session) {
        return { ok: false, error: `session ${cmd.sessionId} not found`, sessionId: cmd.sessionId }
      }
      try {
        session.subprocess.send({ type: 'write', data: cmd.data })
      } catch {
        return { ok: false, error: 'subprocess IPC channel closed', sessionId: cmd.sessionId }
      }
      return { ok: true, sessionId: cmd.sessionId }
    }

    case 'resize': {
      const session = sessions.get(cmd.sessionId)
      if (!session) {
        return { ok: false, error: `session ${cmd.sessionId} not found`, sessionId: cmd.sessionId }
      }
      try {
        session.subprocess.send({ type: 'resize', cols: cmd.cols, rows: cmd.rows })
      } catch {
        return { ok: false, error: 'subprocess IPC channel closed', sessionId: cmd.sessionId }
      }
      return { ok: true, sessionId: cmd.sessionId }
    }

    case 'kill':
      destroySession(cmd.sessionId)
      return { ok: true, sessionId: cmd.sessionId }

    case 'list': {
      const list: SessionListItem[] = Array.from(sessions.values()).map((s) => ({
        sessionId: s.sessionId,
        pid: s.pid,
        createdAt: s.createdAt,
      }))
      return { ok: true, sessions: list }
    }

    case 'shutdown':
      log('info', 'Shutdown requested by client')
      gracefulShutdown()
      return { ok: true }

    default:
      return { ok: false, error: `unknown command: ${(cmd as any).cmd}` }
  }
}

// ── Client connection handling ──

function handleClientConnection(client: net.Socket): void {
  log('info', `Client connected from ${client.remoteAddress || 'local'}`)
  let buffer = ''

  client.on('data', async (chunk: Buffer) => {
    buffer += chunk.toString()
    const { messages, remainder } = parseMessages(buffer)
    buffer = remainder

    for (const msg of messages) {
      try {
        const response = await handleCommand(msg as DaemonCommand, client)
        if (!client.destroyed) {
          client.write(serializeMessage(response))
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err)
        log('error', `Error handling command: ${message}`)
        if (!client.destroyed) {
          client.write(serializeMessage({ ok: false, error: message }))
        }
      }
    }
  })

  client.on('close', () => {
    log('info', 'Client disconnected')
    // Remove this client from all session attachments
    Array.from(sessions.values()).forEach((session) => {
      session.attachedClients.delete(client)
    })
  })

  client.on('error', (err) => {
    log('error', `Client socket error: ${err.message}`)
  })
}

// ── Server lifecycle ──

let server: net.Server | null = null

function cleanupSocketFile(): void {
  try {
    if (fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH)
    }
  } catch {
    // Ignore cleanup errors
  }
}

function writePidFile(): void {
  fs.mkdirSync(DEVDOCK_DIR_PATH, { recursive: true })
  fs.writeFileSync(PID_FILE_PATH, String(process.pid), 'utf-8')
}

function cleanupPidFile(): void {
  try {
    if (fs.existsSync(PID_FILE_PATH)) {
      const storedPid = fs.readFileSync(PID_FILE_PATH, 'utf-8').trim()
      // Only remove if it's our PID
      if (storedPid === String(process.pid)) {
        fs.unlinkSync(PID_FILE_PATH)
      }
    }
  } catch {
    // Ignore
  }
}

function gracefulShutdown(): void {
  log('info', 'Graceful shutdown initiated')

  // Kill all subprocess sessions
  Array.from(sessions.keys()).forEach((sessionId) => {
    destroySession(sessionId)
  })

  // Close server
  if (server) {
    server.close()
    server = null
  }

  // Cleanup files
  cleanupSocketFile()
  cleanupPidFile()

  if (logStream) {
    logStream.end()
    logStream = null
  }

  // Allow pending I/O to flush
  setTimeout(() => process.exit(0), 500)
}

export function startDaemon(): void {
  initLogging()
  log('info', `Daemon starting, pid=${process.pid}`)

  // Ensure ~/.devdock exists
  fs.mkdirSync(DEVDOCK_DIR_PATH, { recursive: true })

  // Clean up stale socket file
  cleanupSocketFile()

  // Write PID file
  writePidFile()

  server = net.createServer(handleClientConnection)

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log('error', 'Socket path already in use. Attempting cleanup...')
      cleanupSocketFile()
      // Retry once
      setTimeout(() => {
        server?.listen(SOCKET_PATH, () => {
          log('info', `Daemon listening on ${SOCKET_PATH} (retry)`)
        })
      }, 200)
    } else {
      log('error', `Server error: ${err.message}`)
      process.exit(1)
    }
  })

  server.listen(SOCKET_PATH, () => {
    log('info', `Daemon listening on ${SOCKET_PATH}`)
    // Ensure socket file is accessible
    try {
      fs.chmodSync(SOCKET_PATH, 0o700)
    } catch {
      // Non-fatal
    }
  })

  // Signal handlers
  process.on('SIGTERM', gracefulShutdown)
  process.on('SIGINT', gracefulShutdown)

  process.on('uncaughtException', (err) => {
    log('error', `Uncaught exception: ${err.message}\n${err.stack}`)
    gracefulShutdown()
  })

  process.on('unhandledRejection', (reason) => {
    log('error', `Unhandled rejection: ${reason}`)
  })
}

// Export for testing
export {
  sessions,
  handleCommand,
  destroySession,
  gracefulShutdown,
  MAX_CONCURRENT_SPAWNS,
}
