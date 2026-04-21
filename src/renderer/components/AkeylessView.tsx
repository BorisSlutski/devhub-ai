import React, { useState, useEffect, useCallback, useRef } from 'react'
import { XTerminal } from './XTerminal'
import { Skeleton } from './Skeleton'
import './AkeylessView.css'

interface AkeylessStatus {
  cliInstalled: boolean
  cliVersion: string | null
  profileConfigured: boolean
  connectRcConfigured: boolean
  scriptExists: boolean
  scriptPath: string
}

interface DbConnection {
  id: string
  label: string
  exited: boolean
  connectionString: string | null
}

export function AkeylessView() {
  const [status, setStatus] = useState<AkeylessStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [installing, setInstalling] = useState(false)
  const [configuring, setConfiguring] = useState(false)
  const [connections, setConnections] = useState<DbConnection[]>([])
  const [activeConnId, setActiveConnId] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const connectionStrings = useRef<Map<string, string>>(new Map())

  const checkStatus = useCallback(async () => {
    try {
      const result = await window.api.akeylessCheckStatus()
      setStatus(result)
    } catch (err) {
      console.error('Failed to check akeyless status:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    checkStatus()
  }, [checkStatus])

  // Listen for PTY data to detect connection strings
  useEffect(() => {
    const unsub = window.api.onPtyData(({ sessionId, data }) => {
      // Only process for our akeyless sessions
      const conn = connections.find(c => c.id === sessionId)
      if (!conn) return

      // Detect MongoDB connection string in output
      const mongoMatch = data.match(/mongodb:\/\/[^\s]+/)
      if (mongoMatch) {
        const uri = mongoMatch[0]
        connectionStrings.current.set(sessionId, uri)
        setConnections(prev => prev.map(c =>
          c.id === sessionId ? { ...c, connectionString: uri } : c
        ))
      }
    })
    return unsub
  }, [connections])

  // Listen for PTY exits
  useEffect(() => {
    const unsub = window.api.onPtyExit(({ sessionId }) => {
      setConnections(prev => prev.map(c =>
        c.id === sessionId ? { ...c, exited: true } : c
      ))
    })
    return unsub
  }, [])

  const handleInstallCli = useCallback(async () => {
    setInstalling(true)
    try {
      const result = await window.api.akeylessInstallCli()
      if (!result.success) {
        console.error('Install failed:', result.error)
      }
      await checkStatus()
    } finally {
      setInstalling(false)
    }
  }, [checkStatus])

  const handleConfigure = useCallback(async () => {
    setConfiguring(true)
    try {
      const result = await window.api.akeylessConfigure()
      if (!result.success) {
        console.error('Configure failed:', result.error)
      }
      await checkStatus()
    } finally {
      setConfiguring(false)
    }
  }, [checkStatus])

  const handleConnect = useCallback(async () => {
    if (!status) return

    const sessionId = `akeyless-${Date.now().toString(36)}`
    const connNum = connections.length + 1

    // Derive home dir from scriptPath (e.g. /Users/foo/Downloads/db-akeyless-connect.sh)
    const homeDir = status.scriptPath.replace(/\/Downloads\/db-akeyless-connect\.sh$/, '')

    // Re-check script existence right before connecting
    const freshStatus = await window.api.akeylessCheckStatus()

    // Create a new PTY session that runs the connect script
    let command: string
    if (freshStatus.scriptExists) {
      command = `bash "${freshStatus.scriptPath}"`
    } else {
      command = `echo ""; echo "\\033[1;33m[DevHub-AI]\\033[0m db-akeyless-connect.sh not found."; echo ""; echo "Download it from:"; echo "  \\033[36mhttps://github.com/wix-private/dba-training-kit/releases/tag/db-akeyless-connectv2.0\\033[0m"; echo ""; echo "Then place it at: ~/Downloads/db-akeyless-connect.sh"; echo "And run:  chmod u+x ~/Downloads/db-akeyless-connect.sh"; echo ""; echo "Or if you have wixtaller:  wixtaller --components akeyless"; echo ""`
    }

    try {
      const result = await window.api.ptyCreate({
        sessionId,
        folderName: 'akeyless',
        folderPath: homeDir,
        useWorktree: false,
        tool: 'shell',
        shellCommand: command,
      })

      if (!result.success) {
        console.error('PTY create failed:', result.error)
        return
      }

      const conn: DbConnection = {
        id: sessionId,
        label: `DB #${connNum}`,
        exited: false,
        connectionString: null,
      }
      setConnections(prev => [...prev, conn])
      setActiveConnId(sessionId)
    } catch (err) {
      console.error('Failed to create akeyless session:', err)
    }
  }, [status, connections.length])

  const handleCloseConnection = useCallback(async (connId: string) => {
    await window.api.ptyDestroy(connId)
    connectionStrings.current.delete(connId)
    setConnections(prev => prev.filter(c => c.id !== connId))
    setActiveConnId(prev => {
      if (prev === connId) {
        const remaining = connections.filter(c => c.id !== connId)
        return remaining.length > 0 ? remaining[remaining.length - 1].id : null
      }
      return prev
    })
  }, [connections])

  const handleCopy = useCallback((text: string, connId: string) => {
    navigator.clipboard.writeText(text)
    setCopied(connId)
    setTimeout(() => setCopied(null), 2000)
  }, [])

  const isFullyConfigured = status?.cliInstalled && status?.profileConfigured && status?.connectRcConfigured

  if (loading) {
    return (
      <div className="akeyless-view">
        <div className="akeyless-header">
          <Skeleton width={140} height={16} />
          <Skeleton width={80} height={28} borderRadius={6} />
        </div>
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton-akeyless-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Skeleton width={20} height={20} borderRadius="50%" />
                <Skeleton width="60%" height={14} />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  const activeConn = connections.find(c => c.id === activeConnId) || null

  return (
    <div className="akeyless-view">
      <div className="akeyless-header">
        <h2>
          DB Access
          <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontWeight: 400, fontSize: 12 }}>
            Akeyless
          </span>
          {connections.filter(c => !c.exited).length > 0 && (
            <span style={{ marginLeft: 8, color: 'var(--green)', fontSize: 11 }}>
              {connections.filter(c => !c.exited).length} active
            </span>
          )}
        </h2>
        <div className="akeyless-header-actions">
          <button className="btn btn-sm" onClick={checkStatus}>Refresh Status</button>
          {isFullyConfigured && (
            <button className="btn btn-sm btn-primary" onClick={handleConnect}>
              Connect to DB
            </button>
          )}
        </div>
      </div>

      <div className="akeyless-content">
        {!isFullyConfigured ? (
          <div className="akeyless-setup">
            <div className="akeyless-note">
              Permissions given for database dev-access are READ ONLY. If you need more, contact #db channel.
            </div>

            <p className="akeyless-setup-intro">
              Akeyless provides secure, temporary access to Wix databases via SSH tunnels.
              Complete the setup below to connect.
            </p>

            <div className="akeyless-checklist">
              <div className="akeyless-check-item">
                <div className={`akeyless-check-icon ${status?.cliInstalled ? 'ok' : 'missing'}`}>
                  {status?.cliInstalled ? '\u2713' : '\u2717'}
                </div>
                <span className="akeyless-check-label">Akeyless CLI</span>
                <span className="akeyless-check-detail">
                  {status?.cliInstalled ? `v${status.cliVersion}` : 'Not installed'}
                </span>
              </div>

              <div className="akeyless-check-item">
                <div className={`akeyless-check-icon ${status?.profileConfigured ? 'ok' : 'missing'}`}>
                  {status?.profileConfigured ? '\u2713' : '\u2717'}
                </div>
                <span className="akeyless-check-label">SAML Profile</span>
                <span className="akeyless-check-detail">
                  {status?.profileConfigured ? 'wix-keycloak configured' : '~/.akeyless/profiles/wix-keycloak.toml'}
                </span>
              </div>

              <div className="akeyless-check-item">
                <div className={`akeyless-check-icon ${status?.connectRcConfigured ? 'ok' : 'missing'}`}>
                  {status?.connectRcConfigured ? '\u2713' : '\u2717'}
                </div>
                <span className="akeyless-check-label">Connection Config</span>
                <span className="akeyless-check-detail">
                  {status?.connectRcConfigured ? '.akeyless-connect.rc exists' : '~/.akeyless-connect.rc'}
                </span>
              </div>

              <div className="akeyless-check-item">
                <div className={`akeyless-check-icon ${status?.scriptExists ? 'ok' : 'missing'}`}>
                  {status?.scriptExists ? '\u2713' : '\u2717'}
                </div>
                <span className="akeyless-check-label">Connect Script</span>
                <span className="akeyless-check-detail">
                  {status?.scriptExists ? 'db-akeyless-connect.sh ready' : '~/Downloads/db-akeyless-connect.sh'}
                </span>
              </div>
            </div>

            <div className="akeyless-setup-actions">
              {!status?.cliInstalled && (
                <button
                  className="btn btn-primary"
                  onClick={handleInstallCli}
                  disabled={installing}
                >
                  {installing ? 'Installing CLI...' : 'Install Akeyless CLI'}
                </button>
              )}

              {status?.cliInstalled && (!status.profileConfigured || !status.connectRcConfigured) && (
                <button
                  className="btn btn-primary"
                  onClick={handleConfigure}
                  disabled={configuring}
                >
                  {configuring ? 'Configuring...' : 'Configure Akeyless'}
                </button>
              )}

              {status?.cliInstalled && status.profileConfigured && status.connectRcConfigured && !status.scriptExists && (
                <button className="btn btn-primary" onClick={handleConnect}>
                  Connect to DB (script will show instructions)
                </button>
              )}
            </div>

            {!status?.scriptExists && (
              <div className="akeyless-info-card">
                <h3>Download Connect Script</h3>
                <p>
                  Download <code>db-akeyless-connect.sh</code> from the GitHub release
                  and place it in <code>~/Downloads/</code>. Then run: <code>chmod u+x ~/Downloads/db-akeyless-connect.sh</code>
                </p>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => window.api.openInBrowser('https://github.com/wix-private/dba-training-kit/releases/tag/db-akeyless-connectv2.0')}
                  >
                    Download from GitHub
                  </button>
                  <button
                    className="btn btn-sm"
                    onClick={() => window.api.openInBrowser('https://dev.wix.com/docs/infrastructure-guild/ipe/dev-sec-ops-team/akeyless/akeyless-dbs-developer-access')}
                  >
                    Wix Docs
                  </button>
                </div>
              </div>
            )}

            <div className="akeyless-info-card">
              <h3>How it works</h3>
              <p>
                The connect script authenticates via SAML, lists databases based on your ownership tags,
                generates temporary credentials, and opens an SSH tunnel. You'll get a MongoDB connection
                string to use in Compass or your app.
              </p>
            </div>

            {status?.cliInstalled && (
              <div className="akeyless-info-card">
                <h3>Alternative: WixTaller</h3>
                <p>
                  You can also install and configure Akeyless via WixTaller:<br />
                  <code>wixtaller --components akeyless</code>
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="akeyless-connected">
            {connections.length > 0 && (
              <div className="akeyless-connections-bar">
                {connections.map(conn => (
                  <div
                    key={conn.id}
                    className={`akeyless-conn-tab ${conn.id === activeConnId ? 'active' : ''}`}
                    onClick={() => setActiveConnId(conn.id)}
                  >
                    <span className={`conn-dot ${conn.exited ? 'exited' : ''}`} />
                    <span>{conn.label}</span>
                    {conn.connectionString && (
                      <span style={{ color: 'var(--green)', fontSize: 10 }}>URI</span>
                    )}
                    <button
                      className="akeyless-conn-close"
                      onClick={(e) => { e.stopPropagation(); handleCloseConnection(conn.id) }}
                      title="Close connection"
                    >
                      x
                    </button>
                  </div>
                ))}
              </div>
            )}

            {connections.length === 0 ? (
              <div className="akeyless-empty">
                <div className="akeyless-empty-icon">&#9741;</div>
                {!status?.scriptExists ? (
                  <>
                    <span>Connect script not found</span>
                    <span style={{ fontSize: 12 }}>
                      Download <code style={{ background: 'var(--bg-tertiary)', padding: '1px 5px', borderRadius: 3, fontSize: 11 }}>db-akeyless-connect.sh</code> and place it in ~/Downloads/
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn btn-primary"
                        onClick={() => window.api.openInBrowser('https://github.com/wix-private/dba-training-kit/releases/tag/db-akeyless-connectv2.0')}
                      >
                        Download from GitHub
                      </button>
                      <button className="btn" onClick={handleConnect}>
                        Open Terminal Anyway
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span>No active database connections</span>
                    <span style={{ fontSize: 12 }}>
                      Click "Connect to DB" to start an interactive session
                    </span>
                    <button className="btn btn-primary" onClick={handleConnect}>
                      Connect to DB
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="akeyless-terminal-area">
                <div className="akeyless-terminal-wrapper">
                  {connections.map(conn => (
                    <div
                      key={conn.id}
                      style={{ display: conn.id === activeConnId ? 'block' : 'none', position: 'absolute', inset: 0 }}
                    >
                      <XTerminal
                        sessionId={conn.id}
                        active={conn.id === activeConnId}
                      />
                    </div>
                  ))}
                </div>
                {activeConn?.connectionString && (
                  <div className="akeyless-conn-info">
                    <span className="akeyless-conn-info-label">URI</span>
                    <span className="akeyless-conn-uri">{activeConn.connectionString}</span>
                    <button
                      className={`akeyless-copy-btn ${copied === activeConn.id ? 'copied' : ''}`}
                      onClick={() => handleCopy(activeConn.connectionString!, activeConn.id)}
                    >
                      {copied === activeConn.id ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
