import React, { useState, useMemo } from 'react'
import type { ResourceSnapshot, SessionMetrics } from '../../shared/ipc-types'
import './ResourcePanel.css'

interface Props {
  snapshot: ResourceSnapshot | null
  isLoading: boolean
  sessionNames: Map<string, string>
  onClose: () => void
}

type SortField = 'cpu' | 'memory'

function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1000) {
    return `${(mb / 1024).toFixed(1)} GB`
  }
  return `${mb.toFixed(1)} MB`
}

function formatMemoryShort(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 * 1024)
  return `${Math.round(mb)} MB`
}

function cpuBarColor(cpu: number): string {
  if (cpu < 25) return 'var(--green, #3fb950)'
  if (cpu <= 75) return 'var(--yellow, #d29922)'
  return 'var(--red, #f85149)'
}

export function ResourcePanel({ snapshot, isLoading, sessionNames, onClose }: Props) {
  const [sortBy, setSortBy] = useState<SortField>('cpu')

  const sortedSessions = useMemo(() => {
    if (!snapshot) return []
    return [...snapshot.sessions].sort((a, b) => {
      return sortBy === 'cpu' ? b.cpu - a.cpu : b.memory - a.memory
    })
  }, [snapshot, sortBy])

  // Find max values for bar scaling
  const maxCpu = useMemo(() => {
    if (sortedSessions.length === 0) return 100
    return Math.max(100, ...sortedSessions.map(s => s.cpu))
  }, [sortedSessions])

  const maxMem = useMemo(() => {
    if (sortedSessions.length === 0) return 1
    return Math.max(1, ...sortedSessions.map(s => s.memory))
  }, [sortedSessions])

  return (
    <div className="resource-panel">
      <div className="resource-panel-header">
        <span style={{ fontSize: 13, fontWeight: 600 }}>Resources</span>
        <button className="coach-close-btn" onClick={onClose} title="Close">x</button>
      </div>

      {/* Host metrics */}
      {snapshot && (
        <div className="resource-host-section">
          <div className="resource-host-row">
            <span className="resource-host-label">Memory</span>
            <span className="resource-host-value">
              {formatMemoryShort(snapshot.host.usedMemory)} / {formatMemoryShort(snapshot.host.totalMemory)}
              <span className="resource-host-pct"> ({snapshot.host.memoryUsagePercent}%)</span>
            </span>
          </div>
          <div className="resource-host-bar-bg">
            <div
              className="resource-host-bar-fill"
              style={{
                width: `${Math.min(100, snapshot.host.memoryUsagePercent)}%`,
                background: cpuBarColor(snapshot.host.memoryUsagePercent),
              }}
            />
          </div>
          <div className="resource-host-row" style={{ marginTop: 6 }}>
            <span className="resource-host-label">Load Avg (1m)</span>
            <span className="resource-host-value">
              {snapshot.host.loadAverage1m.toFixed(2)} / {snapshot.host.cpuCores} cores
            </span>
          </div>
        </div>
      )}

      {/* Sort controls */}
      <div className="resource-sort-row">
        <span className="resource-sort-label">Sort by:</span>
        <button
          className={`resource-sort-btn ${sortBy === 'cpu' ? 'active' : ''}`}
          onClick={() => setSortBy('cpu')}
        >CPU</button>
        <button
          className={`resource-sort-btn ${sortBy === 'memory' ? 'active' : ''}`}
          onClick={() => setSortBy('memory')}
        >Memory</button>
      </div>

      {/* Session list */}
      <div className="resource-session-list">
        {isLoading && sortedSessions.length === 0 ? (
          <div className="resource-empty">Collecting metrics...</div>
        ) : sortedSessions.length === 0 ? (
          <div className="resource-empty">No active sessions</div>
        ) : (
          sortedSessions.map((s: SessionMetrics) => {
            const name = sessionNames.get(s.sessionId) || s.sessionId.slice(0, 8)
            return (
              <div key={s.sessionId} className="resource-session-card">
                <div className="resource-session-name">{name}</div>
                <div className="resource-session-metrics">
                  <div className="resource-metric-row">
                    <span className="resource-metric-label">CPU</span>
                    <div className="resource-bar-bg">
                      <div
                        className="resource-bar-fill"
                        style={{
                          width: `${Math.min(100, (s.cpu / maxCpu) * 100)}%`,
                          background: cpuBarColor(s.cpu),
                        }}
                      />
                    </div>
                    <span className="resource-metric-value" style={{ color: cpuBarColor(s.cpu) }}>
                      {Math.round(s.cpu)}%
                    </span>
                  </div>
                  <div className="resource-metric-row">
                    <span className="resource-metric-label">Mem</span>
                    <div className="resource-bar-bg">
                      <div
                        className="resource-bar-fill"
                        style={{
                          width: `${Math.min(100, (s.memory / maxMem) * 100)}%`,
                          background: 'var(--blue, #58a6ff)',
                        }}
                      />
                    </div>
                    <span className="resource-metric-value">{formatMemory(s.memory)}</span>
                  </div>
                </div>
                <div className="resource-session-meta">
                  {s.processCount} processes &middot; PID {s.pid}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
