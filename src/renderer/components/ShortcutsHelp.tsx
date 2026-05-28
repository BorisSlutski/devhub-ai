import React from 'react'
import './ShortcutsHelp.css'

interface Props {
  onClose: () => void
}

const shortcuts = [
  { keys: ['Cmd', 'K'], desc: 'Focus search (clear in terminal)' },
  { keys: ['Cmd', '1'], desc: 'Launchpad tab' },
  { keys: ['Cmd', '2'], desc: 'All Folders tab' },
  { keys: ['Cmd', '3'], desc: 'Sessions tab' },
  { keys: ['Cmd', '4'], desc: 'Agents tab' },
  { keys: ['Cmd', '5'], desc: 'DB Access tab' },
  { keys: ['Esc'], desc: 'Close modal / exit select mode' },
  { keys: ['?'], desc: 'Show this help' },
]

const terminalShortcuts = [
  { keys: ['Shift', 'Enter'], desc: 'New line in Claude prompt' },
  { keys: ['Cmd', 'K'], desc: 'Clear terminal screen' },
  { keys: ['Cmd', 'C'], desc: 'Copy (with selection)' },
  { keys: ['Cmd', 'V'], desc: 'Paste' },
  { keys: ['Cmd', 'A'], desc: 'Select all' },
  { keys: ['Cmd', '+'], desc: 'Increase font size' },
  { keys: ['Cmd', '-'], desc: 'Decrease font size' },
  { keys: ['Cmd', '0'], desc: 'Reset font size' },
]

export function ShortcutsHelp({ onClose }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Keyboard Shortcuts</h2>
        <h3 style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>General</h3>
        <div className="shortcuts-list">
          {shortcuts.map((s) => (
            <div key={s.desc} className="shortcut-row">
              <div className="shortcut-keys">
                {s.keys.map((k, i) => (
                  <span key={i}>
                    <kbd className="kbd">{k === 'Cmd' ? '\u2318' : k}</kbd>
                    {i < s.keys.length - 1 && <span className="kbd-plus">+</span>}
                  </span>
                ))}
              </div>
              <span className="shortcut-desc">{s.desc}</span>
            </div>
          ))}
        </div>
        <h3 style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Terminal</h3>
        <div className="shortcuts-list">
          {terminalShortcuts.map((s) => (
            <div key={s.desc} className="shortcut-row">
              <div className="shortcut-keys">
                {s.keys.map((k, i) => (
                  <span key={i}>
                    <kbd className="kbd">{k === 'Cmd' ? '\u2318' : k}</kbd>
                    {i < s.keys.length - 1 && <span className="kbd-plus">+</span>}
                  </span>
                ))}
              </div>
              <span className="shortcut-desc">{s.desc}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  )
}
