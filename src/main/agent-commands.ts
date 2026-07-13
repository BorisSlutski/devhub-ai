import type { AgentProvider } from '../shared/agent-provider'
import { normalizeAgentProvider } from '../shared/agent-provider'

export interface BuildAgentCommandOptions {
  provider?: AgentProvider
  resumeClaudeId?: string
  dangerousMode?: boolean
  model?: string
}

/** Session ids are UUIDs derived from `.jsonl` filenames — reject anything else before it reaches the shell. */
const SAFE_RESUME_ID = /^[\w-]{1,100}$/
/** Model names are short slugs (e.g. "claude-sonnet-5", "anthropic/claude-opus-4-8"). */
const SAFE_MODEL_NAME = /^[\w.:/-]{1,100}$/

/** Builds the initial command written into the PTY after shell readiness. */
export function buildAgentCommand(opts: BuildAgentCommandOptions): string {
  const provider = normalizeAgentProvider(opts.provider)

  switch (provider) {
    case 'claude': {
      const permFlag = opts.dangerousMode ? ' --dangerously-skip-permissions' : ''
      const model = opts.model && SAFE_MODEL_NAME.test(opts.model) ? opts.model : undefined
      const modelFlag = model ? ` --model ${model}` : ''
      const resumeId = opts.resumeClaudeId && SAFE_RESUME_ID.test(opts.resumeClaudeId)
        ? opts.resumeClaudeId
        : undefined
      if (resumeId) {
        return `claude --resume ${resumeId}${modelFlag}${permFlag}`
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
