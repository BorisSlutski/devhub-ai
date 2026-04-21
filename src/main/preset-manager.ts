import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

export interface SessionPreset {
  id: string
  name: string
  projectPath: string
  projectName: string
  useWorktree: boolean
  dangerousMode: boolean
  model?: string
  initialCommands?: string[]
  pinned: boolean
  icon?: string
  createdAt: number
  lastUsedAt?: number
  useCount: number
}

export type SessionPresetCreate = Omit<SessionPreset, 'id' | 'createdAt' | 'useCount'>

const MAX_PRESETS = 50

function getPresetsPath(): string {
  const dir = join(homedir(), '.devhub-ai')
  mkdirSync(dir, { recursive: true })
  return join(dir, 'presets.json')
}

export class PresetManager {
  private presets: SessionPreset[] = []
  private loaded = false

  loadPresets(): SessionPreset[] {
    const filePath = getPresetsPath()
    if (!existsSync(filePath)) {
      this.presets = []
      this.loaded = true
      return []
    }
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      this.presets = Array.isArray(parsed) ? parsed : []
      this.loaded = true
      return [...this.presets]
    } catch {
      this.presets = []
      this.loaded = true
      return []
    }
  }

  savePreset(input: SessionPresetCreate): SessionPreset {
    this.ensureLoaded()
    const preset: SessionPreset = {
      ...input,
      id: randomUUID(),
      createdAt: Date.now(),
      useCount: 0,
    }
    this.presets.push(preset)
    // Enforce soft limit — keep newest
    if (this.presets.length > MAX_PRESETS) {
      this.presets = this.presets
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_PRESETS)
    }
    this.persist()
    return preset
  }

  updatePreset(id: string, partial: Partial<SessionPreset>): SessionPreset | null {
    this.ensureLoaded()
    const index = this.presets.findIndex(p => p.id === id)
    if (index === -1) return null
    // Prevent overwriting immutable fields
    const { id: _id, createdAt: _ca, ...safePartial } = partial
    this.presets[index] = { ...this.presets[index], ...safePartial }
    this.persist()
    return { ...this.presets[index] }
  }

  deletePreset(id: string): boolean {
    this.ensureLoaded()
    const before = this.presets.length
    this.presets = this.presets.filter(p => p.id !== id)
    if (this.presets.length < before) {
      this.persist()
      return true
    }
    return false
  }

  getPreset(id: string): SessionPreset | null {
    this.ensureLoaded()
    return this.presets.find(p => p.id === id) ?? null
  }

  recordUsage(id: string): SessionPreset | null {
    this.ensureLoaded()
    const preset = this.presets.find(p => p.id === id)
    if (!preset) return null
    preset.useCount += 1
    preset.lastUsedAt = Date.now()
    this.persist()
    return { ...preset }
  }

  getPinned(): SessionPreset[] {
    this.ensureLoaded()
    return this.presets.filter(p => p.pinned)
  }

  getRecent(limit = 5): SessionPreset[] {
    this.ensureLoaded()
    return [...this.presets]
      .filter(p => p.lastUsedAt != null)
      .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
      .slice(0, limit)
  }

  getAll(): SessionPreset[] {
    this.ensureLoaded()
    return [...this.presets]
  }

  private ensureLoaded(): void {
    if (!this.loaded) {
      this.loadPresets()
    }
  }

  private persist(): void {
    const filePath = getPresetsPath()
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })

    const tmpPath = filePath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(this.presets, null, 2), 'utf-8')
    renameSync(tmpPath, filePath)
  }
}

export const presetManager = new PresetManager()
