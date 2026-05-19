/**
 * Parse MCP-S Connect toolkit URLs and pasted JSON into Claude mcpServers entries.
 * @see https://mcp-s-connect.wewix.net/
 */

export interface ParsedMcpImport {
  servers: Record<string, unknown>
  warnings: string[]
}

const MCP_S_CONNECT_HOST = 'mcp-s-connect.wewix.net'
const MCP_S_GATEWAY = 'https://mcp-s.wewix.net/mcp'

/** Toolkit slug from Connect URL path: /toolkits/{slug}/view */
export function parseMcpSConnectToolkitUrl(input: string): string | null {
  const trimmed = input.trim()
  try {
    const url = new URL(trimmed)
    if (!url.hostname.includes(MCP_S_CONNECT_HOST)) return null
    const match = url.pathname.match(/\/toolkits\/([^/]+)\/view\/?$/i)
    if (!match) return null
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

function serverNameFromToolkitSlug(slug: string): string {
  const lower = slug.toLowerCase()
  if (lower.includes('premium-de') || lower.endsWith(':premium-de')) return 'MCP-PremiumDE'
  if (lower.includes('premium-ba') || lower.endsWith(':premium-ba')) return 'MCP-PremiumBA'
  const safe = slug.replace(/[^a-zA-Z0-9@._-]/g, '-').slice(0, 48)
  return `MCP-${safe}`
}

function buildMcpSGatewayUrl(toolkitSlug: string): string {
  const encoded = encodeURIComponent(toolkitSlug)
  return `${MCP_S_GATEWAY}?toolkit=${encoded}`
}

export function toolkitSlugToMcpServer(toolkitSlug: string): Record<string, unknown> {
  const name = serverNameFromToolkitSlug(toolkitSlug)
  return {
    [name]: {
      type: 'http',
      url: buildMcpSGatewayUrl(toolkitSlug),
    },
  }
}

function normalizeServerEntry(entry: unknown): Record<string, unknown> | null {
  if (!entry || typeof entry !== 'object') return null
  const obj = entry as Record<string, unknown>
  if (typeof obj.url === 'string') {
    const out: Record<string, unknown> = { type: obj.type || 'http', url: obj.url }
    if (obj.headers && typeof obj.headers === 'object') out.headers = obj.headers
    return out
  }
  if (typeof obj.command === 'string') {
    const out: Record<string, unknown> = {
      command: obj.command,
      args: Array.isArray(obj.args) ? obj.args : [],
    }
    if (obj.env && typeof obj.env === 'object') out.env = obj.env
    return out
  }
  return null
}

/** Parse pasted JSON: full file, mcpServers wrapper, or single server object. */
export function parseMcpJsonPaste(raw: string): ParsedMcpImport {
  const warnings: string[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.trim())
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'Invalid JSON')
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON must be an object')
  }

  const root = parsed as Record<string, unknown>
  let servers: Record<string, unknown> = {}

  if (root.mcpServers && typeof root.mcpServers === 'object') {
    servers = { ...(root.mcpServers as Record<string, unknown>) }
  } else if (root.url || root.command) {
    warnings.push('Single server object without a name — use key "imported-server" or paste under mcpServers')
    const normalized = normalizeServerEntry(root)
    if (!normalized) throw new Error('Unrecognized server shape (need url or command)')
    servers = { 'imported-server': normalized }
  } else {
    const keys = Object.keys(root)
    const allLookLikeServers = keys.length > 0 && keys.every((k) => {
      const v = root[k]
      return v && typeof v === 'object' && (('url' in (v as object)) || ('command' in (v as object)))
    })
    if (allLookLikeServers) {
      servers = { ...root }
    } else {
      throw new Error('Expected { "mcpServers": { ... } } or named server entries')
    }
  }

  const normalized: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(servers)) {
    const n = normalizeServerEntry(entry)
    if (n) normalized[name] = n
    else warnings.push(`Skipped invalid server: ${name}`)
  }

  if (Object.keys(normalized).length === 0) {
    throw new Error('No valid MCP servers found in JSON')
  }

  return { servers: normalized, warnings }
}

/**
 * Import from MCP-S Connect toolkit URL, gateway URL, or JSON paste.
 */
export function importMcpDefinition(input: string): ParsedMcpImport {
  const trimmed = input.trim()
  if (!trimmed) throw new Error('Paste a toolkit URL or JSON')

  const toolkitSlug = parseMcpSConnectToolkitUrl(trimmed)
  if (toolkitSlug) {
    return {
      servers: toolkitSlugToMcpServer(toolkitSlug),
      warnings: [],
    }
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseMcpJsonPaste(trimmed)
  }

  if (trimmed.includes(MCP_S_CONNECT_HOST)) {
    throw new Error(
      'Toolkit URL must end with /view — e.g. https://mcp-s-connect.wewix.net/toolkits/you@wix.com:premium-de/view'
    )
  }

  if (trimmed.includes('mcp-s.wewix.net')) {
    const warnings: string[] = []
    const name = 'MCP-Imported'
    return {
      servers: {
        [name]: { type: 'http', url: trimmed.split(/\s/)[0] },
      },
      warnings,
    }
  }

  throw new Error(
    'Paste a MCP-S Connect toolkit URL (…/toolkits/{email}:premium-de/view) or JSON with mcpServers'
  )
}
