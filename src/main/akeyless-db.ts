import { execFile, spawn, ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

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

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const activeTunnels = new Map<string, TunnelInfo>()
const producerDetailsCache = new Map<string, { host: string; dbName: string }>()
let resolvedBinaryPath: string | null = null

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

/**
 * Runs an akeyless CLI command via `execFile` and resolves with stdout.
 * Rejects on non-zero exit, timeout, or stderr-only output.
 * Retries up to {@link MAX_RETRIES} times on transient errors (e.g. unexpected EOF).
 */
const MAX_RETRIES = 2

function runAkeylessCommand(args: string[], retries: number = MAX_RETRIES): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = findAkeylessBinary()
    execFile(
      bin,
      args,
      { timeout: CLI_TIMEOUT, env: envWithGateway(), maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr || err.message
          const isTransient = /unexpected EOF|read body failed|connection reset/i.test(msg)
          if (isTransient && retries > 0) {
            console.warn(`[akeyless-db] transient error for '${args[0]}', retrying (${retries} left): ${msg}`)
            resolve(runAkeylessCommand(args, retries - 1))
            return
          }
          reject(new Error(`akeyless ${args[0]} failed: ${msg}`))
          return
        }
        resolve(stdout)
      },
    )
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
 * Parses a producer path into cluster and database segments.
 * Path format: /prod/dba/developer-access/<type>/<kgb-id>/<cluster>/<database>
 *   segments:   1    2    3                4      5        6         7
 * Using 1-based indexing on split('/') where index 0 is empty string.
 * The shell script uses `cut -d '/' -f7` (cluster) and `-f8` (database).
 * split('/') on "/a/b/c/d/e/f/g" gives ["","a","b","c","d","e","f","g"]
 *   indices:                               0   1   2   3   4   5   6  7
 * So f7 in cut = index 6, f8 = index 7.
 */
function parseProducerPath(name: string): { cluster: string; database: string } {
  const segments = name.split('/')
  return {
    cluster: segments[6] ?? '',
    database: segments[7] ?? '',
  }
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
export async function listProducers(type?: 'mysql' | 'mongo'): Promise<DbProducer[]> {
  const paths: string[] = []
  if (!type || type === 'mysql') paths.push(MYSQL_PRODUCER_PATH)
  if (!type || type === 'mongo') paths.push(MONGO_PRODUCER_PATH)

  const results: DbProducer[] = []
  const seenNames = new Set<string>()
  const errors: string[] = []

  for (const filterPath of paths) {
    const args = [
      'list-items',
      '--filter',
      filterPath,
      '--type',
      'dynamic-secret',
      '--profile',
      AKEYLESS_PROFILE,
    ]

    let stdout: string
    try {
      stdout = await runAkeylessCommand(args)
    } catch (err: any) {
      console.error(`[akeyless-db] list-items failed for ${filterPath}:`, err.message)
      errors.push(err.message)
      continue // Skip this path, try the next one
    }

    let parsed: any
    try {
      parsed = JSON.parse(stdout)
    } catch {
      // The shell script uses grep + cut to extract item_name fields.
      // If the output isn't valid JSON, fall back to line-based parsing.
      const lines = stdout.split('\n')
      for (const line of lines) {
        const match = line.match(/"item_name"\s*:\s*"([^"]+)"/)
        if (match) {
          const name = match[1]
          if (seenNames.has(name)) continue
          seenNames.add(name)
          const { cluster, database } = parseProducerPath(name)
          results.push({ name, cluster, database, dbName: database, type: typeFromPath(name) })
        }
      }
      continue
    }

    // The JSON response has an `items` array with objects containing `item_name`.
    const items: any[] = parsed?.items ?? (Array.isArray(parsed) ? parsed : [])
    for (const item of items) {
      const name: string = item.item_name ?? item.name ?? ''
      if (!name || seenNames.has(name)) continue
      seenNames.add(name)
      const { cluster, database } = parseProducerPath(name)
      const sra = item?.item_general_info?.secure_remote_access_details
      const dbName: string = sra?.db_name ?? database
      results.push({ name, cluster, database, dbName, type: typeFromPath(name) })

      // Cache host/dbName so openTunnel doesn't need a second list-items call
      if (sra) {
        const hostRaw = sra.host
        const host: string = Array.isArray(hostRaw) ? hostRaw[0] : String(hostRaw ?? '')
        if (host) {
          producerDetailsCache.set(name, { host, dbName })
        }
      }
    }
  }

  // If all paths failed and we got no results, throw with the collected errors
  if (results.length === 0 && errors.length > 0) {
    throw new Error(errors.join('; '))
  }

  return results
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
 * Fetches host and dbName metadata for a given producer from its item details.
 * Uses cache populated by listProducers to avoid a second expensive list-items call.
 */
export async function getProducerDetails(
  producerName: string,
): Promise<{ host: string; dbName: string }> {
  // Check cache first (populated by listProducers)
  const cached = producerDetailsCache.get(producerName)
  if (cached) {
    console.log(`[akeyless-db] getProducerDetails cache hit for ${producerName}`)
    return cached
  }

  console.log(`[akeyless-db] getProducerDetails cache miss — fetching from API`)

  // Determine the producer path (mysql or mongo) for the filter
  const producerPath = producerName.startsWith(MYSQL_PRODUCER_PATH)
    ? MYSQL_PRODUCER_PATH
    : MONGO_PRODUCER_PATH

  const args = [
    'list-items',
    '--filter',
    producerPath,
    '--type',
    'dynamic-secret',
    '--profile',
    AKEYLESS_PROFILE,
  ]

  const stdout = await runAkeylessCommand(args)

  let parsed: any
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new Error('Failed to parse list-items JSON output for producer details')
  }

  const items: any[] = parsed?.items ?? (Array.isArray(parsed) ? parsed : [])
  const item = items.find((i: any) => (i.item_name ?? i.name) === producerName)

  if (!item) {
    throw new Error(`Producer not found in list-items output: ${producerName}`)
  }

  const sraDetails = item?.item_general_info?.secure_remote_access_details
  if (!sraDetails) {
    throw new Error(`No secure_remote_access_details found for producer: ${producerName}`)
  }

  // host can be a string or an array — the shell script uses `jq '.host' | jq '.[]'`
  const hostRaw = sraDetails.host
  const host: string = Array.isArray(hostRaw) ? hostRaw[0] : String(hostRaw ?? '')
  const dbName: string = String(sraDetails.db_name ?? '')

  if (!host) {
    throw new Error(`No host found in producer details for: ${producerName}`)
  }

  return { host, dbName }
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
    tunnelInfo.connected = false
    tunnelInfo.process = null
  })

  return tunnelInfo
}

/**
 * Kills a tunnel process and removes it from the active tunnels map.
 */
export function closeTunnel(tunnelId: string): void {
  const tunnel = activeTunnels.get(tunnelId)
  if (!tunnel) return

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
  getCredentials,
  getProducerDetails,
  openTunnel,
  closeTunnel,
  getActiveTunnels,
  closeAllTunnels,
}
