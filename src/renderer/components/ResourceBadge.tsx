import React from 'react'
import type { SessionMetrics } from '../../shared/ipc-types'
import './ResourceBadge.css'

interface Props {
  metrics: SessionMetrics | null
  isLoading?: boolean
}

function formatMemory(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1000) {
    return `${(mb / 1024).toFixed(1)} GB`
  }
  return `${mb.toFixed(1)} MB`
}

function cpuColor(cpu: number): string {
  if (cpu < 25) return 'var(--green, #3fb950)'
  if (cpu <= 75) return 'var(--yellow, #d29922)'
  return 'var(--red, #f85149)'
}

export function ResourceBadge({ metrics, isLoading }: Props) {
  if (isLoading || !metrics) {
    return (
      <span className="resource-badge resource-badge-loading">
        <span className="resource-badge-skeleton" />
      </span>
    )
  }

  const cpuDisplay = `${Math.round(metrics.cpu)}%`
  const memDisplay = formatMemory(metrics.memory)
  const tooltipLines = [
    `CPU: ${metrics.cpu.toFixed(1)}%`,
    `Memory: ${memDisplay}`,
    `Processes: ${metrics.processCount}`,
    `PID: ${metrics.pid}`,
  ]

  return (
    <span className="resource-badge" title={tooltipLines.join('\n')}>
      <span className="resource-badge-cpu" style={{ color: cpuColor(metrics.cpu) }}>
        {cpuDisplay}
      </span>
      <span className="resource-badge-sep">&middot;</span>
      <span className="resource-badge-mem">{memDisplay}</span>
    </span>
  )
}
