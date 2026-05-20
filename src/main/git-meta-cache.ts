import type { GitFolderMeta } from '../shared/ipc-types'

const TTL_MS = 5 * 60 * 1000

const cache = new Map<string, { meta: GitFolderMeta; at: number }>()

export function getCachedFolderMeta(folderPath: string): GitFolderMeta | null {
  const entry = cache.get(folderPath)
  if (!entry) return null
  if (Date.now() - entry.at > TTL_MS) {
    cache.delete(folderPath)
    return null
  }
  return entry.meta
}

export function setCachedFolderMeta(folderPath: string, meta: GitFolderMeta): void {
  cache.set(folderPath, { meta, at: Date.now() })
}

export function invalidateFolderMeta(folderPath: string): void {
  cache.delete(folderPath)
}
