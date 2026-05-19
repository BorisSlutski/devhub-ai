import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { XTerminal } from './XTerminal'
import type { GridLayout } from '../../shared/session-ui'
import { GRID_LAYOUT_CONFIG, layoutForCount, accentHex } from '../../shared/session-ui'
import './SessionGrid.css'

export interface GridSession {
  id: string
  label: string
  accentColor?: string
  exited?: boolean
}

interface Props {
  sessions: GridSession[]
  activeSessionId: string | null
  gridLayout: GridLayout
  gridSessionIds: string[]
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  onLayoutChange: (layout: GridLayout) => void
  onGridSessionIdsChange: (ids: string[]) => void
  onWaitingChange: (sessionId: string, waiting: boolean) => void
}

export function SessionGrid({
  sessions,
  activeSessionId,
  gridLayout,
  gridSessionIds,
  onSelectSession,
  onCloseSession,
  onLayoutChange,
  onGridSessionIdsChange,
  onWaitingChange,
}: Props) {
  const gridRef = useRef<HTMLDivElement>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)

  const cellIds = useMemo(() => {
    const max = GRID_LAYOUT_CONFIG[gridLayout].max
    const ids = gridSessionIds.length > 0
      ? gridSessionIds.filter(id => sessions.some(s => s.id === id))
      : sessions.map(s => s.id)
    return ids.slice(0, max)
  }, [gridSessionIds, gridLayout, sessions])

  useEffect(() => {
    if (cellIds.length === 0) {
      setFocusedIndex(0)
      return
    }
    const idx = activeSessionId ? cellIds.indexOf(activeSessionId) : 0
    setFocusedIndex(idx >= 0 ? idx : 0)
  }, [activeSessionId, cellIds])

  const { cols, rows } = GRID_LAYOUT_CONFIG[gridLayout]

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (cellIds.length === 0) return
    let next = focusedIndex
    switch (e.key) {
      case 'ArrowRight':
        next = Math.min(focusedIndex + 1, cellIds.length - 1)
        break
      case 'ArrowLeft':
        next = Math.max(focusedIndex - 1, 0)
        break
      case 'ArrowDown':
        next = Math.min(focusedIndex + cols, cellIds.length - 1)
        break
      case 'ArrowUp':
        next = Math.max(focusedIndex - cols, 0)
        break
      case 'Enter':
        onSelectSession(cellIds[focusedIndex])
        return
      default:
        return
    }
    e.preventDefault()
    setFocusedIndex(next)
    onSelectSession(cellIds[next])
  }, [cellIds, cols, focusedIndex, onSelectSession])

  const addToGrid = (sessionId: string) => {
    const max = GRID_LAYOUT_CONFIG[gridLayout].max
    if (gridSessionIds.includes(sessionId)) return
    const next = [...gridSessionIds, sessionId].slice(0, max)
    onGridSessionIdsChange(next)
    const layout = layoutForCount(next.length)
    onLayoutChange(layout)
  }

  if (sessions.length === 0) {
    return <div className="session-grid-empty">No sessions to display in grid.</div>
  }

  return (
    <div className="session-grid-wrap" onKeyDown={handleKeyDown} tabIndex={0}>
      <div className="session-grid-toolbar">
        <span className="session-grid-title">Grid view</span>
        <select
          className="session-grid-layout-select"
          value={gridLayout}
          onChange={e => onLayoutChange(e.target.value as GridLayout)}
          aria-label="Grid layout"
        >
          {Object.keys(GRID_LAYOUT_CONFIG).map(key => (
            <option key={key} value={key}>{key}</option>
          ))}
        </select>
        <select
          className="session-grid-add-select"
          value=""
          onChange={e => {
            if (e.target.value) addToGrid(e.target.value)
            e.target.value = ''
          }}
          aria-label="Add session to grid"
        >
          <option value="">+ Add session…</option>
          {sessions.filter(s => !cellIds.includes(s.id)).map(s => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>
      <div
        ref={gridRef}
        className="session-grid"
        style={{
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gridTemplateRows: `repeat(${rows}, 1fr)`,
        }}
      >
        {cellIds.map((sessionId, index) => {
          const session = sessions.find(s => s.id === sessionId)
          if (!session) return null
          const isFocused = index === focusedIndex || sessionId === activeSessionId
          const accent = accentHex(session.accentColor)
          return (
            <div
              key={sessionId}
              className={`session-grid-cell ${isFocused ? 'focused' : ''}`}
              style={{ borderColor: isFocused ? accent : 'var(--border)' }}
              onClick={() => {
                setFocusedIndex(index)
                onSelectSession(sessionId)
              }}
            >
              <div className="session-grid-cell-header" style={{ borderLeftColor: accent }}>
                <span className="session-grid-cell-title" title={session.label}>{session.label}</span>
                <button
                  type="button"
                  className="session-grid-cell-close"
                  onClick={e => {
                    e.stopPropagation()
                    onGridSessionIdsChange(gridSessionIds.filter(id => id !== sessionId))
                  }}
                  aria-label="Close session"
                >
                  ×
                </button>
              </div>
              <div className="session-grid-cell-terminal">
                <XTerminal
                  sessionId={sessionId}
                  active={isFocused}
                  onWaitingChange={w => onWaitingChange(sessionId, w)}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
