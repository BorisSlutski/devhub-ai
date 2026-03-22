import React, { useState, useEffect, useCallback } from 'react'
import './FileExplorer.css'

interface FileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

interface Props {
  rootPath: string
  onFileSelect: (filePath: string) => void
  onShowChanges: () => void
  hasWorktree: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

function DirNode({ entry, onFileSelect, depth }: { entry: FileEntry; onFileSelect: (p: string) => void; depth: number }) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  const toggle = useCallback(() => {
    if (!expanded && !loaded) {
      window.api.listDirectory(entry.path).then((items) => {
        setChildren(items)
        setLoaded(true)
      })
    }
    setExpanded(prev => !prev)
  }, [expanded, loaded, entry.path])

  return (
    <>
      <div
        className="fe-row fe-dir"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={toggle}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/plain', entry.path)
          e.dataTransfer.effectAllowed = 'copy'
        }}
      >
        <span className="fe-icon">{expanded ? '▾' : '▸'}</span>
        <span className="fe-name">{entry.name}</span>
      </div>
      {expanded && children.map((child) =>
        child.isDir ? (
          <DirNode key={child.path} entry={child} onFileSelect={onFileSelect} depth={depth + 1} />
        ) : (
          <div
            key={child.path}
            className="fe-row fe-file"
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            onClick={() => onFileSelect(child.path)}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/plain', child.path)
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <span className="fe-icon">·</span>
            <span className="fe-name">{child.name}</span>
            <span className="fe-size">{formatSize(child.size)}</span>
          </div>
        )
      )}
    </>
  )
}

export function FileExplorer({ rootPath, onFileSelect, onShowChanges, hasWorktree }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    window.api.listDirectory(rootPath).then((items) => {
      setEntries(items)
      setLoading(false)
    })
  }, [rootPath])

  return (
    <div className="file-explorer">
      <div className="fe-header">
        <span className="fe-title">Files</span>
        {hasWorktree && (
          <button className="btn btn-sm fe-changes-btn" onClick={onShowChanges}>
            Changes
          </button>
        )}
      </div>
      <div className="fe-tree">
        {loading ? (
          <div className="fe-loading">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="fe-loading">Empty directory</div>
        ) : (
          entries.map((entry) =>
            entry.isDir ? (
              <DirNode key={entry.path} entry={entry} onFileSelect={onFileSelect} depth={0} />
            ) : (
              <div
                key={entry.path}
                className="fe-row fe-file"
                style={{ paddingLeft: 8 }}
                onClick={() => onFileSelect(entry.path)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('text/plain', entry.path)
                  e.dataTransfer.effectAllowed = 'copy'
                }}
              >
                <span className="fe-icon">·</span>
                <span className="fe-name">{entry.name}</span>
                <span className="fe-size">{formatSize(entry.size)}</span>
              </div>
            )
          )
        )}
      </div>
    </div>
  )
}
