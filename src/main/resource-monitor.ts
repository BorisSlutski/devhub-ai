import { execFile } from 'child_process'
import * as os from 'os'
import { ptyManager } from './pty-manager'
import type { SessionMetrics, HostMetrics, ResourceSnapshot } from '../shared/ipc-types'

interface ProcessInfo {
  ppid: number
  rss: number   // in KB as reported by ps
  cpu: number   // percentage
  comm: string
}

type ProcessMap = Map<number, ProcessInfo>

/**
 * Parse the output of `ps -eo pid=,ppid=,rss=,pcpu=,comm=` into a pid->info map.
 * Each line has whitespace-separated fields: PID PPID RSS %CPU COMMAND
 * COMMAND may contain spaces, so we only split the first 4 fields.
 */
export function parsePsOutput(output: string): ProcessMap {
  const map: ProcessMap = new Map()
  const lines = output.trim().split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    // Split into at most 5 parts: pid, ppid, rss, pcpu, comm (comm may have spaces)
    const parts = trimmed.split(/\s+/)
    if (parts.length < 5) continue
    const pid = parseInt(parts[0], 10)
    const ppid = parseInt(parts[1], 10)
    const rss = parseInt(parts[2], 10)
    const cpu = parseFloat(parts[3])
    const comm = parts.slice(4).join(' ')
    if (isNaN(pid) || isNaN(ppid)) continue
    map.set(pid, {
      ppid,
      rss: isNaN(rss) ? 0 : rss,
      cpu: isNaN(cpu) ? 0 : cpu,
      comm,
    })
  }
  return map
}

/**
 * Given a root PID, find all descendant PIDs by walking the ppid chain.
 * Returns the set of PIDs including the root itself (if it exists in the map).
 */
export function findDescendants(rootPid: number, processes: ProcessMap): Set<number> {
  const descendants = new Set<number>()
  if (processes.has(rootPid)) {
    descendants.add(rootPid)
  }
  // Build children lookup for efficient traversal
  const childrenOf = new Map<number, number[]>()
  for (const [pid, info] of processes) {
    const siblings = childrenOf.get(info.ppid)
    if (siblings) {
      siblings.push(pid)
    } else {
      childrenOf.set(info.ppid, [pid])
    }
  }
  // BFS from rootPid
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.pop()!
    const children = childrenOf.get(current)
    if (children) {
      for (const child of children) {
        if (!descendants.has(child)) {
          descendants.add(child)
          queue.push(child)
        }
      }
    }
  }
  return descendants
}

/**
 * Aggregate metrics for a session's process tree.
 */
function aggregateSessionMetrics(
  sessionId: string,
  rootPid: number,
  processes: ProcessMap
): SessionMetrics {
  const pids = findDescendants(rootPid, processes)
  let totalCpu = 0
  let totalRssKb = 0
  for (const pid of pids) {
    const info = processes.get(pid)
    if (info) {
      totalCpu += info.cpu
      totalRssKb += info.rss
    }
  }
  return {
    sessionId,
    pid: rootPid,
    cpu: Math.round(totalCpu * 10) / 10,
    memory: totalRssKb * 1024, // KB -> bytes
    processCount: pids.size,
  }
}

function collectHostMetrics(): HostMetrics {
  const totalMemory = os.totalmem()
  const freeMemory = os.freemem()
  const usedMemory = totalMemory - freeMemory
  return {
    totalMemory,
    freeMemory,
    usedMemory,
    memoryUsagePercent: Math.round((usedMemory / totalMemory) * 1000) / 10,
    cpuCores: os.cpus().length,
    loadAverage1m: os.loadavg()[0],
  }
}

function runPs(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-eo', 'pid=,ppid=,rss=,pcpu=,comm='], { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

export type SnapshotCallback = (snapshot: ResourceSnapshot) => void

export class ResourceMonitor {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private callbacks: SnapshotCallback[] = []
  private cachedSnapshot: ResourceSnapshot | null = null
  private cachedAt = 0
  private activeCacheTtl = 2500
  private idleCacheTtl = 15000
  private _idle = false

  /** Start periodic polling */
  start(intervalMs = 3000): void {
    if (this.intervalId) return
    this.intervalId = setInterval(() => {
      this.poll()
    }, intervalMs)
  }

  /** Stop periodic polling */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /** Set idle mode (longer cache TTL, used when app is not focused) */
  setIdle(idle: boolean): void {
    this._idle = idle
  }

  /** Register a listener for periodic updates */
  onUpdate(callback: SnapshotCallback): void {
    this.callbacks.push(callback)
  }

  /** Remove a listener */
  offUpdate(callback: SnapshotCallback): void {
    this.callbacks = this.callbacks.filter(cb => cb !== callback)
  }

  /** Get the current snapshot, using cache if fresh enough */
  async getSnapshot(): Promise<ResourceSnapshot> {
    const ttl = this._idle ? this.idleCacheTtl : this.activeCacheTtl
    if (this.cachedSnapshot && (Date.now() - this.cachedAt) < ttl) {
      return this.cachedSnapshot
    }
    return this.collectSnapshot()
  }

  /** Force a fresh collection (bypasses cache) */
  private async collectSnapshot(): Promise<ResourceSnapshot> {
    const sessionPids = ptyManager.getSessionPids()
    let processes: ProcessMap = new Map()

    try {
      const psOutput = await runPs()
      processes = parsePsOutput(psOutput)
    } catch {
      // ps failed — return empty session metrics but still report host
    }

    const sessions: SessionMetrics[] = []
    for (const [sessionId, pid] of sessionPids) {
      sessions.push(aggregateSessionMetrics(sessionId, pid, processes))
    }

    const snapshot: ResourceSnapshot = {
      timestamp: Date.now(),
      sessions,
      host: collectHostMetrics(),
    }

    this.cachedSnapshot = snapshot
    this.cachedAt = Date.now()
    return snapshot
  }

  private async poll(): Promise<void> {
    try {
      const snapshot = await this.collectSnapshot()
      for (const cb of this.callbacks) {
        try {
          cb(snapshot)
        } catch { /* ignore callback errors */ }
      }
    } catch { /* ignore poll errors */ }
  }
}

/** Singleton instance */
export const resourceMonitor = new ResourceMonitor()
