/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userDataDir = mkdtempSync(join(tmpdir(), 'trino-creds-test-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`, 'utf-8')),
    decryptString: vi.fn((buf: Buffer) => buf.toString('utf-8').replace(/^enc:/, '')),
  },
}))

describe('trino-credentials-store', () => {
  beforeEach(async () => {
    const storePath = join(userDataDir, 'trino-credentials.json')
    if (existsSync(storePath)) rmSync(storePath)
    vi.resetModules()
  })

  it('save and load credentials with normalized user key', async () => {
    const { saveTrinoCredential, getTrinoCredential } = await import('./trino-credentials-store')
    saveTrinoCredential('https://trino.wixprod.net:443', 'boris@wix.com', 'secret')
    expect(getTrinoCredential('https://trino.wixprod.net:443', 'boris')).toBe('secret')
  })

  it('delete removes stored credential', async () => {
    const { saveTrinoCredential, getTrinoCredential, deleteTrinoCredential } = await import(
      './trino-credentials-store'
    )
    saveTrinoCredential('https://trino.wixprod.net:443', 'boris', 'secret')
    deleteTrinoCredential('https://trino.wixprod.net:443', 'boris')
    expect(getTrinoCredential('https://trino.wixprod.net:443', 'boris')).toBeNull()
  })

  it('persists encrypted map to disk', async () => {
    const { saveTrinoCredential } = await import('./trino-credentials-store')
    saveTrinoCredential('https://trino.wixprod.net:443', 'boris', 'secret')
    const raw = readFileSync(join(userDataDir, 'trino-credentials.json'), 'utf-8')
    expect(raw).toContain('boris@wix.com')
    expect(raw).not.toContain('"secret"')
  })
})
