import React from 'react'
import './StatusDot.css'

/**
 * Shared status vocabulary for anything long-running in the app: Claude
 * sessions, background agents, DB/Trino connections. One vocabulary, one
 * visual language — see StatusDot.css for the color/animation mapping.
 */
export type StatusLevel = 'running' | 'waiting' | 'idle' | 'error' | 'disabled'

export function StatusDot({
  status,
  title,
  className,
}: {
  status: StatusLevel
  title?: string
  className?: string
}) {
  return (
    <span
      className={`status-dot status-dot-${status}${className ? ` ${className}` : ''}`}
      title={title}
      aria-label={title ?? status}
    />
  )
}
