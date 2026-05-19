import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'

export const ASTRONOMER_DAGS_REPO_SLUG = 'wix-private/wix-astronomer-dags'
export const ASTRONOMER_DAGS_REPO_NAME = 'wix-astronomer-dags'

export function isAstronomerDagsRepo(folderPath: string): boolean {
  const astroLocal = join(folderPath, 'astronomer-local')
  if (!existsSync(astroLocal)) return false

  try {
    const remote = execSync('git remote get-url origin', {
      cwd: folderPath,
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (remote.includes('wix-astronomer-dags')) return true
  } catch {
    /* not git or no origin */
  }

  return (
    existsSync(join(folderPath, 'premium')) ||
    existsSync(join(astroLocal, 'Dockerfile')) ||
    existsSync(join(astroLocal, 'project.toml'))
  )
}

/** Resolve wix-astronomer-dags root under a workspace scan path. */
export function findAstronomerDagsRoot(scanPath: string): string | null {
  if (!scanPath) return null
  if (isAstronomerDagsRepo(scanPath)) return scanPath

  const byName = join(scanPath, ASTRONOMER_DAGS_REPO_NAME)
  if (isAstronomerDagsRepo(byName)) return byName

  try {
    for (const entry of readdirSync(scanPath)) {
      if (entry.startsWith('.')) continue
      const child = join(scanPath, entry)
      if (isAstronomerDagsRepo(child)) return child
    }
  } catch {
    /* ignore */
  }

  return null
}

export function discoverLocalAirflowPort(repoRoot: string): number {
  const overridePath = join(repoRoot, 'astronomer-local', 'docker-compose.override.yml')
  if (existsSync(overridePath)) {
    const content = readFileSync(overridePath, 'utf-8')
    const match = content.match(/["'](\d+):8080["']/)
    if (match) return parseInt(match[1], 10)
  }
  return 8080
}

export function localAirflowApiUrl(repoRoot: string, apiVersion: 'v1' | 'v2' = 'v1'): string {
  const port = discoverLocalAirflowPort(repoRoot)
  return `http://127.0.0.1:${port}/api/${apiVersion}`
}

export function localAirflowUiUrl(repoRoot: string): string {
  const port = discoverLocalAirflowPort(repoRoot)
  return `http://127.0.0.1:${port}`
}

export function setupWorktreeScriptPath(repoRoot: string): string {
  return join(repoRoot, 'astronomer-local', 'setup_worktree_env.sh')
}
