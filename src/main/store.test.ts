/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import { join } from 'path'

// Mock electron before imports
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-devhub-ai-userData')
  }
}))

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

import { loadState, saveState, flushSaveStateSync } from './store'

const storePath = '/tmp/test-devhub-ai-userData/state.json'

describe('store', () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockClear()
  })

  it('loadState() returns default state when file does not exist', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const state = loadState()

    expect(state.projects).toEqual([])
    expect(state.tags).toEqual([])
    expect(state.scanPath).toMatch(/Workspace$/)
    expect(fs.readFileSync).not.toHaveBeenCalled()
  })

  it('loadState() returns parsed JSON when file exists', () => {
    const savedState = {
      projects: [{ id: '1', name: 'Test', path: '/foo', tags: [], description: '', techStack: [], runCommand: '', port: null, lastOpened: null, hidden: false }],
      tags: ['a'],
      scanPath: '/custom/path'
    }
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(savedState))

    const state = loadState()

    expect(state).toEqual(savedState)
    expect(fs.readFileSync).toHaveBeenCalledWith(storePath, 'utf-8')
  })

  it('loadState() returns default state when JSON is invalid', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }')

    const state = loadState()

    expect(state.projects).toEqual([])
    expect(state.tags).toEqual([])
    expect(state.scanPath).toMatch(/Workspace$/)
  })

  it('flushSaveStateSync() writes JSON to correct path', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const state = { projects: [], tags: [], scanPath: '/foo' }

    saveState(state)
    flushSaveStateSync()

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      storePath,
      JSON.stringify(state, null, 2),
      'utf-8'
    )
  })

  it('default state has scanPath set to $HOME/Workspace', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const state = loadState()

    const expected = join(process.env.HOME || '~', 'Workspace')
    expect(state.scanPath).toBe(expected)
  })
})
