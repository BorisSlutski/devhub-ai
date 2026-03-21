/**
 * PTY Subprocess — runs as a forked Node.js child process.
 *
 * Each instance owns a single node-pty terminal. It communicates with the
 * parent daemon process via IPC (`process.send` / `process.on('message')`).
 *
 * Lifecycle:
 *   1. Parent sends { type: 'start', options } to create the PTY.
 *   2. PTY output is forwarded as { type: 'data', data } (base64).
 *   3. Parent can send 'write', 'resize', 'signal', 'kill' commands.
 *   4. On PTY exit, sends { type: 'exit', exitCode } and self-terminates.
 *   5. SIGTERM from parent triggers graceful shutdown.
 */

import type {
  SubprocessInbound,
  SubprocessOutbound,
  PtySpawnOptions,
} from './protocol'

// node-pty is a native module — use eval to prevent bundler from touching it.
// This is the same pattern used in the main pty-manager.ts.
// eslint-disable-next-line no-eval
const pty: typeof import('node-pty') = eval("require('node-pty')")

let ptyProcess: any = null
let exited = false

function send(msg: SubprocessOutbound): void {
  if (process.send) {
    process.send(msg)
  }
}

function spawnPty(options: PtySpawnOptions): void {
  try {
    ptyProcess = pty.spawn(options.shell, ['-i'], {
      name: 'xterm-256color',
      cols: options.cols,
      rows: options.rows,
      cwd: options.cwd,
      env: options.env,
    })
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    send({ type: 'error', message: `spawn failed: ${message}` })
    process.exit(1)
    return
  }

  ptyProcess.onData((data: string) => {
    // Encode to base64 for binary safety across JSON IPC
    const encoded = Buffer.from(data, 'binary').toString('base64')
    send({ type: 'data', data: encoded })
  })

  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    exited = true
    send({ type: 'exit', exitCode })
    // Give the parent a moment to receive the message before exiting
    setTimeout(() => process.exit(0), 100)
  })
}

function handleMessage(msg: SubprocessInbound): void {
  switch (msg.type) {
    case 'start':
      spawnPty(msg.options)
      break

    case 'write':
      if (ptyProcess && !exited) {
        const decoded = Buffer.from(msg.data, 'base64').toString('binary')
        ptyProcess.write(decoded)
      }
      break

    case 'resize':
      if (ptyProcess && !exited) {
        try {
          ptyProcess.resize(msg.cols, msg.rows)
        } catch {
          // Resize can fail if PTY is already closed
        }
      }
      break

    case 'signal':
      if (ptyProcess && !exited) {
        try {
          ptyProcess.kill(msg.signal)
        } catch {
          // Signal can fail if process is already dead
        }
      }
      break

    case 'kill':
      if (ptyProcess && !exited) {
        try {
          ptyProcess.kill()
        } catch {
          // Already dead
        }
      }
      // If PTY is already gone, just exit
      if (exited || !ptyProcess) {
        process.exit(0)
      }
      break
  }
}

// Listen for messages from parent daemon
process.on('message', (msg: SubprocessInbound) => {
  handleMessage(msg)
})

// Graceful shutdown on SIGTERM
process.on('SIGTERM', () => {
  if (ptyProcess && !exited) {
    try {
      ptyProcess.kill()
    } catch {
      // Already dead
    }
  }
  setTimeout(() => process.exit(0), 200)
})

// Prevent unhandled errors from crashing without notification
process.on('uncaughtException', (err) => {
  send({ type: 'error', message: `uncaught exception: ${err.message}` })
  process.exit(1)
})
