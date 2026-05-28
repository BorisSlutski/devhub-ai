import { execSync } from 'child_process'

export interface SystemCheckResult {
  node: { ok: boolean; version: string | null }
  claude: { ok: boolean; version: string | null }
  cursor: { ok: boolean; version: string | null }
  codex: { ok: boolean; version: string | null }
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
  const cursorVer = runVersion('cursor --version')
  const codexVer = runVersion('codex --version')
  const gitVer = runVersion('git --version')
  return {
    node: { ok: !!nodeVer, version: nodeVer },
    claude: { ok: !!claudeVer, version: claudeVer },
    cursor: { ok: !!cursorVer, version: cursorVer },
    codex: { ok: !!codexVer, version: codexVer },
    git: { ok: !!gitVer, version: gitVer },
  }
}
