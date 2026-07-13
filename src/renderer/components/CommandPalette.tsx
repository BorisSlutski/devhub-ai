import React, { useEffect, useMemo, useRef, useState } from 'react'
import './CommandPalette.css'

export interface PaletteAction {
  id: string
  label: string
  group: string
  keywords?: string
  run: () => void
}

interface Props {
  actions: PaletteAction[]
  onClose: () => void
}

export function CommandPalette({ actions, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return actions
    return actions.filter(a => {
      const hay = `${a.label} ${a.group} ${a.keywords || ''}`.toLowerCase()
      return hay.includes(q)
    })
  }, [actions, query])

  useEffect(() => {
    setIndex(0)
  }, [query])

  const runSelected = () => {
    const action = filtered[index]
    if (action) {
      action.run()
      onClose()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex(i => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runSelected()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  return (
    <div className="palette-overlay" onClick={onClose} role="presentation">
      <div className="palette-panel" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <ul className="palette-list" role="listbox">
          {filtered.map((action, i) => (
            <li key={action.id}>
              <button
                type="button"
                className={`palette-item ${i === index ? 'selected' : ''}`}
                onClick={() => { action.run(); onClose() }}
                onMouseEnter={() => setIndex(i)}
              >
                <span className="palette-item-label">{action.label}</span>
                <span className="palette-item-group">{action.group}</span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="palette-empty">No matching commands</li>
          )}
        </ul>
      </div>
    </div>
  )
}

