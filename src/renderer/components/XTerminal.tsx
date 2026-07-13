import React, { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './XTerminal.css'

interface Props {
  sessionId: string
  active: boolean
  onWaitingChange?: (waiting: boolean) => void
}

const DARK_THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#58a6ff',
  selectionBackground: '#264f78',
  black: '#0d1117',
  red: '#f85149',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#e6edf3',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
}

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#0969da',
  selectionBackground: '#b6e3ff',
  black: '#1f2328',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#0969da',
  white: '#1f2328',
  brightBlack: '#656d76',
  brightRed: '#a40e26',
  brightGreen: '#2da44e',
  brightYellow: '#bf8700',
  brightBlue: '#0550ae',
  brightMagenta: '#6639ba',
  brightCyan: '#0550ae',
  brightWhite: '#ffffff',
}

function isLightAppTheme(): boolean {
  const theme = document.documentElement.getAttribute('data-theme')
  if (theme === 'light') return true
  if (theme === 'dark') return false
  return window.matchMedia('(prefers-color-scheme: light)').matches
}

function getXtermTheme() {
  return isLightAppTheme() ? LIGHT_THEME : DARK_THEME
}

/** Shell-escape a file path so spaces and special chars are safe for terminal paste */
function shellEscapePath(p: string): string {
  if (/^[a-zA-Z0-9._\-\/]+$/.test(p)) return p
  return "'" + p.replace(/'/g, "'\\''") + "'"
}

function shellEscapePaths(paths: string[]): string {
  return paths.map(shellEscapePath).join(' ')
}

function getFilePath(file: File): string {
  return (file as any).path || ''
}

async function handleImageFile(file: File, sessionId: string): Promise<string | null> {
  const buffer = await file.arrayBuffer()
  const result = await window.api.saveTempImage({
    name: file.name,
    data: Array.from(new Uint8Array(buffer)),
    sessionId,
  })
  return result.path || null
}

export function XTerminal({ sessionId, active, onWaitingChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const unsubDataRef = useRef<(() => void) | null>(null)
  const unsubExitRef = useRef<(() => void) | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const waitingRef = useRef(false)
  const onWaitingChangeRef = useRef(onWaitingChange)
  onWaitingChangeRef.current = onWaitingChange
  const activeRef = useRef(active)
  activeRef.current = active

  useEffect(() => {
    if (!containerRef.current) return

    let fontSize = 14
    const term = new Terminal({
      fontSize,
      fontFamily: "'JetBrains Mono', 'SF Mono', 'Menlo', monospace",
      lineHeight: 1.4,
      letterSpacing: 0.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      theme: getXtermTheme(),
      allowProposedApi: true,
      rightClickSelectsWord: true,
      scrollback: 10000,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitAddonRef.current = fitAddon
    // Helper to fit terminal while preserving scroll position
    // Skips fit if cols/rows haven't changed to prevent unnecessary redraws (flickering)
    let lastCols = term.cols
    let lastRows = term.rows
    const safeFit = () => {
      const dims = fitAddon.proposeDimensions()
      if (!dims) return
      if (dims.cols === lastCols && dims.rows === lastRows) return
      lastCols = dims.cols
      lastRows = dims.rows
      const buf = term.buffer.active
      const wasAtBottom = buf.viewportY >= buf.baseY
      fitAddon.fit()
      if (wasAtBottom) {
        term.scrollToBottom()
      }
    }

    // Register clickable link provider for URLs
    const urlRegex = /https?:\/\/[^\s)\]>"'`]+/g
    term.registerLinkProvider({
      provideLinks(bufferLineNumber: number, callback: (links: any[] | undefined) => void) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1)
        if (!line) { callback(undefined); return }
        const text = line.translateToString()
        const links: any[] = []
        let match
        urlRegex.lastIndex = 0
        while ((match = urlRegex.exec(text)) !== null) {
          const url = match[0]
          const startX = match.index + 1
          const endX = match.index + url.length + 1
          links.push({
            range: {
              start: { x: startX, y: bufferLineNumber },
              end: { x: endX, y: bufferLineNumber }
            },
            text: url,
            activate() {
              window.api.openInBrowser(url)
            }
          })
        }
        callback(links.length > 0 ? links : undefined)
      }
    })

    // Custom key handler for Cmd+C (copy) and Cmd+V (paste)
    // Only handle keydown to avoid duplicate processing on keyup
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true
      const isMeta = e.metaKey || e.ctrlKey

      // Cmd+C — let the browser handle native copy, just prevent xterm from sending ^C
      if (isMeta && e.key === 'c' && term.hasSelection()) {
        return false
      }

      // Cmd+V — let xterm handle paste natively (flows through onData → ptyWrite)
      if (isMeta && e.key === 'v') {
        return true
      }

      // Cmd+A — select all
      if (isMeta && e.key === 'a') {
        term.selectAll()
        return false
      }

      // Shift+Enter — insert newline via bracketed paste so Claude treats it as
      // a literal newline character rather than "submit", regardless of whether
      // kitty keyboard protocol is active. This works in all terminal apps.
      if (e.shiftKey && e.key === 'Enter') {
        window.api.ptyWrite(sessionId, '\x1b[200~\n\x1b[201~')
        return false
      }

      // Cmd+K — clear terminal
      if (isMeta && e.key === 'k') {
        term.clear()
        return false
      }

      // Cmd+= or Cmd++ — increase font size
      if (isMeta && (e.key === '=' || e.key === '+')) {
        fontSize = Math.min(28, fontSize + 1)
        term.options.fontSize = fontSize
        safeFit()
        return false
      }

      // Cmd+- — decrease font size
      if (isMeta && e.key === '-') {
        fontSize = Math.max(11, fontSize - 1)
        term.options.fontSize = fontSize
        safeFit()
        return false
      }

      // Cmd+0 — reset font size
      if (isMeta && e.key === '0') {
        fontSize = 14
        term.options.fontSize = fontSize
        safeFit()
        return false
      }

      return true
    })

    // Send input to PTY
    term.onData((data) => {
      window.api.ptyWrite(sessionId, data)
      // User sent input — clear waiting state
      if (waitingRef.current) {
        waitingRef.current = false
        onWaitingChangeRef.current?.(false)
      }
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    })

    // Receive output from PTY
    unsubDataRef.current = window.api.onPtyData(({ sessionId: sid, data }) => {
      if (sid === sessionId) {
        const buf = term.buffer.active
        const wasAtBottom = buf.viewportY >= buf.baseY

        if (!wasAtBottom) {
          // User has scrolled up — preserve their viewport position
          const savedY = buf.viewportY
          term.write(data, () => {
            term.scrollToLine(savedY)
          })
        } else {
          term.write(data)
        }

        // Reset idle timer — output means Claude is working
        if (waitingRef.current) {
          waitingRef.current = false
          onWaitingChangeRef.current?.(false)
        }
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
        idleTimerRef.current = setTimeout(() => {
          waitingRef.current = true
          onWaitingChangeRef.current?.(true)
        }, 8000) // 8s of silence = likely waiting for input
      }
    })

    // Handle PTY exit
    unsubExitRef.current = window.api.onPtyExit(({ sessionId: sid, exitCode }) => {
      if (sid === sessionId) {
        term.writeln(`\r\n\x1b[2m[session ended with code ${exitCode}]\x1b[0m`)
      }
    })

    // Handle resize
    term.onResize(({ cols, rows }) => {
      window.api.ptyResize(sessionId, cols, rows)
    })

    // Handle paste events — intercept on xterm's internal textarea to catch images
    // before xterm processes the paste
    const xtermTextarea = containerRef.current.querySelector('textarea.xterm-helper-textarea') as HTMLTextAreaElement | null
    const pasteTarget = xtermTextarea || containerRef.current

    const handlePaste = async (e: ClipboardEvent) => {
      if (!e.clipboardData) return

      // Check for image items in clipboard
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.type.startsWith('image/')) {
          e.preventDefault()
          e.stopImmediatePropagation()
          const file = item.getAsFile()
          if (!file) continue

          term.writeln('\r\n\x1b[33m[Saving image from clipboard...]\x1b[0m')
          const imagePath = await handleImageFile(file, sessionId)
          if (imagePath) {
            term.writeln(`\x1b[32m[Image saved: ${imagePath}]\x1b[0m`)
            window.api.ptyWrite(sessionId, imagePath)
          } else {
            term.writeln('\x1b[31m[Failed to save image]\x1b[0m')
          }
          return
        }
      }
      // Text paste — let xterm handle natively (flows through onData → ptyWrite)
    }

    // Handle drag and drop (for image files)
    const container = containerRef.current
    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy'
      }
      container?.classList.add('xterminal-dragover')
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      container?.classList.remove('xterminal-dragover')
    }

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      container?.classList.remove('xterminal-dragover')

      const files = Array.from(e.dataTransfer?.files || [])

      if (files.length > 0) {
        // Separate image files from non-image files
        const imageFiles: File[] = []
        const nonImagePaths: string[] = []

        for (const file of files) {
          if (file.type.startsWith('image/')) {
            imageFiles.push(file)
          } else {
            const filePath = getFilePath(file)
            if (filePath) nonImagePaths.push(filePath)
          }
        }

        // Handle image files — save and paste path
        for (const file of imageFiles) {
          term.writeln(`\r\n\x1b[33m[Saving dropped image: ${file.name}...]\x1b[0m`)
          const imagePath = await handleImageFile(file, sessionId)
          if (imagePath) {
            term.writeln(`\x1b[32m[Image saved: ${imagePath}]\x1b[0m`)
            window.api.ptyWrite(sessionId, imagePath)
          } else {
            term.writeln('\x1b[31m[Failed to save image]\x1b[0m')
          }
        }

        // Handle non-image files — shell-escape and paste paths
        if (nonImagePaths.length > 0) {
          window.api.ptyWrite(sessionId, shellEscapePaths(nonImagePaths))
        }
      } else {
        // No files — check for text/plain (e.g. path dragged from file explorer)
        const plainText = e.dataTransfer?.getData('text/plain')
        if (plainText) {
          window.api.ptyWrite(sessionId, shellEscapePaths([plainText]))
        }
      }
    }

    // Attach to xterm's textarea directly to intercept before xterm's own handler
    pasteTarget.addEventListener('paste', handlePaste, true)
    container?.addEventListener('dragover', handleDragOver)
    container?.addEventListener('dragleave', handleDragLeave)
    container?.addEventListener('drop', handleDrop)

    // ResizeObserver to fit terminal when container changes (debounced)
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (containerRef.current && containerRef.current.clientWidth > 0) {
          safeFit()
        }
      }, 80)
    })
    ro.observe(containerRef.current)

    const onFind = (e: KeyboardEvent) => {
      if (!activeRef.current) return
      const inThis = containerRef.current?.contains(document.activeElement)
        || document.activeElement?.classList.contains('xterm-helper-textarea')
      if (!inThis && document.activeElement?.closest('.xterminal-container') !== containerRef.current) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        const query = window.prompt('Find in terminal:')
        if (!query) return
        const needle = query.toLowerCase()
        const buf = term.buffer.active
        let foundLine = -1
        for (let i = buf.length - 1; i >= 0; i--) {
          const line = buf.getLine(i)
          if (line && line.translateToString(true).toLowerCase().includes(needle)) {
            foundLine = i
            break
          }
        }
        if (foundLine >= 0) {
          term.scrollToLine(Math.max(0, foundLine - 2))
        }
      }
    }
    window.addEventListener('keydown', onFind)

    const themeObserver = new MutationObserver(() => {
      term.options.theme = getXtermTheme()
    })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    return () => {
      themeObserver.disconnect()
      window.removeEventListener('keydown', onFind)
      ro.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      pasteTarget.removeEventListener('paste', handlePaste, true)
      container?.removeEventListener('dragover', handleDragOver)
      container?.removeEventListener('dragleave', handleDragLeave)
      container?.removeEventListener('drop', handleDrop)
      unsubDataRef.current?.()
      unsubExitRef.current?.()
      term.dispose()
      termRef.current = null
      fitAddonRef.current = null
    }
    // `active` is read via activeRef (see onFind) — including it here would tear down and
    // recreate the whole terminal (and its scrollback) on every focus toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  // Re-fit when tab becomes active
  useEffect(() => {
    if (active && fitAddonRef.current && termRef.current) {
      setTimeout(() => {
        const term = termRef.current
        const fitAddon = fitAddonRef.current
        if (!term || !fitAddon) return
        // Use proposeDimensions to skip no-op fits (prevents flicker)
        const dims = fitAddon.proposeDimensions()
        if (dims && (dims.cols !== term.cols || dims.rows !== term.rows)) {
          const buf = term.buffer.active
          const wasAtBottom = buf.viewportY >= buf.baseY
          fitAddon.fit()
          if (wasAtBottom) {
            term.scrollToBottom()
          }
        }
        term.focus()
      }, 50)
    }
  }, [active])

  return (
    <div
      ref={containerRef}
      className="xterminal-container"
    />
  )
}
