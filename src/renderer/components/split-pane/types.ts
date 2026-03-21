export type PaneId = string

export type SplitDirection = 'horizontal' | 'vertical'

export interface LeafNode {
  type: 'leaf'
  paneId: PaneId
}

export interface SplitNode {
  type: 'split'
  direction: SplitDirection
  ratio: number // 0-1, first child gets this ratio
  first: LayoutNode
  second: LayoutNode
}

export type LayoutNode = LeafNode | SplitNode

export interface PaneState {
  paneId: PaneId
  sessionId: string // PTY session ID
  title?: string
  isActive: boolean
}
