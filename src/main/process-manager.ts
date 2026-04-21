import { ChildProcess, spawn, execSync } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { createServer } from 'net'
import { ProcessStatus, Project } from '../shared/types'

// Cache the shell PATH so we only resolve it once
let cachedShellPath: string | null = null

export function getShellPath(): string {
  if (cachedShellPath) return cachedShellPath

  const fallback = '/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'

  try {
    // Get the real PATH from the user's shell
    const result = execSync('/bin/zsh -ilc "echo $PATH"', {
      encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    cachedShellPath = result || fallback
  } catch {
    cachedShellPath = `${fallback}:${process.env.PATH || ''}`
  }

  return cachedShellPath
}

/**
 * Find a virtual environment activate script in the project directory.
 * Checks: venv, .venv, env, .env (only if it's a dir)
 */
function findVenvActivate(projectPath: string): string | null {
  const candidates = ['venv', '.venv', 'env']
  for (const dir of candidates) {
    const activate = join(projectPath, dir, 'bin', 'activate')
    if (existsSync(activate)) return activate
  }
  return null
}

export interface SystemPortInfo {
  port: number
  pid: number
  command: string
  cwd: string
}

/**
 * Check which ports are already in use on the system (macOS).
 * Returns a map of port -> process info for ports we care about.
 */
export function detectSystemPorts(portsToCheck: number[]): Map<number, SystemPortInfo> {
  const result = new Map<number, SystemPortInfo>()
  if (portsToCheck.length === 0) return result

  try {
    // Use lsof to find listening TCP ports
    const output = execSync(
      'lsof -iTCP -sTCP:LISTEN -nP 2>/dev/null || true',
      { encoding: 'utf-8', timeout: 5000 }
    )

    const portSet = new Set(portsToCheck)

    for (const line of output.split('\n')) {
      // Parse lines like: node    12345 user   22u  IPv4 ... TCP *:3000 (LISTEN)
      const match = line.match(/^(\S+)\s+(\d+)\s+.*:(\d+)\s+\(LISTEN\)/)
      if (match) {
        const port = parseInt(match[3])
        if (portSet.has(port)) {
          const pid = parseInt(match[2])
          // Try to get the process cwd for better project matching
          let cwd = ''
          try {
            const lsofOut = execSync(`lsof -p ${pid} -Fn 2>/dev/null || true`, {
              encoding: 'utf-8', timeout: 3000
            })
            const lines = lsofOut.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (lines[i] === 'fcwd' && lines[i + 1]?.startsWith('n')) {
                cwd = lines[i + 1].slice(1) // remove 'n' prefix
                break
              }
            }
          } catch { /* ignore */ }
          result.set(port, {
            port,
            pid,
            command: match[1],
            cwd
          })
        }
      }
    }
  } catch { /* ignore - best effort */ }

  return result
}

/**
 * Kill a system process by PID.
 */
export function killSystemProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGTERM')
    return true
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
      return true
    } catch {
      return false
    }
  }
}

interface ManagedProcess {
  process: ChildProcess
  projectId: string
  port: number
  portConfirmed: boolean
  logs: string[]
  startedAt: string
}

const MAX_LOG_LINES = 500

/**
 * Build the actual shell command with port override based on framework.
 * Different frameworks need different mechanisms to override the port:
 * - Next.js: `next dev --port XXXX`
 * - Vite: uses PORT env var or `--port XXXX`
 * - Express/Node: uses PORT env var
 * - Flask: uses --port or PORT env var
 * - FastAPI/uvicorn: uses --port
 * - Streamlit: uses --server.port
 */
function buildCommand(runCommand: string, assignedPort: number, techStack: string[]): string {
  const isNext = techStack.includes('Next.js')
  const isVite = techStack.includes('Vite')
  const isFlask = techStack.includes('Flask')
  const isFastAPI = techStack.includes('FastAPI')
  const isStreamlit = runCommand.includes('streamlit')

  // For Next.js: append --port flag
  if (isNext) {
    if (runCommand.includes('next')) {
      const cleaned = runCommand.replace(/\s+--port\s+\d+/, '')
      return `${cleaned} --port ${assignedPort}`
    }
    // npm run dev -- --port passes through to next dev
    return `${runCommand} -- --port ${assignedPort}`
  }

  // For Vite: append --port flag (more reliable than env var)
  if (isVite && (runCommand === 'npm run dev' || runCommand.includes('vite'))) {
    return `${runCommand} -- --port ${assignedPort}`
  }

  // For Streamlit
  if (isStreamlit) {
    const cleaned = runCommand.replace(/\s+--server\.port\s+\d+/, '')
    return `${cleaned} --server.port ${assignedPort}`
  }

  // For Flask with python command
  if (isFlask && runCommand.startsWith('python')) {
    return `${runCommand} --port ${assignedPort}`
  }

  // For FastAPI/uvicorn
  if (isFastAPI && runCommand.startsWith('python')) {
    return runCommand
  }

  // Default: rely on PORT env var (works for Express, most Node servers)
  return runCommand
}

class ProcessManager {
  private processes = new Map<string, ManagedProcess>()
  private mainWindow: BrowserWindow | null = null

  setMainWindow(win: BrowserWindow) {
    this.mainWindow = win
  }

  async findFreePort(preferredPort: number): Promise<number> {
    // Check if any managed process is already using this port
    for (const [, proc] of this.processes) {
      if (proc.port === preferredPort) {
        return this.findFreePort(preferredPort + 1)
      }
    }

    return new Promise((resolve) => {
      const server = createServer()
      server.listen(preferredPort, '127.0.0.1', () => {
        server.close(() => resolve(preferredPort))
      })
      server.on('error', () => {
        resolve(this.findFreePort(preferredPort + 1))
      })
    })
  }

  async startProject(project: Project): Promise<ProcessStatus> {
    // Already running?
    if (this.processes.has(project.id)) {
      const existing = this.processes.get(project.id)!
      return {
        projectId: project.id,
        running: true,
        pid: existing.process.pid ?? null,
        port: existing.port,
        logs: existing.logs
      }
    }

    if (!project.runCommand) {
      return {
        projectId: project.id,
        running: false,
        pid: null,
        port: null,
        logs: ['No run command configured']
      }
    }

    const preferredPort = project.port || 3000
    const assignedPort = await this.findFreePort(preferredPort)
    const portChanged = assignedPort !== preferredPort

    const env = {
      ...process.env,
      PATH: getShellPath(),
      PORT: String(assignedPort),
      BROWSER: 'none' // Prevent auto-opening browser
    }

    // Build command with proper port override for the framework
    let actualCommand = buildCommand(project.runCommand, assignedPort, project.techStack)

    // Auto-activate virtual environment if one exists
    const venvActivate = findVenvActivate(project.path)
    if (venvActivate) {
      actualCommand = `source "${venvActivate}" && ${actualCommand}`
    }

    const child = spawn('/bin/zsh', ['-l', '-c', actualCommand], {
      cwd: project.path,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const initialLogs: string[] = []
    if (portChanged) {
      initialLogs.push(`[DevHub-AI] Port ${preferredPort} was busy, reassigned to ${assignedPort}`)
    }
    initialLogs.push(`[DevHub-AI] Running: ${actualCommand}`)
    initialLogs.push(`[DevHub-AI] Port: ${assignedPort} | PID: ${child.pid}`)

    const managed: ManagedProcess = {
      process: child,
      projectId: project.id,
      port: assignedPort,
      portConfirmed: false,
      logs: [...initialLogs],
      startedAt: new Date().toISOString()
    }

    // Send initial logs to renderer
    for (const line of initialLogs) {
      this.mainWindow?.webContents.send('process-log', { projectId: project.id, line })
    }

    const appendLog = (line: string) => {
      // Try to detect the actual port from log output (some frameworks ignore env/flags)
      if (!managed.portConfirmed) {
        const portPatterns = [
          /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{3,5})/,
          /port\s+(\d{3,5})/i,
          /on\s+(\d{3,5})/
        ]
        for (const pattern of portPatterns) {
          const match = line.match(pattern)
          if (match) {
            const detectedPort = parseInt(match[1])
            if (detectedPort !== managed.port && detectedPort > 1000) {
              appendLog(`[DevHub-AI] Detected actual port: ${detectedPort} (expected ${managed.port})`)
              managed.port = detectedPort
              this.emitStatus(project.id, true, child.pid ?? null, detectedPort, managed.logs)
            }
            managed.portConfirmed = true
            break
          }
        }
      }
      managed.logs.push(line)
      if (managed.logs.length > MAX_LOG_LINES) {
        managed.logs.shift()
      }
      this.mainWindow?.webContents.send('process-log', {
        projectId: project.id,
        line
      })
    }

    child.stdout?.on('data', (data: Buffer) => {
      data.toString().split('\n').filter(Boolean).forEach(appendLog)
    })

    child.stderr?.on('data', (data: Buffer) => {
      data.toString().split('\n').filter(Boolean).forEach(appendLog)
    })

    child.on('exit', (code) => {
      appendLog(`Process exited with code ${code}`)
      this.processes.delete(project.id)
      this.emitStatus(project.id, false, null, assignedPort, managed.logs)
    })

    child.on('error', (err) => {
      appendLog(`Process error: ${err.message}`)
      this.processes.delete(project.id)
      this.emitStatus(project.id, false, null, assignedPort, managed.logs)
    })

    this.processes.set(project.id, managed)

    const status: ProcessStatus = {
      projectId: project.id,
      running: true,
      pid: child.pid ?? null,
      port: assignedPort,
      logs: managed.logs
    }

    this.emitStatus(project.id, true, child.pid ?? null, assignedPort, managed.logs)
    return status
  }

  stopProject(projectId: string): boolean {
    const managed = this.processes.get(projectId)
    if (!managed) return false

    try {
      // Kill the process group
      if (managed.process.pid) {
        process.kill(-managed.process.pid, 'SIGTERM')
      }
    } catch {
      try {
        managed.process.kill('SIGTERM')
      } catch { /* already dead */ }
    }

    this.processes.delete(projectId)
    this.emitStatus(projectId, false, null, managed.port, managed.logs)
    return true
  }

  getAllStatuses(): ProcessStatus[] {
    const statuses: ProcessStatus[] = []
    for (const [projectId, managed] of this.processes) {
      statuses.push({
        projectId,
        running: true,
        pid: managed.process.pid ?? null,
        port: managed.port,
        logs: managed.logs
      })
    }
    return statuses
  }

  getLogs(projectId: string): string[] {
    return this.processes.get(projectId)?.logs ?? []
  }

  private emitStatus(projectId: string, running: boolean, pid: number | null, port: number | null, logs: string[]) {
    this.mainWindow?.webContents.send('process-status-changed', {
      projectId,
      running,
      pid,
      port,
      logs
    } satisfies ProcessStatus)
  }

  stopAll() {
    for (const [id] of this.processes) {
      this.stopProject(id)
    }
  }
}

export const processManager = new ProcessManager()
