/** Session accent colors for sidebar chips and grid borders */
export const SESSION_ACCENT_COLORS = [
  { id: 'blue', hex: '#58a6ff', label: 'Blue' },
  { id: 'green', hex: '#3fb950', label: 'Green' },
  { id: 'purple', hex: '#bc8cff', label: 'Purple' },
  { id: 'orange', hex: '#d29922', label: 'Orange' },
  { id: 'red', hex: '#f85149', label: 'Red' },
  { id: 'cyan', hex: '#39c5cf', label: 'Cyan' },
  { id: 'pink', hex: '#f778ba', label: 'Pink' },
  { id: 'yellow', hex: '#e3b341', label: 'Gold' },
] as const

export type SessionAccentId = (typeof SESSION_ACCENT_COLORS)[number]['id']

export function accentHex(id: string | undefined | null): string {
  return SESSION_ACCENT_COLORS.find(c => c.id === id)?.hex ?? SESSION_ACCENT_COLORS[0].hex
}

export type GridLayout =
  | '1x1' | '1x2' | '2x1' | '2x2'
  | '1x3' | '3x1' | '2x3' | '3x2' | '2x4' | '4x2'

export const GRID_LAYOUT_CONFIG: Record<GridLayout, { cols: number; rows: number; max: number }> = {
  '1x1': { cols: 1, rows: 1, max: 1 },
  '1x2': { cols: 2, rows: 1, max: 2 },
  '2x1': { cols: 1, rows: 2, max: 2 },
  '2x2': { cols: 2, rows: 2, max: 4 },
  '1x3': { cols: 3, rows: 1, max: 3 },
  '3x1': { cols: 1, rows: 3, max: 3 },
  '2x3': { cols: 3, rows: 2, max: 6 },
  '3x2': { cols: 2, rows: 3, max: 6 },
  '2x4': { cols: 4, rows: 2, max: 8 },
  '4x2': { cols: 2, rows: 4, max: 8 },
}

/** Pick a sensible grid layout for N sessions (max 8). */
export function layoutForCount(count: number): GridLayout {
  if (count <= 1) return '1x1'
  if (count === 2) return '1x2'
  if (count <= 4) return '2x2'
  if (count <= 6) return '2x3'
  return '2x4'
}

export interface SessionUiState {
  sessionOrder: string[]
  gridMode: boolean
  gridLayout: GridLayout
  gridSessionIds: string[]
}

export const DEFAULT_SESSION_UI: SessionUiState = {
  sessionOrder: [],
  gridMode: false,
  gridLayout: '1x1',
  gridSessionIds: [],
}
