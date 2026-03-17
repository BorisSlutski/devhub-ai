import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ProcessStatus, Project, SystemPortInfo } from '../../shared/types'
import './ProjectCard.css'

interface Props {
  project: Project
  status: ProcessStatus | undefined
  systemPortInfo: SystemPortInfo | undefined
  selected: boolean
  keyboardFocused?: boolean
  currentBranch: string | null
  branches: string[]
  onStart: () => void
  onStop: () => void
  onEdit: () => void
  onRemove: () => void
  onSelect: () => void
  onOpenBrowser: () => void
  onKillSystemProcess: (pid: number) => void
  onCheckoutBranch: (branch: string) => void
  onStartClaude: () => void
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'Never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function ProjectCard({
  project, status, systemPortInfo, selected, keyboardFocused, currentBranch, branches,
  onStart, onStop, onEdit, onRemove, onSelect, onOpenBrowser, onKillSystemProcess, onCheckoutBranch, onStartClaude
}: Props) {
  const isRunning = status?.running ?? false
  const isSystemRunning = !isRunning && !!systemPortInfo
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchFilter, setBranchFilter] = useState('')
  const toggleRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })

  useEffect(() => {
    if (!branchOpen) return
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        toggleRef.current && !toggleRef.current.contains(e.target as Node)
      ) {
        setBranchOpen(false)
        setBranchFilter('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [branchOpen])

  const openDropdown = useCallback(() => {
    if (toggleRef.current) {
      const rect = toggleRef.current.getBoundingClientRect()
      setDropdownPos({ top: rect.bottom + 4, left: rect.left })
    }
    setBranchOpen(prev => !prev)
    setBranchFilter('')
  }, [])

  const handleCheckout = useCallback((branch: string) => {
    setBranchOpen(false)
    setBranchFilter('')
    onCheckoutBranch(branch)
  }, [onCheckoutBranch])

  const filteredBranches = branches.filter(b =>
    b !== currentBranch && b.toLowerCase().includes(branchFilter.toLowerCase())
  )

  return (
    <div
      className={`project-card ${isRunning ? 'running' : ''} ${isSystemRunning ? 'system-running' : ''} ${selected ? 'selected' : ''} ${keyboardFocused ? 'keyboard-focused' : ''}`}
      onClick={onSelect}
    >
      <div className="project-card-header">
        <span className="project-card-name" title={project.name}>
          {project.name}
        </span>
        <span className="project-card-header-actions">
          <button
            className="card-remove-btn"
            title="Remove project"
            onClick={(e) => { e.stopPropagation(); onRemove() }}
          >×</button>
          <span className={`status-dot ${isRunning ? 'running' : isSystemRunning ? 'system' : 'stopped'}`}
            title={isSystemRunning ? `Already running (PID ${systemPortInfo.pid}, ${systemPortInfo.command})` : undefined}
          />
        </span>
      </div>

      {currentBranch && (
        <div className="project-card-branch" onClick={(e) => e.stopPropagation()}>
          <button
            ref={toggleRef}
            className="branch-toggle"
            onClick={openDropdown}
            title={`Branch: ${currentBranch}`}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Z"/>
            </svg>
            <span className="branch-name">{currentBranch}</span>
            {branches.length > 1 && (
              <svg className="branch-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z"/>
              </svg>
            )}
          </button>
          {branchOpen && branches.length > 1 && createPortal(
            <div
              ref={dropdownRef}
              className="branch-dropdown"
              style={{ top: dropdownPos.top, left: dropdownPos.left }}
            >
              {branches.length > 5 && (
                <input
                  className="branch-search"
                  placeholder="Filter branches..."
                  value={branchFilter}
                  onChange={(e) => setBranchFilter(e.target.value)}
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              )}
              <div className="branch-list">
                {filteredBranches.map(b => (
                  <button
                    key={b}
                    className="branch-item"
                    onClick={() => handleCheckout(b)}
                  >
                    {b}
                  </button>
                ))}
                {filteredBranches.length === 0 && (
                  <div className="branch-empty">No matching branches</div>
                )}
              </div>
            </div>,
            document.body
          )}
        </div>
      )}

      {project.description && (
        <div className="project-card-desc">{project.description}</div>
      )}

      <div className="project-card-meta">
        {project.techStack.map((tech) => (
          <span key={tech} className="tech-badge">{tech}</span>
        ))}
        {project.tags.map((tag) => (
          <span key={tag} className="tag-badge">{tag}</span>
        ))}
      </div>

      <div className="project-card-footer">
        <span className={`port-label ${isRunning ? 'active' : isSystemRunning ? 'system' : ''}`}>
          {isRunning ? `:${status?.port}` : project.port ? `:${project.port}` : 'No port'}
        </span>
        <span className="last-opened">{timeAgo(project.lastOpened)}</span>
      </div>

      {isSystemRunning && (
        <div className="system-running-info">
          Running externally ({systemPortInfo.command}, PID {systemPortInfo.pid})
        </div>
      )}

      <div className="project-actions" onClick={(e) => e.stopPropagation()}>
        {isRunning ? (
          <>
            <button className="btn btn-danger btn-sm" onClick={onStop}>Stop</button>
            <button className="btn btn-accent btn-sm" onClick={onOpenBrowser}>Open</button>
          </>
        ) : isSystemRunning ? (
          <>
            <button className="btn btn-danger btn-sm" onClick={() => onKillSystemProcess(systemPortInfo.pid)}>
              Kill :{systemPortInfo.port}
            </button>
            <button className="btn btn-accent btn-sm" onClick={onOpenBrowser}>Open</button>
          </>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={onStart}>
            {project.runCommand ? 'Run' : 'No command'}
          </button>
        )}
        <button className="btn btn-sm" onClick={onEdit}>Edit</button>
        <button className="btn btn-sm btn-claude" onClick={onStartClaude} title="Open in Claude">Claude</button>
      </div>
    </div>
  )
}
