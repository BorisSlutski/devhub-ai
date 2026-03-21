import { useState, useCallback, useRef } from 'react'
import type { LayoutNode, LeafNode, SplitNode, PaneId, PaneState, SplitDirection } from './types'

let paneCounter = 0
function generatePaneId(): PaneId {
  return `pane-${Date.now()}-${++paneCounter}`
}

/**
 * Find a leaf node by paneId in the layout tree.
 */
function findLeaf(node: LayoutNode, paneId: PaneId): LeafNode | null {
  if (node.type === 'leaf') {
    return node.paneId === paneId ? node : null
  }
  return findLeaf(node.first, paneId) || findLeaf(node.second, paneId)
}

/**
 * Collect all pane IDs from the layout tree.
 */
function collectPaneIds(node: LayoutNode): PaneId[] {
  if (node.type === 'leaf') return [node.paneId]
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)]
}

/**
 * Replace a leaf node in the tree with a new node (immutably).
 */
function replaceLeaf(node: LayoutNode, paneId: PaneId, replacement: LayoutNode): LayoutNode {
  if (node.type === 'leaf') {
    return node.paneId === paneId ? replacement : node
  }
  const newFirst = replaceLeaf(node.first, paneId, replacement)
  const newSecond = replaceLeaf(node.second, paneId, replacement)
  if (newFirst === node.first && newSecond === node.second) return node
  return { ...node, first: newFirst, second: newSecond }
}

/**
 * Remove a pane from the tree. Returns the sibling that takes its place,
 * or null if the pane was the root leaf.
 */
function removePane(node: LayoutNode, paneId: PaneId): LayoutNode | null {
  if (node.type === 'leaf') {
    return node.paneId === paneId ? null : node
  }

  // Check if either direct child is the target leaf
  if (node.first.type === 'leaf' && node.first.paneId === paneId) {
    return node.second
  }
  if (node.second.type === 'leaf' && node.second.paneId === paneId) {
    return node.first
  }

  // Recurse into children
  const newFirst = removePane(node.first, paneId)
  if (newFirst !== node.first) {
    // Removal happened in the first branch
    if (newFirst === null) return node.second
    return { ...node, first: newFirst }
  }

  const newSecond = removePane(node.second, paneId)
  if (newSecond !== node.second) {
    if (newSecond === null) return node.first
    return { ...node, second: newSecond }
  }

  return node
}

/**
 * Update the ratio of a split node that directly contains a given paneId.
 * Walks the tree to find any SplitNode whose first or second child
 * contains the given paneId, and updates that node's ratio.
 */
function updateSplitRatio(node: LayoutNode, paneId: PaneId, newRatio: number): LayoutNode {
  if (node.type === 'leaf') return node

  const split = node as SplitNode
  const firstHas = findLeaf(split.first, paneId) !== null
  const secondHas = findLeaf(split.second, paneId) !== null

  // If this split directly contains the pane as the first child of a direct split
  if (
    (split.first.type === 'leaf' && split.first.paneId === paneId) ||
    (split.second.type === 'leaf' && split.second.paneId === paneId)
  ) {
    return { ...split, ratio: newRatio }
  }

  // Recurse
  if (firstHas) {
    const newFirst = updateSplitRatio(split.first, paneId, newRatio)
    if (newFirst !== split.first) return { ...split, first: newFirst }
  }
  if (secondHas) {
    const newSecond = updateSplitRatio(split.second, paneId, newRatio)
    if (newSecond !== split.second) return { ...split, second: newSecond }
  }

  return node
}

export interface SplitPaneState {
  layout: LayoutNode
  activePaneId: PaneId
  panes: Map<PaneId, PaneState>
  splitPane: (paneId: PaneId, direction: SplitDirection) => void
  closePane: (paneId: PaneId) => void
  setActivePane: (paneId: PaneId) => void
  updateRatio: (paneId: PaneId, ratio: number) => void
  resetLayout: () => void
}

export function useSplitPane(initialSessionId: string): SplitPaneState {
  const initialPaneId = useRef(generatePaneId()).current

  const [layout, setLayout] = useState<LayoutNode>(() => ({
    type: 'leaf',
    paneId: initialPaneId,
  }))

  const [activePaneId, setActivePaneId] = useState<PaneId>(initialPaneId)

  const [panes, setPanes] = useState<Map<PaneId, PaneState>>(() => {
    const map = new Map<PaneId, PaneState>()
    map.set(initialPaneId, {
      paneId: initialPaneId,
      sessionId: initialSessionId,
      isActive: true,
    })
    return map
  })

  const splitPane = useCallback((paneId: PaneId, direction: SplitDirection) => {
    const newPaneId = generatePaneId()

    setLayout(prev => {
      const leaf = findLeaf(prev, paneId)
      if (!leaf) return prev

      const splitNode: SplitNode = {
        type: 'split',
        direction,
        ratio: 0.5,
        first: { type: 'leaf', paneId },
        second: { type: 'leaf', paneId: newPaneId },
      }
      return replaceLeaf(prev, paneId, splitNode)
    })

    setPanes(prev => {
      const existingPane = prev.get(paneId)
      const next = new Map(prev)
      // New pane shares the same sessionId (the caller can override later)
      next.set(newPaneId, {
        paneId: newPaneId,
        sessionId: existingPane?.sessionId ?? initialSessionId,
        isActive: false,
      })
      return next
    })

    // Focus the new pane
    setActivePaneId(newPaneId)
    setPanes(prev => {
      const next = new Map(prev)
      for (const [id, state] of next) {
        next.set(id, { ...state, isActive: id === newPaneId })
      }
      return next
    })
  }, [initialSessionId])

  const closePane = useCallback((paneId: PaneId) => {
    setLayout(prev => {
      const allPanes = collectPaneIds(prev)
      // If this is the last pane, don't close it
      if (allPanes.length <= 1) return prev

      const result = removePane(prev, paneId)
      if (!result) return prev

      // Determine which pane to focus after closing
      const remainingPanes = collectPaneIds(result)

      setPanes(prevPanes => {
        const next = new Map(prevPanes)
        next.delete(paneId)
        // Update isActive flags
        const newActiveId = remainingPanes[0] ?? null
        for (const [id, state] of next) {
          next.set(id, { ...state, isActive: id === newActiveId })
        }
        return next
      })

      setActivePaneId(prevActive => {
        if (prevActive !== paneId) return prevActive
        return remainingPanes[0] ?? prevActive
      })

      return result
    })
  }, [])

  const setActivePane = useCallback((paneId: PaneId) => {
    setActivePaneId(paneId)
    setPanes(prev => {
      const next = new Map(prev)
      for (const [id, state] of next) {
        next.set(id, { ...state, isActive: id === paneId })
      }
      return next
    })
  }, [])

  const updateRatio = useCallback((paneId: PaneId, ratio: number) => {
    setLayout(prev => updateSplitRatio(prev, paneId, ratio))
  }, [])

  const resetLayout = useCallback(() => {
    const rootPaneId = generatePaneId()
    setLayout({ type: 'leaf', paneId: rootPaneId })
    setPanes(new Map([[rootPaneId, {
      paneId: rootPaneId,
      sessionId: initialSessionId,
      isActive: true,
    }]]))
    setActivePaneId(rootPaneId)
  }, [initialSessionId])

  return {
    layout,
    activePaneId,
    panes,
    splitPane,
    closePane,
    setActivePane,
    updateRatio,
    resetLayout,
  }
}

// Export helpers for testing
export { collectPaneIds, findLeaf, removePane, replaceLeaf }
