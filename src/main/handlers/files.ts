import { ipcMain } from 'electron'
import { join } from 'path'
import { readdirSync, statSync, readFileSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export function registerFileHandlers() {
  ipcMain.handle('list-directory', async (_event, dirPath: string) => {
    try {
      const entries = readdirSync(dirPath)
      const items: { name: string; path: string; isDir: boolean; size: number }[] = []
      for (const entry of entries) {
        if (entry.startsWith('.') && entry !== '.env') continue
        if (entry === 'node_modules' || entry === '__pycache__' || entry === '.git') continue
        const fullPath = join(dirPath, entry)
        try {
          const stat = statSync(fullPath)
          items.push({
            name: entry,
            path: fullPath,
            isDir: stat.isDirectory(),
            size: stat.size
          })
        } catch { continue }
      }
      items.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      return items
    } catch {
      return []
    }
  })

  ipcMain.handle('find-files-by-name', async (_event, rootPath: string, query: string) => {
    try {
      const raw = query.toLowerCase().trim()
      const isAbsoluteQuery = raw.startsWith('/')
      const results: { name: string; path: string; relativePath: string; isDir: boolean }[] = []
      const ignoreDirs = new Set(['node_modules', '.git', '.next', '.cache', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache'])
      const MAX = 300
      const MAX_DEPTH = 12

      // For absolute paths, resolve the deepest existing directory to walk from
      let walkRoot = rootPath
      let q = raw
      let isPathQuery = raw.includes('/')

      if (isAbsoluteQuery && raw.length > 1) {
        const segments = raw.slice(1).split('/').filter(Boolean)
        let bestRoot = '/'
        let consumed = 0
        for (let i = segments.length; i > 0; i--) {
          const candidate = '/' + segments.slice(0, i).join('/')
          try {
            const s = statSync(candidate)
            if (s.isDirectory()) { bestRoot = candidate; consumed = i; break }
          } catch { continue }
        }
        walkRoot = bestRoot
        q = segments.slice(consumed).join('/').toLowerCase()
        isPathQuery = q.includes('/')
      }

      const walk = (dir: string, depth: number) => {
        if (depth > MAX_DEPTH || results.length >= MAX) return
        try {
          const entries = readdirSync(dir)
          for (const entry of entries) {
            if (results.length >= MAX) return
            if (entry === '.DS_Store') continue
            const fullPath = join(dir, entry)
            try {
              const s = statSync(fullPath)
              const isDir = s.isDirectory()
              if (isDir && ignoreDirs.has(entry)) continue
              const rel = fullPath.replace(walkRoot + '/', '')
              const relLower = rel.toLowerCase()

              let matches = false
              if (!q) {
                matches = true
              } else if (isPathQuery) {
                matches = relLower.startsWith(q) || relLower.includes(q)
              } else {
                matches = entry.toLowerCase().includes(q) || relLower.includes(q)
              }

              if (matches) {
                // Return absolute paths for absolute queries so Claude can reference them correctly
                const relativePath = isAbsoluteQuery ? fullPath : rel
                results.push({ name: entry, path: fullPath, relativePath, isDir })
              }
              if (isDir) walk(fullPath, depth + 1)
            } catch { continue }
          }
        } catch { /* skip */ }
      }

      walk(walkRoot, 0)

      if (q) {
        results.sort((a, b) => {
          const al = a.relativePath.toLowerCase(), bl = b.relativePath.toLowerCase()
          if (isPathQuery) {
            const aStarts = al.startsWith(q) ? 0 : 1
            const bStarts = bl.startsWith(q) ? 0 : 1
            if (aStarts !== bStarts) return aStarts - bStarts
            if (a.isDir !== b.isDir) return a.isDir ? 1 : -1
            return al.length - bl.length
          }
          const anl = a.name.toLowerCase(), bnl = b.name.toLowerCase()
          const aExact = anl === q ? 0 : 1
          const bExact = bnl === q ? 0 : 1
          if (aExact !== bExact) return aExact - bExact
          const aStarts = anl.startsWith(q) ? 0 : 1
          const bStarts = bnl.startsWith(q) ? 0 : 1
          if (aStarts !== bStarts) return aStarts - bStarts
          if (a.isDir !== b.isDir) return a.isDir ? 1 : -1
          return a.relativePath.split('/').length - b.relativePath.split('/').length
        })
      }

      return results.slice(0, 30)
    } catch {
      return []
    }
  })

  ipcMain.handle('search-files', async (_event, rootPath: string, query: string) => {
    try {
      const { stdout } = await execAsync(
        `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.json' --include='*.css' --include='*.html' --include='*.md' --include='*.py' --include='*.go' --include='*.rs' --include='*.yaml' --include='*.yml' --include='*.toml' --include='*.sh' --include='*.sql' --include='*.graphql' --include='*.env' --include='*.txt' -l -- ${JSON.stringify(query)} ${JSON.stringify(rootPath)}`,
        { encoding: 'utf-8', timeout: 10000, maxBuffer: 1024 * 1024 }
      )
      const files = stdout.trim().split('\n').filter(Boolean).slice(0, 50)
      const results: { file: string; relativePath: string; matches: { line: number; text: string }[] }[] = []

      for (const file of files) {
        try {
          const { stdout: lines } = await execAsync(
            `grep -n -- ${JSON.stringify(query)} ${JSON.stringify(file)}`,
            { encoding: 'utf-8', timeout: 3000, maxBuffer: 256 * 1024 }
          )
          const matches = lines.trim().split('\n').filter(Boolean).slice(0, 10).map(l => {
            const colonIdx = l.indexOf(':')
            return {
              line: parseInt(l.substring(0, colonIdx), 10),
              text: l.substring(colonIdx + 1).substring(0, 200)
            }
          })
          results.push({
            file,
            relativePath: file.replace(rootPath + '/', ''),
            matches
          })
        } catch { continue }
      }
      return { results }
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 1) {
        return { results: [] }
      }
      return { results: [], error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('read-file', async (_event, filePath: string) => {
    try {
      const stat = statSync(filePath)
      if (stat.size > 500_000) return { error: 'File too large (>500KB)' }
      const content = readFileSync(filePath, 'utf-8')
      return { content }
    } catch (err: unknown) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
}
