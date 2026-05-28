/**
 * Optimize `SELECT * … LIMIT n` for SSH-tunnel preview: truncate large column
 * payloads on the MySQL server so less data crosses the tunnel.
 * The editor still shows `SELECT *`; execution uses an equivalent projection.
 */

export const STAR_PREVIEW_MAX_LIMIT = 100
export const STAR_PREVIEW_MAX_CELL_CHARS = 2_048

export interface StarSelectPreview {
  database?: string
  table: string
  limit: number
}

const TABLE_IDENT = '(?:`(?:[^`]|``)+`|[A-Za-z0-9_]+)'
const STAR_SELECT_PREVIEW_RE = new RegExp(
  `^\\s*SELECT\\s+\\*\\s+FROM\\s+(${TABLE_IDENT}(?:\\.${TABLE_IDENT})?)\\s+LIMIT\\s+(\\d+)\\s*$`,
  'i',
)

function unquoteIdent(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('`') && trimmed.endsWith('`')) {
    return trimmed.slice(1, -1).replace(/``/g, '`')
  }
  return trimmed
}

/** Parse `SELECT * FROM table LIMIT n` (optional db prefix). */
export function parseStarSelectPreview(sql: string): StarSelectPreview | null {
  const body = sql.trim().replace(/;+\s*$/, '')
  if (/;\s*\S/.test(body)) return null
  const match = STAR_SELECT_PREVIEW_RE.exec(body)
  if (!match) return null

  const limit = Number.parseInt(match[2], 10)
  if (!Number.isFinite(limit) || limit <= 0 || limit > STAR_PREVIEW_MAX_LIMIT) return null

  const parts = match[1].split('.').map(unquoteIdent)
  if (parts.length === 1) {
    return { table: parts[0], limit }
  }
  if (parts.length === 2) {
    return { database: parts[0], table: parts[1], limit }
  }
  return null
}

export function isLargeColumnType(mysqlType: string): boolean {
  const base = mysqlType.toLowerCase().replace(/\(.*/, '').trim()
  return /text|blob|json/.test(base)
}

export interface StarPreviewColumn {
  name: string
  type: string
}

/** Build SELECT list that preserves column names but caps large types on the server. */
export function buildTunnelOptimizedStarSelect(
  escapeId: (id: string) => string,
  database: string | undefined,
  table: string,
  columns: StarPreviewColumn[],
  limit: number,
  maxChars = STAR_PREVIEW_MAX_CELL_CHARS,
): string {
  const tableRef = database
    ? `${escapeId(database)}.${escapeId(table)}`
    : escapeId(table)

  const selectList = columns
    .map((col) => {
      const id = escapeId(col.name)
      if (!isLargeColumnType(col.type)) return id
      return `SUBSTRING(CAST(${id} AS CHAR(${maxChars})), 1, ${maxChars}) AS ${id}`
    })
    .join(', ')

  return `SELECT ${selectList} FROM ${tableRef} LIMIT ${limit}`
}
