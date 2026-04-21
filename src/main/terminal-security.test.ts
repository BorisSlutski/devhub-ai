/**
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest'

// ---------------------------------------------------------------------------
// Helper functions that mirror main process logic (for pure unit testing)
// ---------------------------------------------------------------------------

/** Valid session IDs match: claude- + base36 timestamp (lowercase alphanumeric) */
const VALID_SESSION_ID_PATTERN = /^claude-[a-z0-9]+$/

/**
 * Validates that a session ID is safe for use in file paths and IPC.
 * Rejects path traversal, shell metacharacters, and non-conforming formats.
 */
function isValidSessionId(id: string): boolean {
  if (!id || typeof id !== 'string') return false
  if (!VALID_SESSION_ID_PATTERN.test(id)) return false
  if (id.includes('../') || id.includes('..\\')) return false
  const shellMeta = /[;&|`$(){}[\]<>!\\\n\r\t\0]/
  if (shellMeta.test(id)) return false
  return true
}

/**
 * Sanitizes folder name to a slug for use in branch names and paths.
 * Mirrors: folderName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()
 */
function slugifyFolderName(folderName: string): string {
  return folderName.replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase()
}

/**
 * Builds the claude command string as the pty-create handler does.
 * Mirrors index.ts: permFlag = opts.dangerousMode ? ' --dangerously-skip-permissions' : ''
 * command = claude${permFlag} or claude --resume <id>${permFlag}
 */
function buildClaudeCommand(opts: {
  resumeClaudeId?: string
  dangerousMode?: boolean
}): string {
  const permFlag = opts.dangerousMode ? ' --dangerously-skip-permissions' : ''
  if (opts.resumeClaudeId) {
    return `claude --resume ${opts.resumeClaudeId}${permFlag}`
  }
  return `claude${permFlag}`
}

/**
 * Prepares env as pty-manager does: remove CLAUDECODE, set DEVHUB_AI_SESSION_ID,
 * ensure PATH starts with ~/.devhub-ai. Returns a new env object (does not mutate).
 */
function prepareSessionEnv(
  sessionId: string,
  baseEnv: Record<string, string>,
  devhubAiBinPrefix: string
): Record<string, string> {
  const env: Record<string, string> = { ...baseEnv }
  delete env.CLAUDECODE
  env.DEVHUB_AI_SESSION_ID = sessionId
  env.PATH = devhubAiBinPrefix + ':' + (env.PATH || '')
  return env
}

// ---------------------------------------------------------------------------
// 1. Session ID format validation tests
// ---------------------------------------------------------------------------
describe('Session ID format validation', () => {
  describe('isValidSessionId', () => {
    it('accepts valid session IDs matching claude-<base36> pattern', () => {
      expect(isValidSessionId('claude-m3abc')).toBe(true)
      expect(isValidSessionId('claude-abc123def')).toBe(true)
      expect(isValidSessionId('claude-0')).toBe(true)
      expect(isValidSessionId('claude-zzzz9999')).toBe(true)
    })

    it('rejects IDs with path traversal characters', () => {
      expect(isValidSessionId('claude-../../../etc/passwd')).toBe(false)
      expect(isValidSessionId('../etc/passwd')).toBe(false)
      expect(isValidSessionId('claude-m3abc/../evil')).toBe(false)
      expect(isValidSessionId('claude-m3abc..\\..\\etc')).toBe(false)
    })

    it('rejects IDs with shell metacharacters', () => {
      expect(isValidSessionId('claude-`rm -rf /`')).toBe(false)
      expect(isValidSessionId('claude-$(evil)')).toBe(false)
      expect(isValidSessionId('claude-abc; rm -rf /')).toBe(false)
      expect(isValidSessionId('claude-abc|cat')).toBe(false)
      expect(isValidSessionId('claude-abc\n')).toBe(false)
      expect(isValidSessionId('claude-abc\r')).toBe(false)
      expect(isValidSessionId('claude-abc\\')).toBe(false)
      expect(isValidSessionId('claude-abc$()')).toBe(false)
    })

    it('rejects invalid format (must start with claude-)', () => {
      expect(isValidSessionId('m3abc')).toBe(false)
      expect(isValidSessionId('Claude-m3abc')).toBe(false)
      expect(isValidSessionId('claude')).toBe(false)
      expect(isValidSessionId('claude-')).toBe(false)
    })

    it('rejects IDs with uppercase letters', () => {
      expect(isValidSessionId('claude-M3ABC')).toBe(false)
      expect(isValidSessionId('claude-ABC123')).toBe(false)
    })

    it('rejects empty and non-string inputs', () => {
      expect(isValidSessionId('')).toBe(false)
      expect(isValidSessionId('   ')).toBe(false)
      // @ts-expect-error - testing invalid input
      expect(isValidSessionId(null)).toBe(false)
      // @ts-expect-error - testing invalid input
      expect(isValidSessionId(undefined)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// 2. Folder name sanitization tests
// ---------------------------------------------------------------------------
describe('Folder name sanitization (slug generation)', () => {
  describe('slugifyFolderName', () => {
    it('correctly strips shell metacharacters', () => {
      expect(slugifyFolderName('`rm -rf /`')).toBe('-rm--rf---')
      expect(slugifyFolderName('$(evil)')).toBe('--evil-')
      expect(slugifyFolderName('test; echo hi')).toBe('test--echo-hi')
      expect(slugifyFolderName('pipe|here')).toBe('pipe-here')
      expect(slugifyFolderName('test&bad')).toBe('test-bad')
    })

    it('replaces backticks, $(), semicolons, pipes with hyphens', () => {
      expect(slugifyFolderName('project`name')).toBe('project-name')
      expect(slugifyFolderName('$(whoami)')).toBe('--whoami-')
      expect(slugifyFolderName('a;b;c')).toBe('a-b-c')
      expect(slugifyFolderName('a|b|c')).toBe('a-b-c')
    })

    it('replaces Unicode characters with hyphens', () => {
      expect(slugifyFolderName('café')).toBe('caf-')
      expect(slugifyFolderName('日本語')).toBe('---')
      expect(slugifyFolderName('project 名前')).toBe('project---')
      expect(slugifyFolderName('emoji🔥')).toBe('emoji--')
    })

    it('preserves alphanumeric, hyphen, and underscore', () => {
      expect(slugifyFolderName('my-project_123')).toBe('my-project_123')
      expect(slugifyFolderName('ABC_123-x')).toBe('abc_123-x')
    })

    it('converts to lowercase', () => {
      expect(slugifyFolderName('MyProject')).toBe('myproject')
      expect(slugifyFolderName('UPPERCASE')).toBe('uppercase')
    })

    it('empty string produces empty slug', () => {
      expect(slugifyFolderName('')).toBe('')
    })

    it('handles all-metacharacter input', () => {
      expect(slugifyFolderName('!@#$%^&*()')).toBe('----------')
    })
  })
})

// ---------------------------------------------------------------------------
// 3. Command building tests
// ---------------------------------------------------------------------------
describe('Command building', () => {
  describe('buildClaudeCommand', () => {
    it('safe mode: command is claude (no skip-permissions flag)', () => {
      expect(buildClaudeCommand({ dangerousMode: false })).toBe('claude')
      expect(buildClaudeCommand({})).toBe('claude')
    })

    it('dangerous mode: command includes --dangerously-skip-permissions', () => {
      expect(buildClaudeCommand({ dangerousMode: true })).toBe(
        'claude --dangerously-skip-permissions'
      )
    })

    it('resume safe: claude --resume <id> without skip-permissions', () => {
      expect(buildClaudeCommand({ resumeClaudeId: 'abc-123' })).toBe(
        'claude --resume abc-123'
      )
      expect(buildClaudeCommand({ resumeClaudeId: 'xyz', dangerousMode: false })).toBe(
        'claude --resume xyz'
      )
    })

    it('resume dangerous: claude --resume <id> --dangerously-skip-permissions', () => {
      expect(
        buildClaudeCommand({ resumeClaudeId: 'abc-123', dangerousMode: true })
      ).toBe('claude --resume abc-123 --dangerously-skip-permissions')
    })

    it('default (undefined dangerousMode) should be safe', () => {
      expect(buildClaudeCommand({})).toBe('claude')
      expect(buildClaudeCommand({ resumeClaudeId: 'id' })).toBe('claude --resume id')
    })
  })
})

// ---------------------------------------------------------------------------
// 3b. Pipeline command building tests (must respect dangerousMode)
// ---------------------------------------------------------------------------
describe('Pipeline command building', () => {
  /**
   * Mirrors the logic in pipeline-manager.ts runClaude():
   *   const permFlag = dangerousMode ? ' --dangerously-skip-permissions' : ''
   *   `cat "${promptFile}" | "${claude}" -p${permFlag} --output-format stream-json --verbose`
   */
  function buildPipelineCommand(claudePath: string, promptFile: string, dangerousMode: boolean): string {
    const permFlag = dangerousMode ? ' --dangerously-skip-permissions' : ''
    return `cat "${promptFile}" | "${claudePath}" -p${permFlag} --output-format stream-json --verbose`
  }

  it('safe mode: pipeline command does NOT include --dangerously-skip-permissions', () => {
    const cmd = buildPipelineCommand('/usr/local/bin/claude', '/tmp/prompt.txt', false)
    expect(cmd).not.toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('-p --output-format')
  })

  it('dangerous mode: pipeline command includes --dangerously-skip-permissions', () => {
    const cmd = buildPipelineCommand('/usr/local/bin/claude', '/tmp/prompt.txt', true)
    expect(cmd).toContain('--dangerously-skip-permissions')
  })
})

// ---------------------------------------------------------------------------
// 3c. Session restoration must preserve dangerousMode
// ---------------------------------------------------------------------------
describe('Session restoration preserves dangerousMode', () => {
  interface ClaudeSession {
    id: string
    folderName: string
    folderPath: string
    worktreePath: string | null
    branchName: string | null
    claudeSessionId: string | null
    dangerousMode?: boolean
  }

  function buildRestoredSession(
    newSessionId: string,
    session: ClaudeSession,
    result: { folderName?: string; worktreePath?: string; branchName?: string }
  ): ClaudeSession {
    return {
      id: newSessionId,
      folderName: result.folderName || session.folderName,
      folderPath: session.folderPath,
      worktreePath: result.worktreePath ?? session.worktreePath,
      branchName: result.branchName ?? session.branchName,
      claudeSessionId: session.claudeSessionId ?? null,
      dangerousMode: session.dangerousMode,
    }
  }

  it('restored session preserves dangerousMode=true from original', () => {
    const original: ClaudeSession = {
      id: 'old-id',
      folderName: 'proj',
      folderPath: '/path',
      worktreePath: null,
      branchName: null,
      claudeSessionId: 'c-123',
      dangerousMode: true,
    }
    const restored = buildRestoredSession('new-id', original, {})
    expect(restored.dangerousMode).toBe(true)
  })

  it('restored session preserves dangerousMode=false from original', () => {
    const original: ClaudeSession = {
      id: 'old-id',
      folderName: 'proj',
      folderPath: '/path',
      worktreePath: null,
      branchName: null,
      claudeSessionId: 'c-123',
      dangerousMode: false,
    }
    const restored = buildRestoredSession('new-id', original, {})
    expect(restored.dangerousMode).toBe(false)
  })

  it('restored session preserves undefined dangerousMode (defaults to safe)', () => {
    const original: ClaudeSession = {
      id: 'old-id',
      folderName: 'proj',
      folderPath: '/path',
      worktreePath: null,
      branchName: null,
      claudeSessionId: 'c-123',
    }
    const restored = buildRestoredSession('new-id', original, {})
    expect(restored.dangerousMode).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. Environment variable safety tests
// ---------------------------------------------------------------------------
describe('Environment variable safety', () => {
  describe('prepareSessionEnv', () => {
    const devhubAiBin = '/home/user/.devhub-ai'

    it('CLAUDECODE should be removed from env', () => {
      const base = { CLAUDECODE: '1', PATH: '/usr/bin' }
      const result = prepareSessionEnv('claude-abc', base, devhubAiBin)
      expect(result.CLAUDECODE).toBeUndefined()
      expect('CLAUDECODE' in result).toBe(false)
    })

    it('DEVHUB_AI_SESSION_ID should be set', () => {
      const base = { PATH: '/usr/bin' }
      const result = prepareSessionEnv('claude-xyz123', base, devhubAiBin)
      expect(result.DEVHUB_AI_SESSION_ID).toBe('claude-xyz123')
    })

    it('PATH should start with ~/.devhub-ai', () => {
      const base = { PATH: '/usr/bin:/usr/local/bin' }
      const result = prepareSessionEnv('claude-abc', base, devhubAiBin)
      expect(result.PATH).toMatch(/^\/home\/user\/\.devhub-ai:/)
      expect(result.PATH.startsWith(devhubAiBin + ':')).toBe(true)
    })

    it('handles empty PATH gracefully', () => {
      const base = {}
      const result = prepareSessionEnv('claude-abc', base, devhubAiBin)
      expect(result.PATH).toBe(devhubAiBin + ':')
    })

    it('does not mutate the base env object', () => {
      const base = { CLAUDECODE: '1', PATH: '/usr/bin' }
      const originalPath = base.PATH
      prepareSessionEnv('claude-abc', base, devhubAiBin)
      expect(base.CLAUDECODE).toBe('1')
      expect(base.PATH).toBe(originalPath)
    })
  })
})
