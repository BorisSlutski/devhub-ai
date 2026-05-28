import React, { useEffect, useState } from 'react'
import './SetupWizard.css'

interface SystemCheckResult {
  node: { ok: boolean; version: string | null }
  claude: { ok: boolean; version: string | null }
  cursor: { ok: boolean; version: string | null }
  codex: { ok: boolean; version: string | null }
  git: { ok: boolean; version: string | null }
}

interface Props {
  onDismiss: () => void
}

export function SetupWizard({ onDismiss }: Props) {
  const [check, setCheck] = useState<SystemCheckResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.api.systemCheck().then(result => {
      setCheck(result)
      setLoading(false)
    })
  }, [])

  const allOk = check?.node.ok && check?.claude.ok

  return (
    <div className="setup-wizard-overlay" role="dialog" aria-labelledby="setup-wizard-title">
      <div className="setup-wizard">
        <h2 id="setup-wizard-title">Welcome to DevHub-AI</h2>
        <p className="setup-wizard-lead">
          Quick check that your machine is ready for embedded agent sessions.
        </p>
        {loading && <p className="setup-wizard-muted">Checking…</p>}
        {check && (
          <ul className="setup-wizard-list">
            <li className={check.node.ok ? 'ok' : 'fail'}>
              <span>Node.js</span>
              <span>{check.node.ok ? check.node.version : 'Not found — install Node 18+'}</span>
            </li>
            <li className={check.claude.ok ? 'ok' : 'fail'}>
              <span>Claude Code CLI</span>
              <span>{check.claude.ok ? check.claude.version : 'Run: npm install -g @anthropic-ai/claude-code'}</span>
            </li>
            <li className={check.cursor.ok ? 'ok' : 'optional'}>
              <span>Cursor CLI</span>
              <span>{check.cursor.ok ? check.cursor.version : 'Optional — for Cursor Agent sessions'}</span>
            </li>
            <li className={check.codex.ok ? 'ok' : 'optional'}>
              <span>Codex CLI</span>
              <span>{check.codex.ok ? check.codex.version : 'Optional — for Codex sessions'}</span>
            </li>
            <li className={check.git.ok ? 'ok' : 'optional'}>
              <span>Git</span>
              <span>{check.git.ok ? check.git.version : 'Optional — needed for worktrees'}</span>
            </li>
          </ul>
        )}
        <div className="setup-wizard-actions">
          {!allOk && !loading && (
            <p className="setup-wizard-hint">
              Install missing tools, then restart DevHub-AI or run checks again from Settings.
            </p>
          )}
          <button type="button" className="btn btn-primary" onClick={onDismiss}>
            {allOk ? 'Get started' : 'Continue anyway'}
          </button>
        </div>
      </div>
    </div>
  )
}
