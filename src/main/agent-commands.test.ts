import { describe, it, expect } from 'vitest'
import { buildAgentCommand } from './agent-commands'

describe('buildAgentCommand', () => {
  it('builds claude with model and dangerous flags', () => {
    expect(
      buildAgentCommand({
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        dangerousMode: true,
      }),
    ).toBe('claude --model claude-sonnet-4-6 --dangerously-skip-permissions')
  })

  it('builds cursor agent command', () => {
    expect(buildAgentCommand({ provider: 'cursor' })).toBe('cursor agent')
  })

  it('returns empty command for shell-only sessions', () => {
    expect(buildAgentCommand({ provider: 'shell' })).toBe('')
  })
})
