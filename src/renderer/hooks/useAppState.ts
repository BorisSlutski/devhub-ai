import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { AppState, ProcessStatus, Project, SystemPortInfo } from '../../shared/types'

type AppTabId = 'launchpad' | 'folders' | 'claude' | 'agents' | 'db-access' | 'airflow'

export function useAppState(activeTab: AppTabId = 'launchpad') {
  const [state, setState] = useState<AppState>({ projects: [], tags: [], scanPath: '' })
  const [statuses, setStatuses] = useState<Map<string, ProcessStatus>>(new Map())
  const [logs, setLogs] = useState<Map<string, string[]>>(new Map())
  const [systemPorts, setSystemPorts] = useState<Record<number, SystemPortInfo>>({})
  const [loaded, setLoaded] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state

  // Detect system ports that are already in use
  const refreshSystemPorts = useCallback(async () => {
    const projects = stateRef.current.projects
    const ports = projects.map((p) => p.port).filter((p): p is number => p !== null)
    if (ports.length === 0) return
    const result = await window.api.detectSystemPorts(ports)
    setSystemPorts(result)
  }, [])

  useEffect(() => {
    window.api.getState().then((s) => {
      setState(s)
      setLoaded(true)
      // After loading state, check system ports
      const ports = s.projects.map((p) => p.port).filter((p): p is number => p !== null)
      if (ports.length > 0) {
        window.api.detectSystemPorts(ports).then(setSystemPorts)
      }
    })

    window.api.getProcessStatuses().then((list) => {
      const map = new Map<string, ProcessStatus>()
      for (const s of list) {
        map.set(s.projectId, s)
        setLogs((prev) => new Map(prev).set(s.projectId, s.logs))
      }
      setStatuses(map)
    })

    const unsubLog = window.api.onProcessLog(({ projectId, line }) => {
      setLogs((prev) => {
        const next = new Map(prev)
        const existing = next.get(projectId) || []
        next.set(projectId, [...existing.slice(-499), line])
        return next
      })
    })

    const unsubStatus = window.api.onProcessStatusChanged((status) => {
      setStatuses((prev) => {
        const next = new Map(prev)
        if (status.running) {
          next.set(status.projectId, status)
        } else {
          next.delete(status.projectId)
        }
        return next
      })
    })

    return () => {
      unsubLog()
      unsubStatus()
    }
  }, [])

  // Refresh system ports only while Launchpad is active (avoids global polling)
  useEffect(() => {
    if (activeTab !== 'launchpad' || state.projects.length === 0) return

    const tick = () => {
      const projects = stateRef.current.projects
      if (projects.length === 0) return
      const ports = projects.map((p) => p.port).filter((p): p is number => p !== null)
      if (ports.length > 0) {
        window.api.detectSystemPorts(ports).then(setSystemPorts)
      }
    }

    tick()
    const interval = setInterval(tick, 10000)
    return () => clearInterval(interval)
  }, [activeTab, state.projects.length])

  const persist = useCallback((newState: AppState) => {
    setState(newState)
    window.api.saveState(newState)
  }, [])

  const scanWorkspace = useCallback(async () => {
    const scanPath = stateRef.current.scanPath
    const scanDepth = stateRef.current.scanDepth
    console.log('[scan] start — path:', scanPath, 'depth:', scanDepth)
    const scanned = await window.api.scanWorkspace(scanPath, scanDepth)
    console.log('[scan] done —', scanned.length, 'projects')

    // Merge: keep existing projects, skip previously removed ones
    const existingPaths = new Set(stateRef.current.projects.map((p) => p.path))
    const removedPaths = new Set(stateRef.current.removedPaths || [])
    const newProjects = scanned.filter((p) => !existingPaths.has(p.path) && !removedPaths.has(p.path))

    // Build lookup of scanned data by path for updating existing projects
    const scannedByPath = new Map(scanned.map(p => [p.path, p]))

    // Update existing projects: fill in missing runCommand, port, techStack from fresh scan
    const updated = stateRef.current.projects.map(p => {
      const fresh = scannedByPath.get(p.path)
      if (!fresh) return p
      let changed = false
      const patched = { ...p }
      if (!p.runCommand && fresh.runCommand) {
        patched.runCommand = fresh.runCommand
        changed = true
      }
      if (!p.port && fresh.port) {
        patched.port = fresh.port
        changed = true
      }
      if (p.techStack.length === 0 && fresh.techStack.length > 0) {
        patched.techStack = fresh.techStack
        changed = true
      }
      return changed ? patched : p
    })

    const merged = [...updated, ...newProjects]
    const newState = { ...stateRef.current, projects: merged }
    persist(newState)
    return newProjects.length
  }, [persist])

  const updateProject = useCallback((project: Project) => {
    const projects = stateRef.current.projects.map((p) =>
      p.id === project.id ? project : p
    )
    // Collect all unique tags
    const allTags = new Set<string>()
    projects.forEach((p) => p.tags.forEach((t) => allTags.add(t)))
    persist({ ...stateRef.current, projects, tags: [...allTags] })
  }, [persist])

  const removeProject = useCallback((projectId: string) => {
    const removed = stateRef.current.projects.find((p) => p.id === projectId)
    const projects = stateRef.current.projects.filter((p) => p.id !== projectId)
    const removedPaths = [...(stateRef.current.removedPaths || [])]
    if (removed) removedPaths.push(removed.path)
    persist({ ...stateRef.current, projects, removedPaths })
  }, [persist])

  const startProject = useCallback(async (project: Project) => {
    // Update lastOpened
    const updated = { ...project, lastOpened: new Date().toISOString() }
    updateProject(updated)

    const status = await window.api.startProject(updated)
    setStatuses((prev) => new Map(prev).set(project.id, status))
    setLogs((prev) => new Map(prev).set(project.id, status.logs))
    return status
  }, [updateProject])

  const stopProject = useCallback(async (projectId: string) => {
    await window.api.stopProject(projectId)
    setStatuses((prev) => {
      const next = new Map(prev)
      next.delete(projectId)
      return next
    })
    // Refresh system ports after stopping (port might still be held briefly)
    setTimeout(refreshSystemPorts, 1000)
  }, [refreshSystemPorts])

  const killSystemPortProcess = useCallback(async (pid: number) => {
    const success = await window.api.killSystemProcess(pid)
    if (success) {
      // Refresh system ports after killing
      setTimeout(refreshSystemPorts, 500)
    }
    return success
  }, [refreshSystemPorts])

  const bulkHideProjects = useCallback((projectIds: string[]) => {
    const idSet = new Set(projectIds)
    const projects = stateRef.current.projects.map((p) =>
      idSet.has(p.id) ? { ...p, hidden: true } : p
    )
    persist({ ...stateRef.current, projects })
  }, [persist])

  const bulkRemoveProjects = useCallback((projectIds: string[]) => {
    const idSet = new Set(projectIds)
    const removedPaths = [...(stateRef.current.removedPaths || [])]
    stateRef.current.projects.forEach((p) => {
      if (idSet.has(p.id)) removedPaths.push(p.path)
    })
    const projects = stateRef.current.projects.filter((p) => !idSet.has(p.id))
    persist({ ...stateRef.current, projects, removedPaths })
  }, [persist])

  // Resolve which project actually owns each system port process.
  // When multiple projects share a port, use process cwd to match.
  const systemRunningMap = useMemo(() => {
    const result = new Map<string, SystemPortInfo>()
    if (Object.keys(systemPorts).length === 0) return result

    // Group non-running projects by port
    const projectsByPort = new Map<number, Project[]>()
    for (const p of state.projects) {
      if (p.port === null || statuses.has(p.id)) continue
      const list = projectsByPort.get(p.port) || []
      list.push(p)
      projectsByPort.set(p.port, list)
    }

    for (const [portStr, info] of Object.entries(systemPorts)) {
      const port = Number(portStr)
      const candidates = projectsByPort.get(port)
      if (!candidates || candidates.length === 0) continue

      if (candidates.length === 1) {
        // Only one project on this port — it's the owner
        result.set(candidates[0].id, info)
      } else if (info.cwd) {
        // Multiple projects share this port — match by cwd
        const match = candidates.find((p) => info.cwd.startsWith(p.path))
        if (match) {
          result.set(match.id, info)
        }
        // If no cwd match, don't mark any (ambiguous)
      }
    }

    return result
  }, [state.projects, systemPorts, statuses])

  return {
    state,
    statuses,
    logs,
    systemRunningMap,
    loaded,
    scanWorkspace,
    updateProject,
    removeProject,
    startProject,
    stopProject,
    killSystemPortProcess,
    bulkHideProjects,
    bulkRemoveProjects,
    refreshSystemPorts,
    persist
  }
}
