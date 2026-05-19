import React, { useEffect, useState, useCallback, memo, useMemo, useRef } from 'react'
import { WorkspaceFolder } from '../../shared/types'
import type { GitSyncStatus } from '../../shared/ipc-types'
import { Skeleton } from './Skeleton'
import './FoldersView.css'

interface Props {
  scanPath: string
  onStartClaudeSession?: (folder: WorkspaceFolder, useWorktree: boolean) => void
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'Just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

interface GitInfo {
  gitBranch: string | null
  gitRemote: string | null
}

const gitCache = new Map<string, GitInfo>()
const syncCache = new Map<string, GitSyncStatus>()

function syncLabel(status: GitSyncStatus): string {
  switch (status.state) {
    case 'synced':
      return 'synced'
    case 'behind':
      return `${status.commitsBehind} behind`
    case 'ahead':
      return `${status.commitsAhead} ahead`
    case 'diverged':
      return 'diverged'
    case 'dirty':
      return 'dirty'
    case 'no-remote':
      return 'no remote'
    case 'no-base':
      return 'no base'
    case 'error':
      return 'error'
    default:
      return ''
  }
}

function syncTitle(status: GitSyncStatus): string {
  if (status.state === 'error' && status.error) return status.error
  const base = status.baseBranch ? ` vs origin/${status.baseBranch}` : ''
  if (status.state === 'synced') return `Up to date with remote${base}`
  if (status.state === 'behind') return `${status.commitsBehind} commit(s) behind${base}`
  if (status.state === 'ahead') return `${status.commitsAhead} commit(s) ahead${base}`
  if (status.state === 'diverged') {
    return `${status.commitsBehind} behind, ${status.commitsAhead} ahead${base}`
  }
  if (status.state === 'dirty') return `${status.uncommitted} uncommitted change(s)`
  return syncLabel(status)
}

function isPullable(sync: GitSyncStatus | undefined): boolean {
  return !!(
    sync?.isGitRepo &&
    sync.state !== 'not-git' &&
    sync.state !== 'no-remote' &&
    sync.state !== 'no-base'
  )
}

const FolderRow = memo(function FolderRow({
  folder,
  onStartClaudeSession,
  gitInfo,
  syncStatus,
  pulling,
  refreshing,
  onPull,
  onRefresh,
}: {
  folder: WorkspaceFolder
  onStartClaudeSession?: (folder: WorkspaceFolder, useWorktree: boolean) => void
  gitInfo: GitInfo | null | undefined
  syncStatus: GitSyncStatus | undefined
  pulling: boolean
  refreshing: boolean
  onPull: () => void
  onRefresh: () => void
}) {
  const handleOpenIde = (ide: 'cursor' | 'zed') => {
    window.api.openInIde(folder.path, ide)
  }

  const handleClaudeSession = () => {
    if (onStartClaudeSession) {
      const isGit = gitInfo != null && gitInfo.gitBranch !== null
      onStartClaudeSession(folder, isGit)
    }
  }

  const isGitRepo = gitInfo != null && gitInfo.gitBranch !== null
  const canPull = isPullable(syncStatus)
  const gitLoading = gitInfo === undefined || (refreshing && !syncStatus)

  return (
    <div className="folders-table-row" role="row">
      <div className="folders-col folders-col-name" role="cell">
        <span className="folder-name" title={folder.path}>
          {folder.name}
        </span>
      </div>

      <div className="folders-col folders-col-branch" role="cell">
        {gitLoading ? (
          <span className="git-loading">…</span>
        ) : !isGitRepo ? (
          <span className="no-git">—</span>
        ) : (
          <span className="git-branch" title={`Branch: ${gitInfo!.gitBranch}`}>
            <span className="git-icon">⎇</span> {gitInfo!.gitBranch}
          </span>
        )}
      </div>

      <div className="folders-col folders-col-sync" role="cell">
        {gitLoading ? (
          <span className="git-loading">…</span>
        ) : !syncStatus || syncStatus.state === 'not-git' ? (
          <span className="no-git">—</span>
        ) : (
          <div className="folders-sync-cell">
            <span
              className={`git-sync-badge sync-${syncStatus.state}${pulling ? ' pulling' : ''}`}
              title={syncTitle(syncStatus)}
            >
              {pulling ? 'pulling…' : syncLabel(syncStatus)}
            </span>
            <button
              type="button"
              className="btn btn-sm folders-refresh-btn"
              onClick={onRefresh}
              disabled={refreshing || pulling}
              title="Fetch origin and refresh sync status"
              aria-label={`Refresh git status for ${folder.name}`}
            >
              {refreshing ? '…' : '↻'}
            </button>
            {canPull && (
              <button
                type="button"
                className="btn btn-sm git-pull-btn"
                onClick={onPull}
                disabled={pulling || refreshing}
                title={`Checkout ${syncStatus.baseBranch ?? 'main/master'} and pull`}
              >
                {pulling ? '…' : 'Pull'}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="folders-col folders-col-remote" role="cell">
        {gitLoading ? (
          <span className="git-loading">…</span>
        ) : !isGitRepo ? (
          <span className="no-git">—</span>
        ) : gitInfo!.gitRemote ? (
          <button
            type="button"
            className="git-remote-link"
            title={gitInfo!.gitRemote!}
            onClick={() => window.api.openInBrowser(gitInfo!.gitRemote!)}
          >
            GitHub
          </button>
        ) : (
          <span className="git-local-only">local</span>
        )}
      </div>

      <div className="folders-col folders-col-modified" role="cell">
        <span className="folder-modified">{timeAgo(folder.modifiedAt)}</span>
      </div>

      <div className="folders-col folders-col-actions" role="cell">
        <div className="folder-actions">
          <button
            type="button"
            className="btn btn-sm btn-ide claude-btn"
            onClick={handleClaudeSession}
            title="Open Claude session"
          >
            Claude
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ide cursor-btn"
            onClick={() => handleOpenIde('cursor')}
            title="Open in Cursor"
          >
            Cursor
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ide zed-btn"
            onClick={() => handleOpenIde('zed')}
            title="Open in Zed"
          >
            Zed
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => window.api.openInTerminal(folder.path)}
            title="Open in Terminal"
          >
            Term
          </button>
        </div>
      </div>
    </div>
  )
})

export function FoldersView({ scanPath, onStartClaudeSession }: Props) {
  const [folders, setFolders] = useState<WorkspaceFolder[]>([])
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'name' | 'recent'>('name')
  const [loading, setLoading] = useState(true)
  const [gitInfoMap, setGitInfoMap] = useState<Map<string, GitInfo>>(new Map(gitCache))
  const [syncMap, setSyncMap] = useState<Map<string, GitSyncStatus>>(new Map(syncCache))
  const [pullingPaths, setPullingPaths] = useState<Set<string>>(new Set())
  const [refreshingPaths, setRefreshingPaths] = useState<Set<string>>(new Set())
  const [bulkPulling, setBulkPulling] = useState(false)
  const bulkPullPendingRef = useRef<Set<string> | null>(null)
  const [bulkRefreshing, setBulkRefreshing] = useState(false)
  const [bulkSummary, setBulkSummary] = useState<string | null>(null)
  const loadingPaths = useRef<Set<string>>(new Set())
  const loadingSyncPaths = useRef<Set<string>>(new Set())

  useEffect(() => {
    setLoading(true)
    gitCache.clear()
    syncCache.clear()
    window.api.listWorkspaceFolders(scanPath).then((f) => {
      setFolders(f)
      setGitInfoMap(new Map())
      setSyncMap(new Map())
      setLoading(false)
    })
  }, [scanPath])

  const filtered = useMemo(
    () =>
      folders
        .filter((f) => !search || f.name.toLowerCase().includes(search.toLowerCase()))
        .sort((a, b) => {
          if (sortBy === 'recent') {
            return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
          }
          return a.name.localeCompare(b.name)
        }),
    [folders, search, sortBy],
  )

  const loadGitInfo = useCallback((path: string, force = false) => {
    if (!force && (gitCache.has(path) || loadingPaths.current.has(path))) return
    loadingPaths.current.add(path)
    window.api.getGitInfo(path).then((info) => {
      gitCache.set(path, info)
      loadingPaths.current.delete(path)
      setGitInfoMap((prev) => {
        const next = new Map(prev)
        next.set(path, info)
        return next
      })
    })
  }, [])

  const loadSyncStatus = useCallback((path: string, fetch = false, force = false) => {
    const cacheKey = fetch ? `${path}:fetch` : path
    if (!force && !fetch && syncCache.has(path)) return
    if (loadingSyncPaths.current.has(cacheKey)) return
    loadingSyncPaths.current.add(cacheKey)
    return window.api.getGitSyncStatus(path, fetch).then((status) => {
      syncCache.set(path, status)
      loadingSyncPaths.current.delete(cacheKey)
      setSyncMap((prev) => {
        const next = new Map(prev)
        next.set(path, status)
        return next
      })
      return status
    })
  }, [])

  const loadFolderMeta = useCallback(
    (path: string, fetch = false, force = false) => {
      loadGitInfo(path, force)
      return loadSyncStatus(path, fetch, force)
    },
    [loadGitInfo, loadSyncStatus],
  )

  // Load git metadata for all visible folders (IntersectionObserver missed rows on first paint)
  useEffect(() => {
    if (loading || filtered.length === 0) return
    for (const folder of filtered) {
      loadFolderMeta(folder.path, false, false)
    }
  }, [filtered, loading, loadFolderMeta])

  const refreshOne = useCallback(
    async (path: string) => {
      setRefreshingPaths((prev) => new Set(prev).add(path))
      gitCache.delete(path)
      syncCache.delete(path)
      try {
        await Promise.all([
          window.api.getGitInfo(path).then((info) => {
            gitCache.set(path, info)
            setGitInfoMap((prev) => {
              const next = new Map(prev)
              next.set(path, info)
              return next
            })
          }),
          loadSyncStatus(path, true, true),
        ])
      } finally {
        setRefreshingPaths((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [loadSyncStatus],
  )

  const refreshAll = useCallback(async () => {
    setBulkRefreshing(true)
    setBulkSummary(null)
    gitCache.clear()
    syncCache.clear()
    try {
      await Promise.all(filtered.map((f) => refreshOne(f.path)))
      setBulkSummary(`Refreshed ${filtered.length} folder(s)`)
    } finally {
      setBulkRefreshing(false)
    }
  }, [filtered, refreshOne])

  const finishPull = useCallback(
    async (path: string, success: boolean, error?: string) => {
      if (!success && error) {
        setBulkSummary(`${path.split('/').pop()}: ${error}`)
      }
      await refreshOne(path)
      setPullingPaths((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
      const pending = bulkPullPendingRef.current
      if (pending) {
        pending.delete(path)
        if (pending.size === 0) {
          bulkPullPendingRef.current = null
          setBulkPulling(false)
        }
      }
    },
    [refreshOne],
  )

  useEffect(() => {
    const unsubOne = window.api.onGitPullFinished((result) => {
      void finishPull(result.path, result.success, result.error)
    })
    const unsubBatch = window.api.onGitPullBatchFinished(({ ok, failed, total }) => {
      setBulkSummary(`${ok} pulled, ${failed} failed (${total} total)`)
      bulkPullPendingRef.current = null
      setBulkPulling(false)
    })
    return () => {
      unsubOne()
      unsubBatch()
    }
  }, [finishPull])

  const handlePullOne = useCallback((path: string) => {
    setPullingPaths((prev) => new Set(prev).add(path))
    setBulkSummary(null)
    void window.api.startPullFolderToBase(path)
  }, [])

  const resolveGitPaths = useCallback(() => {
    return filtered
      .filter((f) => {
        const info = gitInfoMap.get(f.path)
        if (info?.gitBranch) return true
        const sync = syncMap.get(f.path)
        return isPullable(sync)
      })
      .map((f) => f.path)
  }, [filtered, gitInfoMap, syncMap])

  const handlePullAll = useCallback(async () => {
    let gitPaths = resolveGitPaths()
    if (gitPaths.length === 0) {
      setBulkSummary('Loading git info…')
      await Promise.all(filtered.map((f) => loadFolderMeta(f.path, true, true)))
      gitPaths = resolveGitPaths()
    }
    if (gitPaths.length === 0) {
      setBulkSummary('No git folders to pull in the current list')
      return
    }

    setBulkPulling(true)
    setBulkSummary(`Pulling ${gitPaths.length} folder(s) in background…`)
    bulkPullPendingRef.current = new Set(gitPaths)
    setPullingPaths((prev) => {
      const next = new Set(prev)
      for (const p of gitPaths) next.add(p)
      return next
    })
    void window.api.startPullAllFoldersToBase(gitPaths)
  }, [filtered, resolveGitPaths, loadFolderMeta])

  if (loading) {
    return (
      <div className="folders-view">
        <div className="folders-toolbar">
          <Skeleton height={32} style={{ flex: 1 }} borderRadius={6} />
          <Skeleton width={70} height={28} borderRadius={6} />
          <Skeleton width={70} height={28} borderRadius={6} />
        </div>
        <div className="folders-table-wrap">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="skeleton-folder-row">
              <Skeleton width="20%" height={14} />
              <Skeleton width="15%" height={14} />
              <Skeleton width="12%" height={14} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="folders-view">
      <div className="folders-toolbar">
        <input
          className="search-input"
          placeholder="Filter folders..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="btn btn-sm"
          onClick={refreshAll}
          disabled={bulkRefreshing}
          title="Fetch origin and refresh sync status for all listed folders"
        >
          {bulkRefreshing ? 'Refreshing…' : 'Refresh all'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-accent"
          onClick={handlePullAll}
          disabled={bulkRefreshing}
          title="Checkout main/master and pull for all git folders (runs in background)"
        >
          {bulkPulling ? 'Pulling…' : 'Pull all'}
        </button>
        <button
          type="button"
          className={`btn btn-sm ${sortBy === 'name' ? 'btn-accent' : ''}`}
          onClick={() => setSortBy('name')}
        >
          A-Z
        </button>
        <button
          type="button"
          className={`btn btn-sm ${sortBy === 'recent' ? 'btn-accent' : ''}`}
          onClick={() => setSortBy('recent')}
        >
          Recent
        </button>
        <span className="folders-count">{filtered.length} folders</span>
      </div>

      {bulkSummary && (
        <div className="folders-bulk-summary">
          <span>{bulkSummary}</span>
          <button type="button" className="folders-bulk-dismiss" onClick={() => setBulkSummary(null)}>
            ×
          </button>
        </div>
      )}

      <div className="folders-table-wrap">
        <div className="folders-table-header" role="row">
          <div className="folders-col folders-col-name" role="columnheader">
            Folder
          </div>
          <div className="folders-col folders-col-branch" role="columnheader">
            Branch
          </div>
          <div className="folders-col folders-col-sync" role="columnheader">
            Sync
          </div>
          <div className="folders-col folders-col-remote" role="columnheader">
            Remote
          </div>
          <div className="folders-col folders-col-modified" role="columnheader">
            Modified
          </div>
          <div className="folders-col folders-col-actions" role="columnheader">
            Open
          </div>
        </div>

        <div className="folders-table-body" role="rowgroup">
          {filtered.map((folder) => (
            <FolderRow
              key={folder.path}
              folder={folder}
              onStartClaudeSession={onStartClaudeSession}
              gitInfo={gitInfoMap.has(folder.path) ? gitInfoMap.get(folder.path)! : undefined}
              syncStatus={syncMap.get(folder.path)}
              pulling={pullingPaths.has(folder.path)}
              refreshing={refreshingPaths.has(folder.path)}
              onPull={() => handlePullOne(folder.path)}
              onRefresh={() => refreshOne(folder.path)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
