import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { SplitPaneLayout } from './SplitPaneLayout'
import type { LayoutNode, LeafNode, SplitNode } from './types'
import { collectPaneIds, findLeaf, removePane } from './useSplitPane'

function renderPane(paneId: string) {
  return <div data-testid={`pane-${paneId}`}>Pane {paneId}</div>
}

const noop = () => {}

describe('SplitPaneLayout', () => {
  it('renders a single pane (leaf node)', () => {
    const layout: LeafNode = { type: 'leaf', paneId: 'p1' }
    render(
      <SplitPaneLayout
        layout={layout}
        activePaneId="p1"
        onPaneClick={noop}
        onResize={noop}
        renderPane={renderPane}
      />
    )
    expect(screen.getByTestId('pane-p1')).toBeInTheDocument()
    expect(screen.getByText('Pane p1')).toBeInTheDocument()
  })

  it('renders horizontal split with two panes', () => {
    const layout: SplitNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', paneId: 'left' },
      second: { type: 'leaf', paneId: 'right' },
    }
    render(
      <SplitPaneLayout
        layout={layout}
        activePaneId="left"
        onPaneClick={noop}
        onResize={noop}
        renderPane={renderPane}
      />
    )
    expect(screen.getByTestId('pane-left')).toBeInTheDocument()
    expect(screen.getByTestId('pane-right')).toBeInTheDocument()
    // Should have a divider
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('renders vertical split with two panes', () => {
    const layout: SplitNode = {
      type: 'split',
      direction: 'vertical',
      ratio: 0.6,
      first: { type: 'leaf', paneId: 'top' },
      second: { type: 'leaf', paneId: 'bottom' },
    }
    render(
      <SplitPaneLayout
        layout={layout}
        activePaneId="top"
        onPaneClick={noop}
        onResize={noop}
        renderPane={renderPane}
      />
    )
    expect(screen.getByTestId('pane-top')).toBeInTheDocument()
    expect(screen.getByTestId('pane-bottom')).toBeInTheDocument()
  })

  it('renders nested splits (split within a split)', () => {
    const layout: SplitNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', paneId: 'a' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', paneId: 'b' },
        second: { type: 'leaf', paneId: 'c' },
      },
    }
    render(
      <SplitPaneLayout
        layout={layout}
        activePaneId="a"
        onPaneClick={noop}
        onResize={noop}
        renderPane={renderPane}
      />
    )
    expect(screen.getByTestId('pane-a')).toBeInTheDocument()
    expect(screen.getByTestId('pane-b')).toBeInTheDocument()
    expect(screen.getByTestId('pane-c')).toBeInTheDocument()
    // Two dividers: one horizontal, one vertical
    const separators = screen.getAllByRole('separator')
    expect(separators).toHaveLength(2)
  })

  it('marks the active pane with active class', () => {
    const layout: SplitNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', paneId: 'p1' },
      second: { type: 'leaf', paneId: 'p2' },
    }
    const { container } = render(
      <SplitPaneLayout
        layout={layout}
        activePaneId="p2"
        onPaneClick={noop}
        onResize={noop}
        renderPane={renderPane}
      />
    )
    const activeLeaves = container.querySelectorAll('.split-pane-leaf--active')
    expect(activeLeaves).toHaveLength(1)
    expect(activeLeaves[0].getAttribute('data-pane-id')).toBe('p2')
  })

  it('clicking a pane calls onPaneClick with its id', () => {
    const onPaneClick = vi.fn()
    const layout: SplitNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', paneId: 'p1' },
      second: { type: 'leaf', paneId: 'p2' },
    }
    render(
      <SplitPaneLayout
        layout={layout}
        activePaneId="p1"
        onPaneClick={onPaneClick}
        onResize={noop}
        renderPane={renderPane}
      />
    )
    fireEvent.click(screen.getByTestId('pane-p2'))
    expect(onPaneClick).toHaveBeenCalledWith('p2')
  })

  it('double-clicking divider calls onResize with 0.5', () => {
    const onResize = vi.fn()
    const layout: SplitNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.7,
      first: { type: 'leaf', paneId: 'p1' },
      second: { type: 'leaf', paneId: 'p2' },
    }
    render(
      <SplitPaneLayout
        layout={layout}
        activePaneId="p1"
        onPaneClick={noop}
        onResize={onResize}
        renderPane={renderPane}
      />
    )
    const divider = screen.getByRole('separator')
    fireEvent.doubleClick(divider)
    expect(onResize).toHaveBeenCalledWith('p1', 0.5)
  })
})

describe('useSplitPane helpers', () => {
  it('collectPaneIds returns all leaf IDs', () => {
    const layout: SplitNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', paneId: 'a' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', paneId: 'b' },
        second: { type: 'leaf', paneId: 'c' },
      },
    }
    const ids = collectPaneIds(layout)
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('findLeaf finds existing leaf', () => {
    const layout: SplitNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', paneId: 'a' },
      second: { type: 'leaf', paneId: 'b' },
    }
    const leaf = findLeaf(layout, 'b')
    expect(leaf).toEqual({ type: 'leaf', paneId: 'b' })
  })

  it('findLeaf returns null for non-existent pane', () => {
    const layout: LeafNode = { type: 'leaf', paneId: 'a' }
    expect(findLeaf(layout, 'x')).toBeNull()
  })

  it('removePane collapses to sibling', () => {
    const layout: SplitNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', paneId: 'a' },
      second: { type: 'leaf', paneId: 'b' },
    }
    const result = removePane(layout, 'a')
    expect(result).toEqual({ type: 'leaf', paneId: 'b' })
  })

  it('removePane in nested split preserves structure', () => {
    const layout: SplitNode = {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', paneId: 'a' },
      second: {
        type: 'split',
        direction: 'vertical',
        ratio: 0.5,
        first: { type: 'leaf', paneId: 'b' },
        second: { type: 'leaf', paneId: 'c' },
      },
    }
    const result = removePane(layout, 'b')
    // Removing 'b' from the nested split should collapse it to 'c',
    // leaving the top-level split as horizontal(a, c)
    expect(result).toEqual({
      type: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { type: 'leaf', paneId: 'a' },
      second: { type: 'leaf', paneId: 'c' },
    })
  })

  it('removePane returns null for root leaf', () => {
    const layout: LeafNode = { type: 'leaf', paneId: 'only' }
    expect(removePane(layout, 'only')).toBeNull()
  })
})
