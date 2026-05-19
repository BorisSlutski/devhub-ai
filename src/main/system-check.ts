import { execSync } from 'child_process'

export interface SystemCheckResult {
  node: { ok: boolean; version: string | null }
  claude: { ok: boolean; version: string | null }
  git: { ok: boolean; version: string | null }
}

function runVersion(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

export function runSystemCheck(): SystemCheckResult {
  const nodeVer = runVersion('node --version')
  const claudeVer = runVersion('claude --version')
  const gitVer = runVersion('git --version')
  return {
    node: { ok: !!nodeVer, version: nodeVer },
    claude: { ok: !!claudeVer, version: claudeVer },
    git: { ok: !!gitVer, version: gitVer },
  }
}
