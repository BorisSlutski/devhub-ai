import React, { useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { XTerminal } from '../XTerminal'
import { SplitPaneLayout } from './SplitPaneLayout'
import { SplitPaneToolbar } from './SplitPaneToolbar'
import { useSplitPane } from './useSplitPane'
import { collectPaneIds } from './useSplitPane'
import type { PaneId } from './types'
import './split-pane.css'

interface Props {
  sessionId: string
  active: boolean
  onWaitingChange: (waiting: boolean) => void
  /** Render slot for toolbar — returns a portal target for the toolbar buttons */
  toolbarRef?: React.RefObject<HTMLDivElement | null>
}

/**
 * Wraps XTerminal in a split-pane layout. Each session gets its own
 * independent split-pane state. By default, it's a single pane
 * (same as the old behavior). Users can split via toolbar or shortcuts.
 */
export function SessionSplitPane({ sessionId, active, onWaitingChange, toolbarRef }: Props) {
  const {
    layout,
    activePaneId,
    panes,
    splitPane,
    closePane,
    setActivePane,
    updateRatio,
  } = useSplitPane(sessionId)

  const allPaneIds = collectPaneIds(layout)
  const hasMultiplePanes = allPaneIds.length > 1

  const handleSplitVertical = useCallback(() => {
    splitPane(activePaneId, 'horizontal') // horizontal split = side-by-side (vertical divider)
  }, [splitPane, activePaneId])

  const handleSplitHorizontal = useCallback(() => {
    splitPane(activePaneId, 'vertical') // vertical split = top/bottom (horizontal divider)
  }, [splitPane, activePaneId])

  const handleClosePane = useCallback(() => {
    if (hasMultiplePanes) {
      closePane(activePaneId)
    }
  }, [closePane, activePaneId, hasMultiplePanes])

  // Keyboard shortcuts for split pane (only when this session is active)
  useEffect(() => {
    if (!active) return

    const handler = (e: KeyboardEvent) => {
      const isMeta = e.metaKey

      // Cmd+D: Split vertical (side by side)
      if (isMeta && !e.shiftKey && e.key === 'd') {
        e.preventDefault()
        handleSplitVertical()
        return
      }

      // Cmd+Shift+D: Split horizontal (top/bottom)
      if (isMeta && e.shiftKey && e.key === 'D') {
        e.preventDefault()
        handleSplitHorizontal()
        return
      }

      // Cmd+W: Close active pane (only when multiple panes)
      if (isMeta && e.key === 'w' && hasMultiplePanes) {
        e.preventDefault()
        handleClosePane()
        return
      }

      // Cmd+] or Cmd+[: Cycle between panes
      if (isMeta && (e.key === ']' || e.key === '[')) {
        e.preventDefault()
        const currentIndex = allPaneIds.indexOf(activePaneId)
        if (currentIndex === -1) return
        let nextIndex: number
        if (e.key === ']') {
          nextIndex = (currentIndex + 1) % allPaneIds.length
        } else {
          nextIndex = (currentIndex - 1 + allPaneIds.length) % allPaneIds.length
        }
        setActivePane(allPaneIds[nextIndex])
        return
      }

      // Cmd+Option+Arrow: Move focus to adjacent pane
      if (isMeta && e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault()
        const currentIndex = allPaneIds.indexOf(activePaneId)
        if (currentIndex === -1) return
        let nextIndex: number
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          nextIndex = Math.min(currentIndex + 1, allPaneIds.length - 1)
        } else {
          nextIndex = Math.max(currentIndex - 1, 0)
        }
        setActivePane(allPaneIds[nextIndex])
        return
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active, activePaneId, allPaneIds, hasMultiplePanes, handleSplitVertical, handleSplitHorizontal, handleClosePane, setActivePane])

  const renderPane = useCallback((paneId: PaneId) => {
    const pane = panes.get(paneId)
    if (!pane) return null
    return (
      <XTerminal
        sessionId={pane.sessionId}
        active={active && paneId === activePaneId}
        onWaitingChange={onWaitingChange}
      />
    )
  }, [panes, active, activePaneId, onWaitingChange])

  return (
    <>
      {/* Render toolbar into the portal target if available */}
      {toolbarRef?.current && active && (
        <SplitPaneToolbarPortal target={toolbarRef.current}>
          <SplitPaneToolbar
            hasMultiplePanes={hasMultiplePanes}
            onSplitHorizontal={handleSplitHorizontal}
            onSplitVertical={handleSplitVertical}
            onClosePane={handleClosePane}
          />
        </SplitPaneToolbarPortal>
      )}
      {/* Inline toolbar fallback when no portal target */}
      {!toolbarRef?.current && active && (
        <div style={{ position: 'absolute', top: 0, right: 0, zIndex: 10, padding: '2px 4px' }}>
          <SplitPaneToolbar
            hasMultiplePanes={hasMultiplePanes}
            onSplitHorizontal={handleSplitHorizontal}
            onSplitVertical={handleSplitVertical}
            onClosePane={handleClosePane}
          />
        </div>
      )}
      <SplitPaneLayout
        layout={layout}
        activePaneId={activePaneId}
        onPaneClick={setActivePane}
        onResize={updateRatio}
        renderPane={renderPane}
      />
    </>
  )
}

/** Simple portal component to render children into a target DOM node */
function SplitPaneToolbarPortal({ target, children }: { target: HTMLElement; children: React.ReactNode }) {
  return createPortal(children, target)
}
