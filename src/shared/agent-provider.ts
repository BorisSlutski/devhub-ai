export type AgentProvider = 'claude' | 'cursor' | 'codex' | 'shell'

export const AGENT_PROVIDERS: AgentProvider[] = ['claude', 'cursor', 'codex', 'shell']

export const AGENT_PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor Agent',
  codex: 'Codex',
  shell: 'Shell',
}

export function normalizeAgentProvider(value: unknown): AgentProvider {
  if (value === 'cursor' || value === 'codex' || value === 'shell') return value
  return 'claude'
}
