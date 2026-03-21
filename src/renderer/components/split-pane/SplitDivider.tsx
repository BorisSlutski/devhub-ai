import React, { useCallback, useRef } from 'react'
import type { SplitDirection } from './types'

interface Props {
  direction: SplitDirection
  onResize: (newRatio: number) => void
}

export function SplitDivider({ direction, onResize }: Props) {
  const dividerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    draggingRef.current = true

    const divider = dividerRef.current
    if (!divider) return

    const parent = divider.parentElement
    if (!parent) return

    const parentRect = parent.getBoundingClientRect()
    const isHorizontal = direction === 'horizontal'

    divider.classList.add('split-divider--dragging')
    document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return

      let newRatio: number
      if (isHorizontal) {
        const offset = ev.clientX - parentRect.left
        newRatio = offset / parentRect.width
      } else {
        const offset = ev.clientY - parentRect.top
        newRatio = offset / parentRect.height
      }

      // Enforce min pane sizes: 200px width, 100px height
      const totalSize = isHorizontal ? parentRect.width : parentRect.height
      const minPx = isHorizontal ? 200 : 100
      const minRatio = minPx / totalSize
      const maxRatio = 1 - minRatio

      newRatio = Math.max(minRatio, Math.min(maxRatio, newRatio))
      onResize(newRatio)
    }

    const onMouseUp = () => {
      draggingRef.current = false
      divider.classList.remove('split-divider--dragging')
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [direction, onResize])

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onResize(0.5)
  }, [onResize])

  return (
    <div
      ref={dividerRef}
      className={`split-divider split-divider--${direction}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      role="separator"
      aria-orientation={direction === 'horizontal' ? 'vertical' : 'horizontal'}
    />
  )
}
