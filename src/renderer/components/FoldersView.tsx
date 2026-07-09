import React, { useEffect, useState, useCallback, memo, useMemo, useRef } from 'react'
import { WorkspaceFolder } from '../../shared/types'
import type { AgentProvider } from '../../shared/agent-provider'
import type { GitFolderMeta, GitPullOptions, GitSyncStatus } from '../../shared/ipc-types'
import { Skeleton } from './Skeleton'
import { PullConfirmModal, type PullConfirmChoice } from './PullConfirmModal'
import './FoldersView.css'

interface Props {
  scanPath: string
  favoriteFolderPaths?: string[]
  foldersSortBy?: 'name' | 'recent'
  onToggleFavorite?: (path: string) => void
  onFoldersSortByChange?: (sortBy: 'name' | 'recent') => void
  onStartSession?: (folder: WorkspaceFolder, useWorktree: boolean, provider: AgentProvider) => void
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
  const base = status.baseBranch ? ` vs origin/${status.baseBranch}` : ''
  if (status.error) {
    const local = syncLabel(status)
    return local && local !== 'error'
      ? `Fetch failed: ${status.error} (${local} from last fetch${base})`
      : `Fetch failed: ${status.error}`
  }
  if (status.state === 'synced') return `Up to date with remote${base}`
  if (status.state === 'behind') return `${status.commitsBehind} commit(s) behind${base}`
  if (status.state === 'ahead') return `${status.commitsAhead} commit(s) ahead${base}`
  if (status.state === 'diverged') {
    return `${status.commitsBehind} behind, ${status.commitsAhead} ahead${base}`
  }
  if (status.state === 'dirty') {
    return `${status.uncommitted} tracked file(s) changed — commit or stash before pull`
  }
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
  onStartSession,
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
  onStartSession?: (folder: WorkspaceFolder, useWorktree: boolean, provider: AgentProvider) => void
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

  const handleStartSession = (provider: AgentProvider) => {
    if (onStartSession) {
      const isGit = gitInfo != null && gitInfo.gitBranch !== null
      onStartSession(folder, isGit, provider)
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
            {canPull ? (
              <button
                type="button"
                className="btn btn-sm git-pull-btn"
                onClick={onPull}
                disabled={pulling || refreshing}
                title={
                  syncStatus.state === 'dirty'
                    ? `${syncTitle(syncStatus)} — click to choose stash or discard`
                    : `Checkout ${syncStatus.baseBranch ?? 'main/master'} and pull`
                }
              >
                {pulling ? '…' : 'Pull'}
              </button>
            ) : null}
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
            onClick={() => handleStartSession('claude')}
            title="Start Claude session in DevHub-AI"
          >
            Claude
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ide cursor-btn"
            onClick={() => handleStartSession('cursor')}
            title="Start Cursor Agent CLI session in DevHub-AI"
          >
            Agent
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ide shell-btn"
            onClick={() => handleStartSession('shell')}
            title="Start shell-only session in DevHub-AI"
          >
            Shell
          </button>
          <button
            type="button"
            className="btn btn-sm btn-ide cursor-ide-btn"
            onClick={() => handleOpenIde('cursor')}
            title="Open in Cursor IDE"
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
  onStartSession,
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
  const [pullConfirm, setPullConfirm] = useState<{
    path: string
    name: string
    baseBranch: string | null
    changes: { tracked: string[]; untracked: string[] }
  } | null>(null)
  const loadingPaths = useRef<Set<string>>(new Set())
  const tableWrapRef = useRef<HTMLDivElement>(null)
  const metaQueueRef = useRef<string[]>([])
  const metaQueuedRef = useRef<Set<string>>(new Set())
  const metaInFlightRef = useRef(0)
  const META_CONCURRENCY = 2
  const REFRESH_CONCURRENCY = 3

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
      const paths = filtered.map((f) => f.path)
      for (let i = 0; i < paths.length; i += REFRESH_CONCURRENCY) {
        const batch = paths.slice(i, i + REFRESH_CONCURRENCY)
        await Promise.all(batch.map((path) => refreshOne(path)))
      }
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

  const runPull = useCallback((path: string, options?: GitPullOptions) => {
    setPullingPaths((prev) => new Set(prev).add(path))
    setBulkSummary(null)
    void window.api.startPullFolderToBase(path, options)
  }, [])

  const handlePullOne = useCallback(
    async (path: string, folderName: string) => {
      const meta = metaMap.get(path)
      if (!isPullable(meta)) return

      try {
        const changes = await window.api.getFolderWorkingTree(path)
        const needsConfirm = changes.tracked.length > 0 || changes.untracked.length > 0
        if (needsConfirm) {
          setPullConfirm({
            path,
            name: folderName,
            baseBranch: meta?.baseBranch ?? null,
            changes,
          })
          return
        }
        runPull(path)
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        setBulkSummary(`${folderName}: ${msg}`)
      }
    },
    [metaMap, runPull],
  )

  const handlePullConfirm = useCallback(
    (choice: PullConfirmChoice) => {
      if (!pullConfirm) return
      const { path } = pullConfirm
      setPullConfirm(null)
      if (choice.action === 'cancel') return
      const options: GitPullOptions | undefined =
        choice.localChanges != null
          ? {
              localChanges: choice.localChanges,
              stashUntracked: choice.stashUntracked,
            }
          : undefined
      runPull(path, options)
    },
    [pullConfirm, runPull],
  )

  // Read via a ref rather than closing over `metaMap` directly: handlePullAll calls this twice
  // across an `await`, and a stale closure would keep seeing the pre-fetch (possibly empty) map.
  const metaMapRef = useRef(metaMap)
  metaMapRef.current = metaMap

  const resolveGitPaths = useCallback(() => {
    return filtered
      .filter((f) => {
        const meta = metaMapRef.current.get(f.path)
        if (meta?.gitBranch) return true
        return isPullable(meta)
      })
      .map((f) => f.path)
  }, [filtered])

  const handlePullAll = useCallback(async () => {
    let gitPaths = resolveGitPaths()
    if (gitPaths.length === 0) {
      setBulkSummary('Loading git info…')
      // Throttled to META_CONCURRENCY, matching the row-by-row IntersectionObserver loader —
      // an unbounded Promise.all here would fire one `git fetch` per folder at once.
      const queue = [...filtered]
      const worker = async () => {
        let next: WorkspaceFolder | undefined
        while ((next = queue.shift())) {
          await loadFolderMeta(next.path, true, true)
        }
      }
      await Promise.all(Array.from({ length: META_CONCURRENCY }, worker))
      gitPaths = resolveGitPaths()
    }
    if (gitPaths.length === 0) {
      setBulkSummary('No git folders to pull in the current list')
      return
    }

    const confirmed = window.confirm(
      `Pull ${gitPaths.length} git folder(s)?\n\n` +
        'Each repo will checkout its main/master branch from origin and run git pull --ff-only. ' +
        'Repos with uncommitted tracked changes are skipped — use per-row Pull for those (stash or discard).',
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
              onStartSession={onStartSession}
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
              onPull={() => void handlePullOne(folder.path, folder.name)}
              onRefresh={() => refreshOne(folder.path)}
            />
          ))}
        </div>
      </div>

      {pullConfirm && (
        <PullConfirmModal
          folderName={pullConfirm.name}
          baseBranch={pullConfirm.baseBranch}
          changes={pullConfirm.changes}
          onConfirm={handlePullConfirm}
          onClose={() => setPullConfirm(null)}
        />
      )}
    </div>
  )
}
