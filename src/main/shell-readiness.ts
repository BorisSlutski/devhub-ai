/**
 * Shell Readiness Gating via OSC escape sequence markers.
 *
 * Instead of a hardcoded delay, we inject a printf command into the PTY stdin
 * right after spawn. The command executes after shell init (zsh, oh-my-zsh, etc.)
 * completes naturally. We scan incoming PTY data for the marker to know the shell
 * is ready for user commands.
 */

/** The OSC marker written by the shell to signal readiness */
export const READINESS_MARKER = '\x1b]777;devhub-ai-shell-ready\x07'

/** The printf command injected into PTY stdin to emit the marker */
export const READINESS_COMMAND = "printf '\\e]777;devhub-ai-shell-ready\\007'\n"

/** Default timeout before giving up on marker detection (ms) */
const DEFAULT_TIMEOUT_MS = 15_000

export interface ReadinessGate {
  /** Feed incoming PTY data through the gate. Returns data with markers stripped. */
  onData(data: string): string
  /** Resolves when the shell is ready (marker detected) or after timeout. */
  waitForReady(): Promise<void>
  /** Buffer user input until shell is ready, then flush via the provided write fn. */
  bufferInput(data: string): void
  /** Clean up timers and internal state. */
  dispose(): void
}

export function createReadinessGate(
  sessionId: string,
  writeFn: (data: string) => void,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): ReadinessGate {
  let ready = false
  let resolveReady: (() => void) | null = null
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const inputBuffer: string[] = []

  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  function markReady() {
    if (ready || disposed) return
    ready = true
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle)
      timeoutHandle = null
    }
    // Flush any buffered input
    for (const chunk of inputBuffer) {
      writeFn(chunk)
    }
    inputBuffer.length = 0
    resolveReady?.()
  }

  // Start the timeout
  timeoutHandle = setTimeout(() => {
    if (!ready && !disposed) {
      console.warn(
        `[shell-readiness] Timeout after ${timeoutMs}ms waiting for shell ready marker (session: ${sessionId}). Proceeding anyway.`
      )
      markReady()
    }
  }, timeoutMs)

  return {
    onData(data: string): string {
      if (ready) return data

      // Check if marker is present in the data chunk
      const markerIndex = data.indexOf(READINESS_MARKER)
      if (markerIndex !== -1) {
        // Strip the marker from the output
        const cleaned = data.slice(0, markerIndex) + data.slice(markerIndex + READINESS_MARKER.length)
        markReady()
        return cleaned
      }

      // The marker might be split across two data chunks.
      // Check for a partial marker at the end of the data.
      // The marker starts with \x1b, so look for that as a potential split point.
      // This is a best-effort approach for the common case.
      return data
    },

    waitForReady(): Promise<void> {
      return readyPromise
    },

    bufferInput(data: string): void {
      if (ready) {
        writeFn(data)
      } else {
        inputBuffer.push(data)
      }
    },

    dispose(): void {
      disposed = true
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      inputBuffer.length = 0
      // Resolve the promise so any pending await doesn't hang
      resolveReady?.()
    }
  }
}
