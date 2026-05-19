import { ipcMain } from 'electron'
import { join } from 'path'
import { readdirSync, statSync, mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { homedir } from 'os'
import { execFile } from 'child_process'
import { getShellPath } from '../process-manager'

export function registerMcpHandlers() {
  console.log('[MCP] registerMcpHandlers called')
  ipcMain.handle('mcp-get-config', (_event, projectPath?: string) => {
    const configs: { scope: string; path: string; servers: Record<string, any> }[] = []
    const home = homedir()

    const userFile = join(home, '.claude.json')
    try {
      if (existsSync(userFile)) {
        const data = JSON.parse(readFileSync(userFile, 'utf-8'))
        if (data.mcpServers && Object.keys(data.mcpServers).length > 0) {
          configs.push({ scope: 'user', path: userFile, servers: data.mcpServers })
        }
      }
    } catch { /* ignore */ }

    if (projectPath) {
      const projectFile = join(projectPath, '.mcp.json')
      try {
        if (existsSync(projectFile)) {
          const data = JSON.parse(readFileSync(projectFile, 'utf-8'))
          if (data.mcpServers && Object.keys(data.mcpServers).length > 0) {
            configs.push({ scope: 'project', path: projectFile, servers: data.mcpServers })
          }
        }
      } catch { /* ignore */ }
    }

    return configs
  })

  // Cache MCP status results to avoid running `claude mcp list` too frequently
  let mcpStatusCache: { results: Record<string, 'ok' | 'error' | 'warning' | 'unknown'>; timestamp: number } | null = null
  const MCP_CACHE_TTL = 15000 // 15 seconds
  let mcpStatusPending: Promise<Record<string, 'ok' | 'error' | 'warning' | 'unknown'>> | null = null

  function findClaudeBin(): string {
    const candidates = [
      join(homedir(), '.local', 'bin', 'claude'),
      '/usr/local/bin/claude',
      '/opt/homebrew/bin/claude',
    ]
    for (const p of candidates) {
      if (existsSync(p)) return p
    }
    return 'claude'
  }

  // Strip ANSI escape codes from output
  function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  }

  function runClaudeMcpList(): Promise<Record<string, 'ok' | 'error' | 'warning' | 'unknown'>> {
    return new Promise((resolve) => {
      const results: Record<string, 'ok' | 'error' | 'warning' | 'unknown'> = {}
      const claudeBin = findClaudeBin()

      const child = execFile(claudeBin, ['mcp', 'list'], {
        timeout: 30000,
        env: { ...process.env, PATH: getShellPath(), NO_COLOR: '1', TERM: 'dumb' },
      }, (err, stdout, stderr) => {
        // Combine stdout + stderr — claude may write to either
        const combined = stripAnsi((stdout || '') + '\n' + (stderr || ''))

        for (const line of combined.split('\n')) {
          const trimmed = line.trim()
          // Match: "name: ... - status_icon Status text"
          // The icon can be utf-8 checkmarks/crosses or ASCII chars after ANSI stripping
          const match = trimmed.match(/^([^:]+):\s+.+\s+-\s+(.+)$/)
          if (match) {
            const name = match[1].trim()
            const statusRaw = match[2].trim().toLowerCase()
            // Remove leading icon chars (✓✗!⚠ or similar)
            const statusText = statusRaw.replace(/^[^\w\s]+\s*/, '')
            if (statusText.includes('connected')) {
              results[name] = 'ok'
            } else if (statusText.includes('authentication') || statusText.includes('auth')) {
              results[name] = 'warning'
            } else {
              results[name] = 'error'
            }
          }
        }

        resolve(results)
      })

      // Safety: if child hangs, resolve with empty after timeout
      child.on('error', () => resolve(results))
    })
  }

  ipcMain.handle('mcp-check-status', async () => {
    console.log('[MCP] mcp-check-status called')
    // Return cached results if fresh enough
    if (mcpStatusCache && Date.now() - mcpStatusCache.timestamp < MCP_CACHE_TTL) {
      console.log('[MCP] returning cached:', JSON.stringify(mcpStatusCache.results))
      return mcpStatusCache.results
    }

    // Deduplicate concurrent requests — only one `claude mcp list` at a time
    if (!mcpStatusPending) {
      console.log('[MCP] spawning claude mcp list...')
      mcpStatusPending = runClaudeMcpList().then((results) => {
        console.log('[MCP] claude mcp list returned:', JSON.stringify(results))
        mcpStatusCache = { results, timestamp: Date.now() }
        mcpStatusPending = null
        return results
      })
    }

    return mcpStatusPending
  })

  ipcMain.handle('mcp-save-config', (_event, filePath: string, servers: Record<string, any>) => {
    try {
      let data: any = {}
      if (existsSync(filePath)) {
        data = JSON.parse(readFileSync(filePath, 'utf-8'))
      }
      data.mcpServers = servers
      mkdirSync(join(filePath, '..'), { recursive: true })
      writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('skills-list', (_event, projectPath?: string) => {
    const skills: { name: string; scope: string; path: string; description: string }[] = []
    const home = homedir()

    const scanDir = (dir: string, scope: string) => {
      try {
        if (!existsSync(dir)) return
        for (const entry of readdirSync(dir)) {
          const entryPath = join(dir, entry)
          const stat = statSync(entryPath)
          if (stat.isDirectory()) {
            const skillFile = join(entryPath, 'SKILL.md')
            if (existsSync(skillFile)) {
              const content = readFileSync(skillFile, 'utf-8').slice(0, 500)
              const descMatch = content.match(/description:\s*(.+)/i)
              skills.push({
                name: entry,
                scope,
                path: skillFile,
                description: descMatch ? descMatch[1].trim() : ''
              })
            }
          }
          if (stat.isFile() && entry.endsWith('.md')) {
            const content = readFileSync(entryPath, 'utf-8').slice(0, 200)
            skills.push({
              name: '/' + entry.replace(/\.md$/, ''),
              scope,
              path: entryPath,
              description: content.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))?.trim() || ''
            })
          }
        }
      } catch { /* ignore */ }
    }

    scanDir(join(home, '.claude', 'skills'), 'user')
    scanDir(join(home, '.claude', 'commands'), 'user')

    if (projectPath) {
      scanDir(join(projectPath, '.claude', 'skills'), 'project')
      scanDir(join(projectPath, '.claude', 'commands'), 'project')
    }

    return skills
  })

  ipcMain.handle('create-command', (_event, opts: { name: string; content: string; scope: 'user' | 'project'; projectPath?: string }) => {
    try {
      const home = homedir()
      const dir = opts.scope === 'user'
        ? join(home, '.claude', 'commands')
        : join(opts.projectPath || '', '.claude', 'commands')
      mkdirSync(dir, { recursive: true })
      const filename = opts.name.replace(/^\//, '').replace(/[^a-zA-Z0-9_-]/g, '-') + '.md'
      const filePath = join(dir, filename)
      if (existsSync(filePath)) {
        return { success: false, error: 'Command already exists' }
      }
      writeFileSync(filePath, opts.content, 'utf-8')
      return { success: true, path: filePath }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('delete-command', (_event, filePath: string) => {
    try {
      unlinkSync(filePath)
      return { success: true }
    } catch (err: unknown) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
