import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { writeFile } from 'fs/promises'
import { join } from 'path'
import { app } from 'electron'
import { AppState } from '../shared/types'

const SAVE_DEBOUNCE_MS = 250

const getStorePath = () => {
  const userDataPath = app.getPath('userData')
  mkdirSync(userDataPath, { recursive: true })
  return join(userDataPath, 'state.json')
}

const defaultState: AppState = {
  projects: [],
  tags: [],
  scanPath: join(process.env.HOME || '~', 'Workspace')
}

let pendingState: AppState | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let flushPromise: Promise<void> | null = null

export function loadState(): AppState {
  const storePath = getStorePath()
  if (!existsSync(storePath)) {
    return { ...defaultState }
  }

  try {
    const raw = readFileSync(storePath, 'utf-8')
    return JSON.parse(raw) as AppState
  } catch {
    return { ...defaultState }
  }
}

async function writeStateToDisk(state: AppState): Promise<void> {
  const storePath = getStorePath()
  await writeFile(storePath, JSON.stringify(state, null, 2), 'utf-8')
}

/** Debounced persist — avoids blocking the main process on every UI toggle. */
export function saveState(state: AppState): void {
  pendingState = state
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const toWrite = pendingState
    pendingState = null
    if (!toWrite) return
    flushPromise = writeStateToDisk(toWrite).catch((err) => {
      console.error('[store] async save failed:', err)
    })
  }, SAVE_DEBOUNCE_MS)
}

/** Flush pending state before quit (sync fallback if write is in flight). */
export function flushSaveStateSync(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const toWrite = pendingState
  pendingState = null
  if (toWrite) {
    const storePath = getStorePath()
    writeFileSync(storePath, JSON.stringify(toWrite, null, 2), 'utf-8')
  }
}

export function flushSaveState(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const toWrite = pendingState
  pendingState = null
  if (!toWrite) {
    return flushPromise ?? Promise.resolve()
  }
  flushPromise = writeStateToDisk(toWrite)
  return flushPromise
}
