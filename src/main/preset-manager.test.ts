/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
}))

vi.mock('os', () => ({
  homedir: vi.fn().mockReturnValue('/tmp/test-home'),
}))

let uuidCounter = 0
vi.mock('crypto', () => ({
  randomUUID: vi.fn(() => `test-uuid-${uuidCounter++}`),
}))

import { PresetManager, SessionPreset, SessionPresetCreate } from './preset-manager'

const PRESETS_PATH = '/tmp/test-home/.devhub-ai/presets.json'

function makePresetInput(overrides: Partial<SessionPresetCreate> = {}): SessionPresetCreate {
  return {
    name: 'Test Preset',
    projectPath: '/home/user/projects/test',
    projectName: 'test',
    useWorktree: false,
    dangerousMode: false,
    pinned: false,
    ...overrides,
  }
}

describe('PresetManager', () => {
  let manager: PresetManager

  beforeEach(() => {
    vi.clearAllMocks()
    uuidCounter = 0
    manager = new PresetManager()
  })

  describe('loadPresets', () => {
    it('returns empty array when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = manager.loadPresets()

      expect(result).toEqual([])
      expect(fs.readFileSync).not.toHaveBeenCalled()
    })

    it('returns parsed presets when file exists', () => {
      const savedPresets: SessionPreset[] = [{
        id: 'abc',
        name: 'My Preset',
        projectPath: '/foo',
        projectName: 'foo',
        useWorktree: true,
        dangerousMode: false,
        pinned: true,
        createdAt: 1000,
        useCount: 5,
      }]
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(savedPresets))

      const result = manager.loadPresets()

      expect(result).toEqual(savedPresets)
      expect(fs.readFileSync).toHaveBeenCalledWith(PRESETS_PATH, 'utf-8')
    })

    it('returns empty array when JSON is invalid', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue('{ invalid json }')

      const result = manager.loadPresets()

      expect(result).toEqual([])
    })

    it('returns empty array when file contains non-array JSON', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ not: 'an array' }))

      const result = manager.loadPresets()

      expect(result).toEqual([])
    })
  })

  describe('savePreset', () => {
    it('creates a new preset with generated id and timestamps', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const now = Date.now()
      const result = manager.savePreset(makePresetInput({ name: 'Backend Debug' }))

      expect(result.id).toBe('test-uuid-0')
      expect(result.name).toBe('Backend Debug')
      expect(result.useCount).toBe(0)
      expect(result.createdAt).toBeGreaterThanOrEqual(now)
      // Should have persisted
      expect(fs.writeFileSync).toHaveBeenCalled()
      expect(fs.renameSync).toHaveBeenCalled()
    })

    it('uses atomic write (write tmp then rename)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      manager.savePreset(makePresetInput())

      const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0]
      expect(writeCall[0]).toBe(PRESETS_PATH + '.tmp')

      const renameCall = vi.mocked(fs.renameSync).mock.calls[0]
      expect(renameCall[0]).toBe(PRESETS_PATH + '.tmp')
      expect(renameCall[1]).toBe(PRESETS_PATH)
    })

    it('enforces max 50 presets', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      // UUIDs are auto-incremented via the mock counter

      for (let i = 0; i < 55; i++) {
        manager.savePreset(makePresetInput({ name: `Preset ${i}` }))
      }

      const all = manager.getAll()
      expect(all.length).toBeLessThanOrEqual(50)
    })
  })

  describe('updatePreset', () => {
    it('updates an existing preset', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const created = manager.savePreset(makePresetInput({ name: 'Original' }))

      const updated = manager.updatePreset(created.id, { name: 'Updated', pinned: true })

      expect(updated).not.toBeNull()
      expect(updated!.name).toBe('Updated')
      expect(updated!.pinned).toBe(true)
      expect(updated!.id).toBe(created.id) // id unchanged
    })

    it('returns null for non-existent preset', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = manager.updatePreset('nonexistent', { name: 'nope' })

      expect(result).toBeNull()
    })

    it('prevents overwriting id and createdAt', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const created = manager.savePreset(makePresetInput())

      const updated = manager.updatePreset(created.id, {
        id: 'hacked-id',
        createdAt: 0,
        name: 'Safe Update',
      } as Partial<SessionPreset>)

      expect(updated!.id).toBe(created.id)
      expect(updated!.createdAt).toBe(created.createdAt)
      expect(updated!.name).toBe('Safe Update')
    })
  })

  describe('deletePreset', () => {
    it('removes an existing preset', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const created = manager.savePreset(makePresetInput())

      const result = manager.deletePreset(created.id)

      expect(result).toBe(true)
      expect(manager.getAll()).toHaveLength(0)
    })

    it('returns false for non-existent preset', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = manager.deletePreset('nonexistent')

      expect(result).toBe(false)
    })
  })

  describe('getPreset', () => {
    it('returns preset by id', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const created = manager.savePreset(makePresetInput({ name: 'Find Me' }))

      const found = manager.getPreset(created.id)

      expect(found).not.toBeNull()
      expect(found!.name).toBe('Find Me')
    })

    it('returns null for non-existent id', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const found = manager.getPreset('nonexistent')

      expect(found).toBeNull()
    })
  })

  describe('recordUsage', () => {
    it('increments useCount and updates lastUsedAt', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const created = manager.savePreset(makePresetInput())
      expect(created.useCount).toBe(0)
      expect(created.lastUsedAt).toBeUndefined()

      const now = Date.now()
      const updated = manager.recordUsage(created.id)

      expect(updated).not.toBeNull()
      expect(updated!.useCount).toBe(1)
      expect(updated!.lastUsedAt).toBeGreaterThanOrEqual(now)
    })

    it('returns null for non-existent preset', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)

      const result = manager.recordUsage('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('getPinned', () => {
    it('returns only pinned presets', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      // UUIDs are auto-incremented via the mock counter

      manager.savePreset(makePresetInput({ name: 'Pinned', pinned: true }))
      manager.savePreset(makePresetInput({ name: 'Not Pinned', pinned: false }))
      manager.savePreset(makePresetInput({ name: 'Also Pinned', pinned: true }))

      const pinned = manager.getPinned()

      expect(pinned).toHaveLength(2)
      expect(pinned.map(p => p.name)).toContain('Pinned')
      expect(pinned.map(p => p.name)).toContain('Also Pinned')
    })
  })

  describe('getRecent', () => {
    it('returns recently used presets sorted by lastUsedAt', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      // UUIDs are auto-incremented via the mock counter

      const p1 = manager.savePreset(makePresetInput({ name: 'Old' }))
      const p2 = manager.savePreset(makePresetInput({ name: 'Recent' }))
      const p3 = manager.savePreset(makePresetInput({ name: 'Never Used' }))

      // Force distinct timestamps by mocking Date.now
      let mockTime = 1000
      const origNow = Date.now
      Date.now = () => ++mockTime

      manager.recordUsage(p1.id)
      manager.recordUsage(p2.id)

      Date.now = origNow

      const recent = manager.getRecent(5)

      expect(recent).toHaveLength(2) // p3 was never used
      expect(recent[0].name).toBe('Recent')
      expect(recent[1].name).toBe('Old')
    })

    it('respects limit', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      // UUIDs are auto-incremented via the mock counter

      for (let i = 0; i < 10; i++) {
        const p = manager.savePreset(makePresetInput({ name: `Preset ${i}` }))
        manager.recordUsage(p.id)
      }

      const recent = manager.getRecent(3)

      expect(recent).toHaveLength(3)
    })
  })

  describe('persistence roundtrip', () => {
    it('save then load preserves data', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false)
      const created = manager.savePreset(makePresetInput({ name: 'Persist Me', model: 'opus' }))
      manager.recordUsage(created.id)

      // Capture what was written
      const writtenData = vi.mocked(fs.writeFileSync).mock.calls.slice(-1)[0][1] as string

      // Create a new manager and load the written data
      const manager2 = new PresetManager()
      vi.mocked(fs.existsSync).mockReturnValue(true)
      vi.mocked(fs.readFileSync).mockReturnValue(writtenData)

      const loaded = manager2.loadPresets()

      expect(loaded).toHaveLength(1)
      expect(loaded[0].name).toBe('Persist Me')
      expect(loaded[0].model).toBe('opus')
      expect(loaded[0].useCount).toBe(1)
      expect(loaded[0].lastUsedAt).toBeDefined()
    })
  })
})
