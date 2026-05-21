import { execFile, spawn, ChildProcess } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { BrowserWindow } from 'electron'
import { mysqlClient } from './mysql-client'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DbProducer {
  name: string // full akeyless path e.g. "/prod/dba/developer-access/mysql/kgb-xxx/cluster/dbname"
  cluster: string // extracted cluster name (7th segment)
  database: string // extracted database/host name (8th segment)
  dbName: string // actual database name from secure_remote_access_details.db_name
  type: 'mysql' | 'mongo'
}

export interface DbCredentials {
  user: string
  password: string
}

export interface TunnelInfo {
  id: string
  producerName: string
  host: string // the remote DB host from akeyless item metadata
  dbName: string // database name from akeyless item metadata
  localPort: number
  credentials: DbCredentials
  cluster: string
  database: string
  type: 'mysql' | 'mongo'
  process: ChildProcess | null
  connected: boolean
  /** Set when we intentionally kill the tunnel (avoid duplicate close notifications). */
  closing?: boolean
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MYSQL_PRODUCER_PATH = '/prod/dba/developer-access/mysql'
const MONGO_PRODUCER_PATH = '/prod/dba/developer-access/mongo'
const AKEYLESS_PROFILE = 'wix-keycloak'
const CERT_ISSUER = '/prod/dba/dbaccess-cert-issuer'
const GATEWAY_URL = 'https://restapi.prod-access.wewix.net'
const SSH_BASTION = 'ssh.prod-access.wewix.net:22'
const CLI_TIMEOUT = 120_000
const PORT_RANGE_MIN = 2000
const PORT_RANGE_MAX = 2050
/** In-memory cache — avoids hammering the gateway when reopening the picker. */
const PRODUCERS_CACHE_TTL_MS = 10 * 60 * 1000
/** Disk cache kept longer for gateway outage fallback. */
const PRODUCERS_DISK_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const PRODUCERS_DISK_CACHE_FILE = join(homedir(), '.devhub-ai', 'db-producers-cache.json')
const MAX_CLI_RETRIES = 4
const CLI_RETRY_DELAYS_MS = [0, 800, 1600, 3200, 6400]

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const activeTunnels = new Map<string, TunnelInfo>()
const producerDetailsCache = new Map<string, { host: string; dbName: string }>()
let producersListCache: { at: number; producers: DbProducer[] } | null = null
let resolvedBinaryPath: string | null = null
let mainWindowRef: BrowserWindow | null = null
let cliQueue: Promise<void> = Promise.resolve()

export function setAkeylessDbMainWindow(win: BrowserWindow | null): void {
  mainWindowRef = win
}

function enqueueCli<T>(fn: () => Promise<T>): Promise<T> {
  const run = cliQueue.then(fn, fn)
  cliQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

function notifyTunnelClosed(tunnelId: string, reason: string): void {
  const win = mainWindowRef
  if (win && !win.isDestroyed()) {
    win.webContents.send('db-tunnel-closed', { connectionId: tunnelId, reason })
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Discovers the akeyless CLI binary path.
 * Checks common installation locations and falls back to bare name (relies on PATH).
 */
function findAkeylessBinary(): string {
  if (resolvedBinaryPath) return resolvedBinaryPath

  const candidates = [
    '/opt/homebrew/bin/akeyless',
    '/usr/local/bin/akeyless',
    join(homedir(), 'akeyless'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      resolvedBinaryPath = candidate
      return resolvedBinaryPath
    }
  }

  // Fall back to bare command — let the OS resolve via PATH
  resolvedBinaryPath = 'akeyless'
  return resolvedBinaryPath
}

/**
 * Returns a copy of `process.env` with the AKEYLESS_GATEWAY_URL set.
 */
function envWithGateway(): NodeJS.ProcessEnv {
  return { ...process.env, AKEYLESS_GATEWAY_URL: GATEWAY_URL }
}

/**
 * Returns a copy of `process.env` with AKEYLESS_GATEWAY_URL removed.
 */
function envWithoutGateway(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.AKEYLESS_GATEWAY_URL
  return env
}

function execAkeylessOnce(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = findAkeylessBinary()
    execFile(
      bin,
      args,
      { timeout: CLI_TIMEOUT, env: envWithGateway(), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message))
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * Runs an akeyless CLI command via `execFile`. Serialized through a queue so
 * list-items does not run concurrently with connect/credential calls (can
 * disrupt active SSH tunnels). Retries transient gateway errors with backoff.
 */
function runAkeylessCommand(args: string[]): Promise<string> {
  return enqueueCli(async () => {
    let lastErr: Error | null = null
    for (let attempt = 0; attempt <= MAX_CLI_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = CLI_RETRY_DELAYS_MS[attempt] ?? 6400
        await new Promise((r) => setTimeout(r, delay))
      }
      try {
        return await execAkeylessOnce(args)
      } catch (err: any) {
        const msg = err?.message ?? String(err)
        lastErr = new Error(msg)
        const isTransient = isTransientCliError(msg)
        if (isTransient && attempt < MAX_CLI_RETRIES) {
          console.warn(
            `[akeyless-db] transient error for '${args[0]}', retry ${attempt + 1}/${MAX_CLI_RETRIES}: ${msg}`,
          )
          continue
        }
        throw new Error(`akeyless ${args[0]} failed: ${msg}`)
      }
    }
    throw new Error(`akeyless ${args[0]} failed: ${lastErr?.message ?? 'unknown error'}`)
  })
}

/**
 * Extracts the database type from a full akeyless producer path.
 */
function typeFromPath(name: string): 'mysql' | 'mongo' {
  if (name.startsWith(MYSQL_PRODUCER_PATH)) return 'mysql'
  return 'mongo'
}

/**
 * Parses a producer path for picker display.
 * Path: /prod/dba/developer-access/mysql/<kgb-id>/.../pdb-mysql-host.42-db_name
 */
function parseProducerPath(name: string): { cluster: string; database: string; dbName: string } {
  const parts = name.split('/').filter(Boolean)
  const typeIdx = parts.findIndex((p) => p === 'mysql' || p === 'mongo')
  const cluster = typeIdx >= 0 ? (parts[typeIdx + 1] ?? '') : ''
  const leaf = parts[parts.length - 1] ?? ''
  const dbName = dbNameFromLeaf(leaf)
  return { cluster, database: leaf, dbName }
}

/** e.g. pdb-mysql-billing0a.42-wix_billing → wix_billing */
function dbNameFromLeaf(leaf: string): string {
  const dotted = leaf.match(/\.[\da-z.]+-(.+)$/i)
  if (dotted) return dotted[1]
  const dashed = leaf.match(/-([a-z0-9_]+)$/i)
  return dashed ? dashed[1] : leaf
}

function isTransientCliError(msg: string): boolean {
  return /unexpected EOF|read body failed|connection reset|ECONNRESET|ETIMEDOUT|socket hang up/i.test(
    msg,
  )
}

function readDiskProducersCache(): { at: number; producers: DbProducer[] } | null {
  try {
    if (!existsSync(PRODUCERS_DISK_CACHE_FILE)) return null
    const raw = readFileSync(PRODUCERS_DISK_CACHE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as { at?: number; producers?: DbProducer[] }
    if (!parsed.at || !Array.isArray(parsed.producers) || parsed.producers.length === 0) return null
    return { at: parsed.at, producers: parsed.producers }
  } catch {
    return null
  }
}

function writeDiskProducersCache(producers: DbProducer[]): void {
  try {
    const dir = join(homedir(), '.devhub-ai')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(
      PRODUCERS_DISK_CACHE_FILE,
      JSON.stringify({ at: Date.now(), producers }),
      'utf-8',
    )
  } catch (err: any) {
    console.warn('[akeyless-db] failed to write disk cache:', err.message)
  }
}

function parseListItemsToProducers(stdout: string, dbType: 'mysql' | 'mongo'): DbProducer[] {
  const results: DbProducer[] = []
  let parsed: any
  try {
    parsed = JSON.parse(stdout)
  } catch {
    const lines = stdout.split('\n')
    for (const line of lines) {
      const match = line.match(/"item_name"\s*:\s*"([^"]+)"/)
      if (!match) continue
      const name = match[1]
      const { cluster, database, dbName } = parseProducerPath(name)
      results.push({ name, cluster, database, dbName, type: dbType })
    }
    return results
  }

  const items: any[] = parsed?.items ?? (Array.isArray(parsed) ? parsed : [])
  for (const item of items) {
    const name: string = item.item_name ?? item.name ?? ''
    if (!name) continue
    const { cluster, database, dbName } = parseProducerPath(name)
    const sra = item?.item_general_info?.secure_remote_access_details
    const resolvedDbName: string = sra?.db_name ?? dbName
    results.push({
      name,
      cluster,
      database,
      dbName: resolvedDbName,
      type: dbType,
    })
    if (sra) {
      const hostRaw = sra.host
      const host: string = Array.isArray(hostRaw) ? hostRaw[0] : String(hostRaw ?? '')
      if (host) {
        producerDetailsCache.set(name, { host, dbName: resolvedDbName })
      }
    }
  }
  return results
}

/** Small paginated folder listing under a producer root (mysql/mongo). */
async function listKgbFolderPaths(rootPath: string): Promise<string[]> {
  const folders: string[] = []
  let token: string | undefined
  for (;;) {
    const args = [
      'list-items',
      '--path',
      rootPath,
      '--current-folder',
      '--profile',
      AKEYLESS_PROFILE,
      '--json',
    ]
    if (token) args.push('--pagination-token', token)
    const stdout = await runAkeylessCommand(args)
    const parsed = JSON.parse(stdout)
    for (const f of parsed.folders ?? []) {
      folders.push(String(f).replace(/\/$/, ''))
    }
    token = parsed.next_page
    if (!token) break
  }
  return folders
}

/** list-items for one filter prefix — minimal JSON payload. */
async function listItemsForFilter(filterPath: string, dbType: 'mysql' | 'mongo'): Promise<DbProducer[]> {
  const stdout = await runAkeylessCommand([
    'list-items',
    '--filter',
    filterPath,
    '--type',
    'dynamic-secret',
    '--profile',
    AKEYLESS_PROFILE,
    '--json',
    '--minimal-view',
    '--auto-pagination=enabled',
  ])
  return parseListItemsToProducers(stdout, dbType)
}

/**
 * Loads producers for a root path. Tries one bulk request first; on EOF falls back
 * to per-kgb-folder requests (much smaller responses, far less likely to truncate).
 */
async function listProducersForRoot(rootPath: string, dbType: 'mysql' | 'mongo'): Promise<DbProducer[]> {
  try {
    return await listItemsForFilter(rootPath, dbType)
  } catch (bulkErr: any) {
    const msg = bulkErr?.message ?? String(bulkErr)
    if (!isTransientCliError(msg)) throw bulkErr
    console.warn(`[akeyless-db] bulk list-items failed for ${rootPath}, using per-kgb chunks:`, msg)
  }

  const folders = await listKgbFolderPaths(rootPath)
  if (folders.length === 0) {
    throw new Error(`No producer folders found under ${rootPath}`)
  }

  const results: DbProducer[] = []
  const seen = new Set<string>()
  const chunkErrors: string[] = []

  for (const folder of folders) {
    try {
      const chunk = await listItemsForFilter(folder, dbType)
      for (const p of chunk) {
        if (seen.has(p.name)) continue
        seen.add(p.name)
        results.push(p)
      }
    } catch (err: any) {
      chunkErrors.push(`${folder}: ${err.message}`)
      console.error(`[akeyless-db] list-items chunk failed for ${folder}:`, err.message)
    }
  }

  if (results.length === 0) {
    throw new Error(
      chunkErrors.length > 0
        ? `Failed to load producers: ${chunkErrors.slice(0, 3).join('; ')}`
        : `No producers found under ${rootPath}`,
    )
  }

  console.log(
    `[akeyless-db] loaded ${results.length} producers from ${folders.length} kgb folders under ${rootPath}`,
  )
  return results
}

/**
 * Picks the next free local port in [min, max], avoiding ports used by active tunnels.
 */
function allocatePort(min: number = PORT_RANGE_MIN, max: number = PORT_RANGE_MAX): number {
  const used = new Set<number>()
  for (const tunnel of activeTunnels.values()) {
    used.add(tunnel.localPort)
  }
  for (let port = min; port <= max; port++) {
    if (!used.has(port)) return port
  }
  throw new Error(
    `No free local ports for database tunnel (${min}-${max}). Close other connections.`,
  )
}

/**
 * Generates a unique tunnel ID.
 */
function generateTunnelId(): string {
  return `tunnel-${Date.now().toString(36)}`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Lists akeyless dynamic-secret producers for the given database type(s).
 * When `type` is omitted, both mysql and mongo producers are returned.
 */
export interface ListProducersResult {
  producers: DbProducer[]
  stale?: boolean
}

export function clearProducersCache(): void {
  producersListCache = null
}

function filterByType(producers: DbProducer[], type?: 'mysql' | 'mongo'): DbProducer[] {
  if (!type) return producers
  return producers.filter((p) => p.type === type)
}

export async function listProducers(
  type?: 'mysql' | 'mongo',
  options?: { forceRefresh?: boolean },
): Promise<ListProducersResult> {
  const now = Date.now()
  if (
    !options?.forceRefresh &&
    producersListCache &&
    now - producersListCache.at < PRODUCERS_CACHE_TTL_MS
  ) {
    return { producers: filterByType(producersListCache.producers, type) }
  }

  const diskCache = !options?.forceRefresh ? readDiskProducersCache() : null

  const roots: Array<{ path: string; dbType: 'mysql' | 'mongo' }> = []
  if (!type || type === 'mysql') roots.push({ path: MYSQL_PRODUCER_PATH, dbType: 'mysql' })
  if (!type || type === 'mongo') roots.push({ path: MONGO_PRODUCER_PATH, dbType: 'mongo' })

  const results: DbProducer[] = []
  const seenNames = new Set<string>()
  const errors: string[] = []

  for (const { path, dbType } of roots) {
    try {
      const chunk = await listProducersForRoot(path, dbType)
      for (const p of chunk) {
        if (seenNames.has(p.name)) continue
        seenNames.add(p.name)
        results.push(p)
      }
    } catch (err: any) {
      console.error(`[akeyless-db] list producers failed for ${path}:`, err.message)
      errors.push(err.message)
    }
  }

  if (results.length > 0) {
    producersListCache = { at: Date.now(), producers: results }
    writeDiskProducersCache(results)
    return { producers: filterByType(results, type) }
  }

  if (diskCache && diskCache.producers.length > 0) {
    producersListCache = { at: diskCache.at, producers: diskCache.producers }
    console.warn('[akeyless-db] gateway failed; serving stale disk cache')
    return {
      producers: filterByType(diskCache.producers, type),
      stale: true,
    }
  }

  throw new Error(
    errors.length > 0 ? errors.join('; ') : 'Failed to load database producers from Akeyless',
  )
}

/**
 * Retrieves temporary credentials for a given dynamic secret producer.
 */
export async function getCredentials(producerName: string): Promise<DbCredentials> {
  const args = [
    'get-dynamic-secret-value',
    '--name',
    producerName,
    '--profile',
    AKEYLESS_PROFILE,
  ]

  const stdout = await runAkeylessCommand(args)

  let parsed: any
  try {
    parsed = JSON.parse(stdout)
  } catch {
    // Fallback: grep-style extraction (mirrors the shell script)
    let user = ''
    let password = ''
    for (const line of stdout.split('\n')) {
      if (line.includes('password')) {
        const match = line.match(/:\s*"?([^",]+)"?/)
        if (match) password = match[1].trim()
      } else if (line.includes('user')) {
        const match = line.match(/:\s*"?([^",]+)"?/)
        if (match) user = match[1].trim()
      }
    }
    if (!user || !password) {
      throw new Error('Failed to parse credentials from akeyless output')
    }
    return { user, password }
  }

  const user = parsed.user ?? parsed.username ?? ''
  const password = parsed.password ?? ''

  if (!user || !password) {
    throw new Error('Credentials response missing user or password fields')
  }

  return { user, password }
}

/**
 * Fetches host and dbName for connect — uses describe-item (one item) instead of
 * scanning the full producer list (which often hits unexpected EOF).
 */
export async function getProducerDetails(
  producerName: string,
): Promise<{ host: string; dbName: string }> {
  const cached = producerDetailsCache.get(producerName)
  if (cached) {
    console.log(`[akeyless-db] getProducerDetails cache hit for ${producerName}`)
    return cached
  }

  console.log(`[akeyless-db] getProducerDetails via describe-item for ${producerName}`)

  const stdout = await runAkeylessCommand([
    'describe-item',
    '--name',
    producerName,
    '--profile',
    AKEYLESS_PROFILE,
    '--json',
  ])

  let parsed: any
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('Failed to parse describe-item JSON output for producer details')
  }

  const sraDetails = parsed?.item_general_info?.secure_remote_access_details
  if (!sraDetails) {
    throw new Error(`No secure_remote_access_details found for producer: ${producerName}`)
  }

  const hostRaw = sraDetails.host
  const host: string = Array.isArray(hostRaw) ? hostRaw[0] : String(hostRaw ?? '')
  const dbName: string = String(sraDetails.db_name ?? dbNameFromLeaf(producerName.split('/').pop() ?? ''))

  if (!host) {
    throw new Error(`No host found in producer details for: ${producerName}`)
  }

  const details = { host, dbName }
  producerDetailsCache.set(producerName, details)
  return details
}

/**
 * Opens an SSH tunnel to the database via `akeyless connect`.
 *
 * Orchestrates: fetch producer metadata, obtain temporary credentials,
 * pick a local port, and spawn the long-running tunnel process.
 */
export async function openTunnel(producerName: string): Promise<TunnelInfo> {
  const [details, credentials] = await Promise.all([
    getProducerDetails(producerName),
    getCredentials(producerName),
  ])

  const localPort = allocatePort()
  const tunnelId = generateTunnelId()
  const { cluster, database } = parseProducerPath(producerName)
  const dbType = typeFromPath(producerName)
  const bin = findAkeylessBinary()

  const flag = `'-L :${localPort}:${details.host}'`

  const child = spawn(
    bin,
    [
      'connect',
      '-t',
      details.host,
      '-v',
      SSH_BASTION,
      '-n',
      producerName,
      `-T=${flag}`,
      '-c',
      CERT_ISSUER,
      '--profile',
      AKEYLESS_PROFILE,
    ],
    {
      env: envWithoutGateway(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    },
  )

  const tunnelInfo: TunnelInfo = {
    id: tunnelId,
    producerName,
    host: details.host,
    dbName: details.dbName,
    localPort,
    credentials,
    cluster,
    database,
    type: dbType,
    process: child,
    connected: true,
  }

  activeTunnels.set(tunnelId, tunnelInfo)

  // Handle process lifecycle
  child.on('error', (err) => {
    console.error(`[akeyless-db] tunnel ${tunnelId} error:`, err.message)
    tunnelInfo.connected = false
    tunnelInfo.process = null
  })

  child.on('exit', (code, signal) => {
    console.log(
      `[akeyless-db] tunnel ${tunnelId} exited (code=${code}, signal=${signal})`,
    )
    const wasActive = activeTunnels.has(tunnelId)
    const unexpected = wasActive && !tunnelInfo.closing
    tunnelInfo.connected = false
    tunnelInfo.process = null
    activeTunnels.delete(tunnelId)
    void mysqlClient.disconnect(tunnelId).catch(() => {})
    if (unexpected) {
      const reason =
        signal === 'SIGTERM'
          ? 'SSH tunnel closed unexpectedly'
          : `SSH tunnel closed (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
      notifyTunnelClosed(tunnelId, reason)
    }
  })

  return tunnelInfo
}

/**
 * Kills a tunnel process and removes it from the active tunnels map.
 */
export function closeTunnel(tunnelId: string): void {
  const tunnel = activeTunnels.get(tunnelId)
  if (!tunnel) return

  tunnel.closing = true
  if (tunnel.process) {
    try {
      tunnel.process.kill('SIGTERM')
    } catch {
      // Process may already be dead — ignore
    }
    tunnel.process = null
  }

  tunnel.connected = false
  activeTunnels.delete(tunnelId)
}

/**
 * Returns all active tunnels without the process reference (safe for serialization).
 */
export function getActiveTunnels(): Omit<TunnelInfo, 'process'>[] {
  const tunnels: Omit<TunnelInfo, 'process'>[] = []

  for (const tunnel of Array.from(activeTunnels.values())) {
    const { process: _proc, ...serializable } = tunnel
    tunnels.push(serializable)
  }

  return tunnels
}

/**
 * Kills all active tunnel processes. Intended for app shutdown cleanup.
 */
export function closeAllTunnels(): void {
  for (const tunnelId of Array.from(activeTunnels.keys())) {
    closeTunnel(tunnelId)
  }
}

// ---------------------------------------------------------------------------
// Namespace export — consumed by handlers and index.ts as `akeylessDb.*`
// ---------------------------------------------------------------------------

export const akeylessDb = {
  listProducers,
  clearProducersCache,
  getCredentials,
  getProducerDetails,
  openTunnel,
  closeTunnel,
  getActiveTunnels,
  closeAllTunnels,
  setAkeylessDbMainWindow,
}
