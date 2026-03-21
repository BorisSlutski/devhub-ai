import React from 'react'

interface Props {
  hasMultiplePanes: boolean
  onSplitHorizontal: () => void
  onSplitVertical: () => void
  onClosePane: () => void
}

export function SplitPaneToolbar({
  hasMultiplePanes,
  onSplitHorizontal,
  onSplitVertical,
  onClosePane,
}: Props) {
  return (
    <div className="split-pane-toolbar">
      <button
        className="split-pane-toolbar-btn"
        onClick={onSplitVertical}
        title="Split Vertical (Cmd+D)"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="1" width="14" height="14" rx="2" />
          <line x1="8" y1="1" x2="8" y2="15" />
        </svg>
      </button>
      <button
        className="split-pane-toolbar-btn"
        onClick={onSplitHorizontal}
        title="Split Horizontal (Cmd+Shift+D)"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="1" y="1" width="14" height="14" rx="2" />
          <line x1="1" y1="8" x2="15" y2="8" />
        </svg>
      </button>
      {hasMultiplePanes && (
        <button
          className="split-pane-toolbar-btn split-pane-toolbar-btn--close"
          onClick={onClosePane}
          title="Close Pane (Cmd+W)"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="4" y1="4" x2="12" y2="12" />
            <line x1="12" y1="4" x2="4" y2="12" />
          </svg>
        </button>
      )}
    </div>
  )
}
