import type { AgentProvider } from '../shared/agent-provider'
import { normalizeAgentProvider } from '../shared/agent-provider'

export interface BuildAgentCommandOptions {
  provider?: AgentProvider
  resumeClaudeId?: string
  dangerousMode?: boolean
  model?: string
}

/** Builds the initial command written into the PTY after shell readiness. */
export function buildAgentCommand(opts: BuildAgentCommandOptions): string {
  const provider = normalizeAgentProvider(opts.provider)

  switch (provider) {
    case 'claude': {
      const permFlag = opts.dangerousMode ? ' --dangerously-skip-permissions' : ''
      const modelFlag = opts.model ? ` --model ${opts.model}` : ''
      if (opts.resumeClaudeId) {
        return `claude --resume ${opts.resumeClaudeId}${modelFlag}${permFlag}`
      }
      return `claude${modelFlag}${permFlag}`
    }
    case 'cursor':
      return 'cursor agent'
    case 'codex':
      return 'codex'
    case 'shell':
      return ''
    default:
      return 'claude'
  }
}

export function worktreeBranchPrefix(provider: AgentProvider): string {
  return `devhub-ai/${provider}-`
}
