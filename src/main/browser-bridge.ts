import { BrowserWindow, session } from 'electron'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

let server: ReturnType<typeof createServer> | null = null
let mainWindow: BrowserWindow | null = null
let bridgePort = 0

// One browser window per session
const browserWindows = new Map<string, BrowserWindow>()

export function setBrowserBridgeWindow(win: BrowserWindow) {
  mainWindow = win
}

function getOrCreateBrowserWindow(sessionId: string): BrowserWindow {
  let bw = browserWindows.get(sessionId)
  if (bw && !bw.isDestroyed()) return bw

  // Use a persistent partition so cookies/logins survive
  const ses = session.fromPartition('persist:devhub-ai-browser')

  bw = new BrowserWindow({
    width: 1024,
    height: 768,
    title: `DevHub-AI Browser — ${sessionId.slice(0, 12)}`,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  })

  bw.on('closed', () => {
    browserWindows.delete(sessionId)
    // Notify renderer that browser closed
    notifyRenderer(sessionId, 'browser-closed', {})
  })

  browserWindows.set(sessionId, bw)
  return bw
}

function notifyRenderer(sessionId: string, event: string, data: any) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('browser-event', { sessionId, event, data })
    }
  } catch { /* ignore */ }
}

async function executeCommand(sessionId: string, command: string, args: Record<string, any>): Promise<any> {
  const bw = getOrCreateBrowserWindow(sessionId)

  switch (command) {
    case 'open': {
      bw.show()
      bw.focus()
      return { status: 'opened' }
    }

    case 'close': {
      if (!bw.isDestroyed()) bw.close()
      browserWindows.delete(sessionId)
      return { status: 'closed' }
    }

    case 'navigate': {
      const url = normalizeUrl(args.url || '')
      if (!url) return { error: 'No URL provided' }
      bw.show()
      await bw.webContents.loadURL(url)
      notifyRenderer(sessionId, 'navigated', { url: bw.webContents.getURL(), title: bw.webContents.getTitle() })
      return { url: bw.webContents.getURL(), title: bw.webContents.getTitle() }
    }

    case 'screenshot': {
      const img = await bw.webContents.capturePage()
      const pngBuffer = img.toPNG()
      // Save to temp file so Claude can read it
      const tmpDir = join(homedir(), '.devhub-ai', 'tmp-images')
      mkdirSync(tmpDir, { recursive: true })
      const filePath = join(tmpDir, `browser-${sessionId.slice(0, 8)}-${Date.now()}.png`)
      writeFileSync(filePath, pngBuffer)
      // Also send to renderer for preview
      const dataUrl = img.toDataURL()
      notifyRenderer(sessionId, 'screenshot', { filePath, dataUrl })
      return { filePath, size: pngBuffer.length }
    }

    case 'click': {
      const selector = args.selector
      if (!selector) return { error: 'No selector provided' }
      try {
        const result = await bw.webContents.executeJavaScript(`
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { error: 'Element not found: ${selector.replace(/'/g, "\\'")}' };
            el.scrollIntoView({ block: 'center' });
            el.click();
            return { clicked: true, tag: el.tagName, text: (el.textContent || '').substring(0, 100) };
          })()
        `)
        return result
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }

    case 'type': {
      const selector = args.selector
      const text = args.text || ''
      if (!selector) return { error: 'No selector provided' }
      try {
        const result = await bw.webContents.executeJavaScript(`
          (function() {
            const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return { error: 'Element not found' };
            el.focus();
            el.value = ${JSON.stringify(text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { typed: true, value: el.value.substring(0, 100) };
          })()
        `)
        return result
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }

    case 'evaluate': {
      const code = args.code
      if (!code) return { error: 'No code provided' }
      try {
        const result = await bw.webContents.executeJavaScript(code)
        return { result: typeof result === 'object' ? JSON.stringify(result).substring(0, 10000) : String(result).substring(0, 10000) }
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }

    case 'getContent': {
      try {
        const html = await bw.webContents.executeJavaScript(`document.documentElement.outerHTML`)
        return { html: html.substring(0, 50000), length: html.length }
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }

    case 'getText': {
      try {
        const text = await bw.webContents.executeJavaScript(`document.body.innerText`)
        return { text: text.substring(0, 30000), length: text.length }
      } catch (err: unknown) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    }

    case 'getUrl': {
      return {
        url: bw.webContents.getURL(),
        title: bw.webContents.getTitle()
      }
    }

    case 'getConsole': {
      // We'd need to have been capturing — return info about console capture
      return { info: 'Console messages are forwarded to the DevHub-AI panel in real-time' }
    }

    case 'back': {
      if (bw.webContents.canGoBack()) {
        bw.webContents.goBack()
        return { status: 'navigated back' }
      }
      return { error: 'Cannot go back' }
    }

    case 'forward': {
      if (bw.webContents.canGoForward()) {
        bw.webContents.goForward()
        return { status: 'navigated forward' }
      }
      return { error: 'Cannot go forward' }
    }

    case 'reload': {
      bw.webContents.reload()
      return { status: 'reloading' }
    }

    default:
      return { error: `Unknown command: ${command}` }
  }
}

function normalizeUrl(input: string): string {
  let url = input.trim()
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  if (url.includes('.') && !url.includes(' ')) return 'https://' + url
  return `https://www.google.com/search?q=${encodeURIComponent(url)}`
}

export function startBrowserBridge(): Promise<number> {
  if (server) return Promise.resolve(bridgePort)

  return new Promise((resolve) => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      if (req.method === 'OPTIONS') {
        res.writeHead(200)
        res.end()
        return
      }

      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end(JSON.stringify({ error: 'Method not allowed' }))
        return
      }

      let body = ''
      for await (const chunk of req) {
        body += chunk
      }

      try {
        const { sessionId, command, args } = JSON.parse(body)
        if (!sessionId || !command) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'Missing sessionId or command' }))
          return
        }

        const result = await executeCommand(sessionId, command, args || {})
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result))
      } catch (err) {
        res.writeHead(400)
        res.end(JSON.stringify({ error: 'Invalid JSON or command failed' }))
      }
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (addr && typeof addr === 'object') {
        bridgePort = addr.port
        console.log(`[BrowserBridge] Listening on port ${bridgePort}`)
        writeBrowserHelper(bridgePort)
      }
      resolve(bridgePort)
    })
  })
}

export function getBridgePort(): number {
  return bridgePort
}

export function stopBrowserBridge() {
  // Close all browser windows
  for (const [, bw] of browserWindows) {
    if (!bw.isDestroyed()) bw.close()
  }
  browserWindows.clear()

  if (server) {
    server.close()
    server = null
  }
}

// IPC handlers called from renderer
export function openBrowserForSession(sessionId: string, url?: string) {
  const bw = getOrCreateBrowserWindow(sessionId)
  bw.show()
  if (url) {
    const normalized = normalizeUrl(url)
    if (normalized) bw.webContents.loadURL(normalized)
  }
}

export function closeBrowserForSession(sessionId: string) {
  const bw = browserWindows.get(sessionId)
  if (bw && !bw.isDestroyed()) bw.close()
  browserWindows.delete(sessionId)
}

export function isBrowserOpenForSession(sessionId: string): boolean {
  const bw = browserWindows.get(sessionId)
  return !!bw && !bw.isDestroyed()
}

function writeBrowserHelper(port: number) {
  const devhubAiDir = join(homedir(), '.devhub-ai')
  mkdirSync(devhubAiDir, { recursive: true })

  const scriptPath = join(devhubAiDir, 'browser')
  const script = `#!/bin/bash
# DevHub-AI Browser Control - use from Claude terminal sessions
# Usage: browser <command> [args...]

PORT=${port}
SESSION_ID="\${DEVHUB_AI_SESSION_ID}"

if [ -z "$SESSION_ID" ]; then
  echo "Error: DEVHUB_AI_SESSION_ID not set. Run this from a DevHub-AI Claude session." >&2
  exit 1
fi

CMD="$1"
shift

case "$CMD" in
  open)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"open\\",\\"args\\":{}}"
    ;;
  navigate|goto|go)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"navigate\\",\\"args\\":{\\"url\\":\\"$1\\"}}"
    ;;
  click)
    # Use python to JSON-encode the selector safely
    JSON_SEL=\$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "\$1")
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"click\\",\\"args\\":{\\"selector\\":\$JSON_SEL}}"
    ;;
  type)
    SELECTOR="\$1"
    shift
    TEXT="\$*"
    JSON_SEL=\$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "\$SELECTOR")
    JSON_TEXT=\$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "\$TEXT")
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"type\\",\\"args\\":{\\"selector\\":\$JSON_SEL,\\"text\\":\$JSON_TEXT}}"
    ;;
  screenshot|snap)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"screenshot\\",\\"args\\":{}}"
    ;;
  evaluate|eval|js)
    CODE="\$*"
    JSON_CODE=\$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "\$CODE")
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"evaluate\\",\\"args\\":{\\"code\\":\$JSON_CODE}}"
    ;;
  content|html)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"getContent\\",\\"args\\":{}}"
    ;;
  text)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"getText\\",\\"args\\":{}}"
    ;;
  url)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"getUrl\\",\\"args\\":{}}"
    ;;
  back)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"back\\",\\"args\\":{}}"
    ;;
  forward)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"forward\\",\\"args\\":{}}"
    ;;
  reload)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"reload\\",\\"args\\":{}}"
    ;;
  close)
    curl -s -X POST "http://127.0.0.1:$PORT" \\
      -H "Content-Type: application/json" \\
      -d "{\\"sessionId\\":\\"$SESSION_ID\\",\\"command\\":\\"close\\",\\"args\\":{}}"
    ;;
  *)
    echo "DevHub-AI Browser Control"
    echo ""
    echo "Commands:"
    echo "  open                        Open browser window"
    echo "  navigate <url>              Navigate to URL (aliases: goto, go)"
    echo "  screenshot                  Take screenshot & save to file (alias: snap)"
    echo "  click <css-selector>        Click an element"
    echo "  type <selector> <text>      Type text into input"
    echo "  evaluate <js-code>          Run JavaScript (aliases: eval, js)"
    echo "  text                        Get visible page text"
    echo "  content                     Get page HTML (alias: html)"
    echo "  url                         Get current URL and title"
    echo "  back / forward / reload     Navigation"
    echo "  close                       Close browser window"
    echo ""
    echo "Examples:"
    echo "  browser navigate https://localhost:3000"
    echo "  browser screenshot"
    echo "  browser click '#submit-btn'"
    echo "  browser type '#email' hello@test.com"
    echo "  browser text"
    echo "  browser eval 'document.title'"
    ;;
esac
echo ""
`
  writeFileSync(scriptPath, script, { mode: 0o755 })
}
