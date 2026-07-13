import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app, safeStorage } from 'electron'
import { normalizeWixUser, parseTrinoServerInput } from './trino-user'

const getStorePath = () => {
  const userDataPath = app.getPath('userData')
  mkdirSync(userDataPath, { recursive: true })
  return join(userDataPath, 'trino-credentials.json')
}

function credentialKey(server: string, user: string): string {
  const { server: resolved } = parseTrinoServerInput(server)
  return `${resolved.toLowerCase()}::${normalizeWixUser(user).toLowerCase()}`
}

export function hasTrinoCredential(server: string, user: string): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false
  const map = loadEncryptedMap()
  return credentialKey(server, user) in map
}

function loadEncryptedMap(): Record<string, string> {
  const storePath = getStorePath()
  if (!existsSync(storePath)) return {}
  try {
    return JSON.parse(readFileSync(storePath, 'utf-8'))
  } catch {
    return {}
  }
}

function saveEncryptedMap(map: Record<string, string>): void {
  writeFileSync(getStorePath(), JSON.stringify(map, null, 2), 'utf-8')
}

export function saveTrinoCredential(server: string, user: string, password: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS credential encryption is unavailable on this machine.')
  }
  const map = loadEncryptedMap()
  map[credentialKey(server, user)] = safeStorage.encryptString(password).toString('base64')
  saveEncryptedMap(map)
}

export function getTrinoCredential(server: string, user: string): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null
  const map = loadEncryptedMap()
  const encoded = map[credentialKey(server, user)]
  if (!encoded) return null
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch {
    return null
  }
}

export function deleteTrinoCredential(server: string, user: string): void {
  const map = loadEncryptedMap()
  const key = credentialKey(server, user)
  if (!(key in map)) return
  delete map[key]
  saveEncryptedMap(map)
}
