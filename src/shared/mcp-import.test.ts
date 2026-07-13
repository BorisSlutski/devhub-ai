import { describe, it, expect } from 'vitest'
import {
  parseMcpSConnectToolkitUrl,
  importMcpDefinition,
  parseMcpJsonPaste,
} from './mcp-import'

describe('parseMcpSConnectToolkitUrl', () => {
  it('extracts toolkit slug from view URL', () => {
    const slug = parseMcpSConnectToolkitUrl(
      'https://mcp-s-connect.wewix.net/toolkits/boriss@wix.com:premium-de/view'
    )
    expect(slug).toBe('boriss@wix.com:premium-de')
  })

  it('returns null for unrelated URLs', () => {
    expect(parseMcpSConnectToolkitUrl('https://example.com')).toBeNull()
  })
})

describe('importMcpDefinition', () => {
  it('builds Premium DE server from toolkit URL', () => {
    const { servers } = importMcpDefinition(
      'https://mcp-s-connect.wewix.net/toolkits/user@wix.com:premium-de/view'
    )
    expect(servers['MCP-PremiumDE']).toMatchObject({
      type: 'http',
      url: expect.stringContaining('toolkit=user%40wix.com%3Apremium-de'),
    })
  })

  it('parses mcpServers JSON', () => {
    const { servers } = importMcpDefinition(
      JSON.stringify({
        mcpServers: {
          'my-server': { url: 'https://example.com/mcp', type: 'http' },
        },
      })
    )
    expect(servers['my-server']).toEqual({
      type: 'http',
      url: 'https://example.com/mcp',
    })
  })
})

describe('parseMcpJsonPaste', () => {
  it('rejects invalid JSON', () => {
    expect(() => parseMcpJsonPaste('{ bad')).toThrow()
  })
})
