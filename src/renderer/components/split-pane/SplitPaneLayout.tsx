import React, { useCallback } from 'react'
import type { LayoutNode, PaneId } from './types'
import { SplitDivider } from './SplitDivider'
import './split-pane.css'

interface Props {
  layout: LayoutNode
  activePaneId: PaneId
  onPaneClick: (paneId: PaneId) => void
  onResize: (paneId: PaneId, ratio: number) => void
  renderPane: (paneId: PaneId) => React.ReactNode
}

/**
 * Recursively renders a layout tree of split panes.
 * LeafNode -> renders a pane container with the provided render function.
 * SplitNode -> renders two children with a draggable divider.
 */
export function SplitPaneLayout({ layout, activePaneId, onPaneClick, onResize, renderPane }: Props) {
  return (
    <div className="split-pane-root">
      <LayoutRenderer
        node={layout}
        activePaneId={activePaneId}
        onPaneClick={onPaneClick}
        onResize={onResize}
        renderPane={renderPane}
      />
    </div>
  )
}

interface LayoutRendererProps {
  node: LayoutNode
  activePaneId: PaneId
  onPaneClick: (paneId: PaneId) => void
  onResize: (paneId: PaneId, ratio: number) => void
  renderPane: (paneId: PaneId) => React.ReactNode
}

function LayoutRenderer({ node, activePaneId, onPaneClick, onResize, renderPane }: LayoutRendererProps) {
  const handleResize = useCallback(
    (newRatio: number) => {
      if (node.type !== 'split') return
      // Use the first child's paneId (or first leaf in subtree) to identify this split
      const firstPaneId = getFirstLeafId(node.first)
      if (firstPaneId) {
        onResize(firstPaneId, newRatio)
      }
    },
    [node, onResize]
  )

  if (node.type === 'leaf') {
    const isActive = node.paneId === activePaneId
    return (
      <div
        className={`split-pane-leaf ${isActive ? 'split-pane-leaf--active' : ''}`}
        data-pane-id={node.paneId}
        onClick={() => onPaneClick(node.paneId)}
      >
        {renderPane(node.paneId)}
      </div>
    )
  }

  // SplitNode
  const isHorizontal = node.direction === 'horizontal'
  const firstPercent = (node.ratio * 100).toFixed(4)
  const secondPercent = ((1 - node.ratio) * 100).toFixed(4)

  return (
    <div
      className={`split-pane-container split-pane-container--${node.direction}`}
    >
      <div
        className="split-pane-child"
        style={{
          [isHorizontal ? 'width' : 'height']: `calc(${firstPercent}% - 2px)`,
        }}
      >
        <LayoutRenderer
          node={node.first}
          activePaneId={activePaneId}
          onPaneClick={onPaneClick}
          onResize={onResize}
          renderPane={renderPane}
        />
      </div>
      <SplitDivider direction={node.direction} onResize={handleResize} />
      <div
        className="split-pane-child"
        style={{
          [isHorizontal ? 'width' : 'height']: `calc(${secondPercent}% - 2px)`,
        }}
      >
        <LayoutRenderer
          node={node.second}
          activePaneId={activePaneId}
          onPaneClick={onPaneClick}
          onResize={onResize}
          renderPane={renderPane}
        />
      </div>
    </div>
  )
}

function getFirstLeafId(node: LayoutNode): PaneId | null {
  if (node.type === 'leaf') return node.paneId
  return getFirstLeafId(node.first)
}
