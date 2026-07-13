/** Wix's Trino/LDAP identity requires the full `user@wix.com` form — bare usernames are rejected. */
export function normalizeWixUser(user: string): string {
  const trimmed = user.trim()
  return trimmed && !trimmed.includes('@') ? `${trimmed}@wix.com` : trimmed
}

export interface ParsedTrinoServerInput {
  server: string
  catalog?: string
  schema?: string
}

/** REST client base URL — `https://host:port` (not JDBC). */
export function normalizeTrinoServerUrl(server: string): string {
  const trimmed = server.trim()
  if (!trimmed) return ''
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '')
  }
  return `https://${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`
}

/**
 * Accept DataGrip/JDBC URLs (`jdbc:trino://host:443`) and bare `host:443`.
 * Optional `/catalog/schema` path segments are extracted when present.
 */
export function parseTrinoServerInput(raw: string): ParsedTrinoServerInput {
  const trimmed = raw.trim()
  if (!trimmed) return { server: '' }

  const jdbc = /^jdbc:trino:\/\/([^/?#]+)(?:\/([^?#]*))?/i.exec(trimmed)
  if (jdbc) {
    const pathParts = (jdbc[2] || '').split('/').filter(Boolean)
    return {
      server: normalizeTrinoServerUrl(`https://${jdbc[1]}`),
      catalog: pathParts[0],
      schema: pathParts[1],
    }
  }

  const trinoScheme = /^trino:\/\/([^/?#]+)(?:\/([^?#]*))?/i.exec(trimmed)
  if (trinoScheme) {
    const pathParts = (trinoScheme[2] || '').split('/').filter(Boolean)
    return {
      server: normalizeTrinoServerUrl(`https://${trinoScheme[1]}`),
      catalog: pathParts[0],
      schema: pathParts[1],
    }
  }

  return { server: normalizeTrinoServerUrl(trimmed) }
}

export interface ParsedTableNavigatorInput {
  catalog?: string
  schema?: string
  /** Bare or partial table name to search for. */
  tableFilter: string
}

/**
 * Parse sidebar/SQL navigator input:
 * - `prod.premium.events` → catalog, schema, filter
 * - `premium.events` → schema, filter (catalog from session)
 * - `events` → filter only (global search)
 */
export function parseTableNavigatorInput(raw: string): ParsedTableNavigatorInput {
  const trimmed = raw.trim()
  if (!trimmed) return { tableFilter: '' }
  const parts = trimmed.split('.').map((p) => p.trim()).filter(Boolean)
  if (parts.length >= 3) {
    return {
      catalog: parts[0],
      schema: parts[1],
      tableFilter: parts.slice(2).join('.'),
    }
  }
  if (parts.length === 2) {
    return { schema: parts[0], tableFilter: parts[1] }
  }
  return { tableFilter: parts[0] }
}

/** Pull catalog.schema.table from the first FROM/JOIN in SQL (for auto-fill). */
export function extractQualifiedTableFromSql(sql: string): ParsedTableNavigatorInput | null {
  const m = sql.match(
    /\b(?:FROM|JOIN)\s+([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)/i,
  )
  if (m) {
    return { catalog: m[1], schema: m[2], tableFilter: m[3] }
  }
  const m2 = sql.match(/\b(?:FROM|JOIN)\s+([a-zA-Z_][\w$]*)\.([a-zA-Z_][\w$]*)/i)
  if (m2) {
    return { schema: m2[1], tableFilter: m2[2] }
  }
  return null
}
