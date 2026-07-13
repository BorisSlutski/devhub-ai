import React, { useMemo, useState } from 'react'
import hintsData from '../data/claude-hints.json'
import './HintsPanel.css'

interface HintItem {
  title: string
  command: string
  description: string
}

interface HintCategory {
  category: string
  items: HintItem[]
}

interface Props {
  onClose: () => void
}

export function HintsPanel({ onClose }: Props) {
  const [search, setSearch] = useState('')
  const categories = hintsData as HintCategory[]

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return categories
    return categories
      .map(cat => ({
        ...cat,
        items: cat.items.filter(
          item =>
            item.title.toLowerCase().includes(q) ||
            item.command.toLowerCase().includes(q) ||
            item.description.toLowerCase().includes(q)
        ),
      }))
      .filter(cat => cat.items.length > 0)
  }, [categories, search])

  const copyCommand = (cmd: string) => {
    void navigator.clipboard.writeText(cmd)
  }

  return (
    <div className="hints-overlay" onClick={onClose} role="presentation">
      <div className="hints-panel" onClick={e => e.stopPropagation()}>
        <div className="hints-header">
          <h2>Claude Code hints</h2>
          <button type="button" className="btn btn-sm" onClick={onClose} aria-label="Close">×</button>
        </div>
        <input
          className="search-input hints-search"
          placeholder="Search commands..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          autoFocus
        />
        <div className="hints-body">
          {filtered.map(cat => (
            <section key={cat.category} className="hints-category">
              <h3>{cat.category}</h3>
              {cat.items.map(item => (
                <button
                  key={item.command + item.title}
                  type="button"
                  className="hints-item"
                  onClick={() => copyCommand(item.command)}
                  title="Click to copy"
                >
                  <div className="hints-item-top">
                    <span className="hints-item-title">{item.title}</span>
                    <code className="hints-item-cmd">{item.command}</code>
                  </div>
                  <p className="hints-item-desc">{item.description}</p>
                </button>
              ))}
            </section>
          ))}
          {filtered.length === 0 && (
            <p className="hints-empty">No hints match your search.</p>
          )}
        </div>
        <p className="hints-footer">Click any row to copy the command. Press <kbd>F1</kbd> or <kbd>Esc</kbd> to close.</p>
      </div>
    </div>
  )
}
