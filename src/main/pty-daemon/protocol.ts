/**
 * Shared protocol types for daemon <-> client communication.
 * Uses newline-delimited JSON over Unix socket with base64-encoded PTY data.
 */

import { join } from 'path'
import { homedir } from 'os'

// ── Socket & file paths ──

const DEVDOCK_DIR = join(homedir(), '.devdock')
export const SOCKET_PATH = join(DEVDOCK_DIR, 'daemon.sock')
export const PID_FILE_PATH = join(DEVDOCK_DIR, 'daemon.pid')
export const LOG_FILE_PATH = join(DEVDOCK_DIR, 'daemon.log')
export const DEVDOCK_DIR_PATH = DEVDOCK_DIR

// ── PTY subprocess options ──

export interface PtySpawnOptions {
  shell: string
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
}

// ── Commands (client -> daemon) ──

export interface CreateCommand {
  cmd: 'create'
  sessionId: string
  options: PtySpawnOptions
}

export interface AttachCommand {
  cmd: 'attach'
  sessionId: string
}

export interface DetachCommand {
  cmd: 'detach'
  sessionId: string
}

export interface WriteCommand {
  cmd: 'write'
  sessionId: string
  data: string // base64-encoded
}

export interface ResizeCommand {
  cmd: 'resize'
  sessionId: string
  cols: number
  rows: number
}

export interface KillCommand {
  cmd: 'kill'
  sessionId: string
}

export interface ListCommand {
  cmd: 'list'
}

export interface PingCommand {
  cmd: 'ping'
}

export interface ShutdownCommand {
  cmd: 'shutdown'
}

export type DaemonCommand =
  | CreateCommand
  | AttachCommand
  | DetachCommand
  | WriteCommand
  | ResizeCommand
  | KillCommand
  | ListCommand
  | PingCommand
  | ShutdownCommand

// ── Responses (daemon -> client, in reply to a command) ──

export interface OkResponse {
  ok: true
  sessionId?: string
}

export interface ErrorResponse {
  ok: false
  error: string
  sessionId?: string
}

export interface PingResponse {
  ok: true
  pid: number
  uptime: number
  sessionCount: number
}

export interface SessionListItem {
  sessionId: string
  pid: number | null
  createdAt: number
}

export interface ListResponse {
  ok: true
  sessions: SessionListItem[]
}

export type DaemonResponse = OkResponse | ErrorResponse | PingResponse | ListResponse

// ── Events (daemon -> client, asynchronous) ──

export interface DataEvent {
  event: 'data'
  sessionId: string
  data: string // base64-encoded
}

export interface ExitEvent {
  event: 'exit'
  sessionId: string
  exitCode: number
}

export interface ErrorEvent {
  event: 'error'
  sessionId: string
  message: string
}

export type DaemonEvent = DataEvent | ExitEvent | ErrorEvent

// ── Message is either a response or an event ──

export type DaemonMessage = DaemonResponse | DaemonEvent

// ── Subprocess IPC messages (daemon <-> forked pty-subprocess) ──

export interface SubprocessStartMessage {
  type: 'start'
  options: PtySpawnOptions
}

export interface SubprocessDataMessage {
  type: 'data'
  data: string // base64-encoded
}

export interface SubprocessExitMessage {
  type: 'exit'
  exitCode: number
}

export interface SubprocessErrorMessage {
  type: 'error'
  message: string
}

export interface SubprocessWriteMessage {
  type: 'write'
  data: string // base64-encoded
}

export interface SubprocessResizeMessage {
  type: 'resize'
  cols: number
  rows: number
}

export interface SubprocessSignalMessage {
  type: 'signal'
  signal: string
}

export interface SubprocessKillMessage {
  type: 'kill'
}

export type SubprocessInbound =
  | SubprocessStartMessage
  | SubprocessWriteMessage
  | SubprocessResizeMessage
  | SubprocessSignalMessage
  | SubprocessKillMessage

export type SubprocessOutbound =
  | SubprocessDataMessage
  | SubprocessExitMessage
  | SubprocessErrorMessage

// ── Serialization helpers ──

/** Encode a string (PTY output) to base64 for safe JSON transport. */
export function encodeData(raw: string): string {
  return Buffer.from(raw, 'binary').toString('base64')
}

/** Decode base64 back to a binary string. */
export function decodeData(b64: string): string {
  return Buffer.from(b64, 'base64').toString('binary')
}

/** Serialize a message to a newline-delimited JSON string. */
export function serializeMessage(msg: DaemonCommand | DaemonMessage): string {
  return JSON.stringify(msg) + '\n'
}

/**
 * Parse a newline-delimited JSON buffer, returning parsed messages
 * and any remaining incomplete data.
 */
export function parseMessages(buffer: string): { messages: any[]; remainder: string } {
  const messages: any[] = []
  let remainder = buffer

  while (true) {
    const newlineIdx = remainder.indexOf('\n')
    if (newlineIdx === -1) break

    const line = remainder.slice(0, newlineIdx).trim()
    remainder = remainder.slice(newlineIdx + 1)

    if (line.length === 0) continue

    try {
      messages.push(JSON.parse(line))
    } catch {
      // Malformed line — skip it
    }
  }

  return { messages, remainder }
}
