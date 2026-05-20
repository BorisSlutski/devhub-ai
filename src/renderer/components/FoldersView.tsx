import React, { useEffect, useState, useCallback, memo, useMemo, useRef } from 'react'
import { WorkspaceFolder } from '../../shared/types'
import type { GitFolderMeta, GitSyncStatus } from '../../shared/ipc-types'
import { Skeleton } from './Skeleton'
import './FoldersView.css'

interface Props {
  scanPath: string
  favoriteFolderPaths?: string[]
  foldersSortBy?: 'name' | 'recent'
  onToggleFavorite?: (path: string) => void
  onFoldersSortByChange?: (sortBy: 'name' | 'recent') => void
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

const metaCache = new Map<string, GitFolderMeta>()

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
  isFavorite,
  onToggleFavorite,
  onStartClaudeSession,
  gitInfo,
  syncStatus,
  pulling,
  refreshing,
  onPull,
  onRefresh,
}: {
  folder: WorkspaceFolder
  isFavorite: boolean
  onToggleFavorite?: (path: string) => void
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
    <div className="folders-table-row" role="row" data-folder-path={folder.path}>
      <div className="folders-col folders-col-name" role="cell">
        <button
          type="button"
          className={`folder-favorite-btn${isFavorite ? ' is-favorite' : ''}`}
          onClick={() => onToggleFavorite?.(folder.path)}
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-label={isFavorite ? `Unfavorite ${folder.name}` : `Favorite ${folder.name}`}
          aria-pressed={isFavorite}
        >
          {isFavorite ? '★' : '☆'}
        </button>
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

function sortFolders(
  list: WorkspaceFolder[],
  sortBy: 'name' | 'recent',
  favoriteSet: Set<string>,
): WorkspaceFolder[] {
  return [...list].sort((a, b) => {
    const aFav = favoriteSet.has(a.path)
    const bFav = favoriteSet.has(b.path)
    if (aFav !== bFav) return aFav ? -1 : 1
    if (sortBy === 'recent') {
      return new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime()
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

export function FoldersView({
  scanPath,
  favoriteFolderPaths = [],
  foldersSortBy = 'name',
  onToggleFavorite,
  onFoldersSortByChange,
  onStartClaudeSession,
}: Props) {
  const [folders, setFolders] = useState<WorkspaceFolder[]>([])
  const [search, setSearch] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const sortBy = foldersSortBy
  const [loading, setLoading] = useState(true)
  const [metaMap, setMetaMap] = useState<Map<string, GitFolderMeta>>(new Map(metaCache))
  const [pullingPaths, setPullingPaths] = useState<Set<string>>(new Set())
  const [refreshingPaths, setRefreshingPaths] = useState<Set<string>>(new Set())
  const [bulkPulling, setBulkPulling] = useState(false)
  const bulkPullPendingRef = useRef<Set<string> | null>(null)
  const [bulkRefreshing, setBulkRefreshing] = useState(false)
  const [bulkSummary, setBulkSummary] = useState<string | null>(null)
  const loadingPaths = useRef<Set<string>>(new Set())
  const tableWrapRef = useRef<HTMLDivElement>(null)
  const metaQueueRef = useRef<string[]>([])
  const metaQueuedRef = useRef<Set<string>>(new Set())
  const metaInFlightRef = useRef(0)
  const META_CONCURRENCY = 4

  useEffect(() => {
    setLoading(true)
    metaCache.clear()
    window.api.listWorkspaceFolders(scanPath).then((f) => {
      setFolders(f)
      setMetaMap(new Map())
      setLoading(false)
    })
  }, [scanPath])

  const favoriteSet = useMemo(() => new Set(favoriteFolderPaths), [favoriteFolderPaths])

  const filtered = useMemo(() => {
    const matched = folders.filter(
      (f) =>
        (!search || f.name.toLowerCase().includes(search.toLowerCase())) &&
        (!favoritesOnly || favoriteSet.has(f.path)),
    )
    return sortFolders(matched, sortBy, favoriteSet)
  }, [folders, search, sortBy, favoritesOnly, favoriteSet])

  const loadFolderMeta = useCallback((path: string, fetch = false, force = false) => {
    const cacheKey = fetch ? `${path}:fetch` : path
    if (!force && !fetch && metaCache.has(path)) return Promise.resolve(metaCache.get(path)!)
    if (loadingPaths.current.has(cacheKey)) return Promise.resolve(undefined)
    loadingPaths.current.add(cacheKey)
    return window.api.getFolderGitMeta(path, fetch).then((meta) => {
      metaCache.set(path, meta)
      loadingPaths.current.delete(cacheKey)
      setMetaMap((prev) => {
        const next = new Map(prev)
        next.set(path, meta)
        return next
      })
      return meta
    })
  }, [])

  const drainMetaQueue = useCallback(() => {
    while (metaInFlightRef.current < META_CONCURRENCY && metaQueueRef.current.length > 0) {
      const path = metaQueueRef.current.shift()!
      metaInFlightRef.current += 1
      Promise.resolve(loadFolderMeta(path, false, false)).finally(() => {
        metaInFlightRef.current -= 1
        metaQueuedRef.current.delete(path)
        drainMetaQueue()
      })
    }
  }, [loadFolderMeta])

  const enqueueFolderMeta = useCallback(
    (path: string) => {
      if (metaQueuedRef.current.has(path)) return
      if (metaCache.has(path)) return
      metaQueuedRef.current.add(path)
      metaQueueRef.current.push(path)
      drainMetaQueue()
    },
    [drainMetaQueue],
  )

  useEffect(() => {
    if (loading || filtered.length === 0) return
    const root = tableWrapRef.current
    if (!root || typeof IntersectionObserver === 'undefined') return

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const path = (entry.target as HTMLElement).dataset.folderPath
          if (path) enqueueFolderMeta(path)
        }
      },
      { root, rootMargin: '80px', threshold: 0 },
    )

    const rows = root.querySelectorAll<HTMLElement>('[data-folder-path]')
    rows.forEach((row) => observer.observe(row))
    return () => observer.disconnect()
  }, [filtered, loading, enqueueFolderMeta])

  const refreshOne = useCallback(async (path: string) => {
    setRefreshingPaths((prev) => new Set(prev).add(path))
    metaCache.delete(path)
    try {
      await loadFolderMeta(path, true, true)
    } finally {
      setRefreshingPaths((prev) => {
        const next = new Set(prev)
        next.delete(path)
        return next
      })
    }
  }, [loadFolderMeta])

  const refreshAll = useCallback(async () => {
    setBulkRefreshing(true)
    setBulkSummary(null)
    metaCache.clear()
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
        const meta = metaMap.get(f.path)
        if (meta?.gitBranch) return true
        return isPullable(meta)
      })
      .map((f) => f.path)
  }, [filtered, metaMap])

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

    const confirmed = window.confirm(
      `Pull ${gitPaths.length} git folder(s)?\n\n` +
        'Each repo will checkout its main/master branch from origin and run git pull --ff-only. ' +
        'Repos with uncommitted changes are skipped.',
    )
    if (!confirmed) return

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
          className={`btn btn-sm ${favoritesOnly ? 'btn-accent' : ''}`}
          onClick={() => setFavoritesOnly((v) => !v)}
          title="Show only favorite folders"
          aria-pressed={favoritesOnly}
        >
          ★ Favorites
        </button>
        <button
          type="button"
          className={`btn btn-sm ${sortBy === 'name' ? 'btn-accent' : ''}`}
          onClick={() => onFoldersSortByChange?.('name')}
          aria-pressed={sortBy === 'name'}
        >
          Name
        </button>
        <button
          type="button"
          className={`btn btn-sm ${sortBy === 'recent' ? 'btn-accent' : ''}`}
          onClick={() => onFoldersSortByChange?.('recent')}
          aria-pressed={sortBy === 'recent'}
        >
          Recent
        </button>
        <span className="folders-count">
          {filtered.length} folder{filtered.length === 1 ? '' : 's'}
          {favoriteSet.size > 0 && !favoritesOnly ? ` · ${favoriteSet.size} starred` : ''}
        </span>
      </div>

      {bulkSummary && (
        <div className="folders-bulk-summary">
          <span>{bulkSummary}</span>
          <button type="button" className="folders-bulk-dismiss" onClick={() => setBulkSummary(null)}>
            ×
          </button>
        </div>
      )}

      <div className="folders-table-wrap" ref={tableWrapRef}>
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
          {filtered.length === 0 ? (
            <div className="folders-empty">
              {favoritesOnly
                ? 'No favorite folders yet. Star a repo from the list.'
                : 'No folders match your filter.'}
            </div>
          ) : null}
          {filtered.map((folder) => (
            <FolderRow
              key={folder.path}
              folder={folder}
              isFavorite={favoriteSet.has(folder.path)}
              onToggleFavorite={onToggleFavorite}
              onStartClaudeSession={onStartClaudeSession}
              gitInfo={
                metaMap.has(folder.path)
                  ? {
                      gitBranch: metaMap.get(folder.path)!.gitBranch,
                      gitRemote: metaMap.get(folder.path)!.gitRemote,
                    }
                  : undefined
              }
              syncStatus={metaMap.get(folder.path)}
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
