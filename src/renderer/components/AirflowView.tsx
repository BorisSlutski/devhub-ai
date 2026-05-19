import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AirflowDag,
  AirflowDagRun,
  AirflowDiscoverResult,
  AirflowTaskInstance,
} from '../../shared/ipc-types'
import './AirflowView.css'

interface Props {
  scanPath: string
}

function stateClass(state: string): string {
  const s = state.toLowerCase()
  if (s === 'success') return 'ok'
  if (s === 'failed' || s === 'upstream_failed') return 'err'
  if (s === 'running' || s === 'queued') return ''
  return ''
}

export function AirflowView({ scanPath }: Props) {
  const [discover, setDiscover] = useState<AirflowDiscoverResult | null>(null)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [dags, setDags] = useState<AirflowDag[]>([])
  const [dagFilter, setDagFilter] = useState('')
  const [selectedDagId, setSelectedDagId] = useState<string | null>(null)
  const [runs, setRuns] = useState<AirflowDagRun[]>([])
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [tasks, setTasks] = useState<AirflowTaskInstance[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const repoRoot = discover?.repoRoot ?? null

  const runDiscover = useCallback(async () => {
    setLoading(true)
    const d = await window.api.airflowDiscover(scanPath)
    setDiscover(d)
    setHealthOk(null)
    setHealthError(null)
    setDags([])
    setSelectedDagId(null)
    setRuns([])
    setSelectedRunId(null)
    setTasks([])
    setSelectedTaskId(null)
    setLog('')
    setLoading(false)
    return d
  }, [scanPath])

  const checkHealth = useCallback(async (root: string) => {
    const h = await window.api.airflowHealth(root)
    setHealthOk(h.ok)
    setHealthError(h.error ?? null)
    return h.ok
  }, [])

  const loadDags = useCallback(async (root: string) => {
    const result = await window.api.airflowListDags(root)
    if (result.success) {
      setDags(result.dags)
    } else {
      setMessage(result.error ?? 'Failed to load DAGs')
      setDags([])
    }
  }, [])

  const refreshAll = useCallback(async () => {
    if (!repoRoot) return
    setBusy(true)
    setMessage(null)
    const ok = await checkHealth(repoRoot)
    if (ok) await loadDags(repoRoot)
  }, [repoRoot, checkHealth, loadDags])

  useEffect(() => {
    void (async () => {
      const d = await runDiscover()
      if (d.isRepo && d.repoRoot) {
        const ok = await checkHealth(d.repoRoot)
        if (ok) await loadDags(d.repoRoot)
      }
    })()
  }, [runDiscover, checkHealth, loadDags])

  const filteredDags = useMemo(() => {
    const q = dagFilter.trim().toLowerCase()
    if (!q) return dags
    return dags.filter(
      (d) =>
        d.dagId.toLowerCase().includes(q) ||
        d.tags.some((t) => t.toLowerCase().includes(q)),
    )
  }, [dags, dagFilter])

  const selectedDag = dags.find((d) => d.dagId === selectedDagId)

  const selectDag = useCallback(
    async (dagId: string) => {
      if (!repoRoot) return
      setSelectedDagId(dagId)
      setSelectedRunId(null)
      setTasks([])
      setSelectedTaskId(null)
      setLog('')
      const result = await window.api.airflowListDagRuns(repoRoot, dagId)
      if (result.success) setRuns(result.runs)
      else setMessage(result.error ?? 'Failed to load runs')
    },
    [repoRoot],
  )

  const selectRun = useCallback(
    async (dagRunId: string) => {
      if (!repoRoot || !selectedDagId) return
      setSelectedRunId(dagRunId)
      setSelectedTaskId(null)
      setLog('')
      const result = await window.api.airflowListTaskInstances(repoRoot, selectedDagId, dagRunId)
      if (result.success) setTasks(result.tasks)
      else setMessage(result.error ?? 'Failed to load tasks')
    },
    [repoRoot, selectedDagId],
  )

  const selectTask = useCallback(
    async (task: AirflowTaskInstance) => {
      if (!repoRoot || !selectedDagId || !selectedRunId) return
      setSelectedTaskId(task.taskId)
      const result = await window.api.airflowGetTaskLog(
        repoRoot,
        selectedDagId,
        selectedRunId,
        task.taskId,
        task.tryNumber,
      )
      if (result.success) setLog(result.log)
      else setLog(result.error ?? 'Failed to load log')
    },
    [repoRoot, selectedDagId, selectedRunId],
  )

  const handlePauseToggle = useCallback(async () => {
    if (!repoRoot || !selectedDag) return
    setBusy(true)
    setMessage(null)
    const result = await window.api.airflowPatchDag(
      repoRoot,
      selectedDag.dagId,
      !selectedDag.isPaused,
    )
    if (result.success) {
      await loadDags(repoRoot)
      setMessage(selectedDag.isPaused ? 'DAG unpaused' : 'DAG paused')
    } else {
      setMessage(result.error ?? 'Patch failed')
    }
    setBusy(false)
  }, [repoRoot, selectedDag, loadDags])

  const handleTrigger = useCallback(async () => {
    if (!repoRoot || !selectedDagId) return
    const confJson = window.prompt('Optional trigger conf (JSON object)', '{}')
    if (confJson === null) return
    setBusy(true)
    setMessage(null)
    const result = await window.api.airflowTriggerDag(repoRoot, selectedDagId, confJson)
    if (result.success) {
      setMessage(`Triggered: ${result.dagRunId || 'ok'}`)
      await selectDag(selectedDagId)
    } else {
      setMessage(result.error ?? 'Trigger failed')
    }
    setBusy(false)
  }, [repoRoot, selectedDagId, selectDag])

  const openUi = useCallback(() => {
    if (discover?.uiPort) {
      void window.api.openInBrowser(`http://127.0.0.1:${discover.uiPort}`)
    }
  }, [discover?.uiPort])

  if (loading) {
    return <div className="airflow-empty">Detecting wix-astronomer-dags…</div>
  }

  if (!discover?.isRepo || !repoRoot) {
    return (
      <div className="airflow-empty">
        <div>Airflow tab is for <strong>wix-astronomer-dags</strong> only.</div>
        <p>No clone found under workspace:<br /><code>{scanPath}</code></p>
        <p style={{ fontSize: 11 }}>Add the repo to your workspace scan path or open it as the workspace root.</p>
      </div>
    )
  }

  return (
    <div className="airflow-view">
      <div className="airflow-toolbar">
        <span className="airflow-toolbar-meta" title={repoRoot}>
          {repoRoot.split('/').pop()} · :{discover.uiPort ?? 8080}
        </span>
        <span className={`airflow-status ${healthOk ? 'ok' : healthOk === false ? 'err' : ''}`}>
          {healthOk === null ? '…' : healthOk ? 'Connected' : healthError ?? 'Offline'}
        </span>
        <button type="button" className="btn btn-sm" onClick={openUi} disabled={!discover.uiPort}>
          Open UI
        </button>
        <button type="button" className="btn btn-sm" onClick={() => void refreshAll()} disabled={busy}>
          Refresh
        </button>
        {selectedDag && (
          <>
            <button type="button" className="btn btn-sm" onClick={() => void handlePauseToggle()} disabled={busy}>
              {selectedDag.isPaused ? 'Unpause' : 'Pause'}
            </button>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => void handleTrigger()} disabled={busy}>
              Trigger
            </button>
          </>
        )}
        {discover.setupScriptExists && (
          <span className="airflow-toolbar-meta" title="Run in terminal from astronomer-local/">
            setup_worktree_env.sh available
          </span>
        )}
        {message && <span className="airflow-toolbar-meta">{message}</span>}
      </div>

      {healthOk === false ? (
        <div className="airflow-empty">
          <p>Local Astro is not reachable at <code>{discover.apiUrl}</code></p>
          <p style={{ fontSize: 11 }}>From <code>astronomer-local/</code>: <code>astro dev start</code></p>
          {discover.setupScriptExists && (
            <p style={{ fontSize: 11 }}>In a worktree: <code>./setup_worktree_env.sh</code> (isolated ports)</p>
          )}
        </div>
      ) : (
        <div className="airflow-panes">
          <div className="airflow-pane">
            <div className="airflow-pane-header">DAGs ({filteredDags.length})</div>
            <div className="airflow-pane-search">
              <input
                value={dagFilter}
                onChange={(e) => setDagFilter(e.target.value)}
                placeholder="Filter DAGs…"
              />
            </div>
            <div className="airflow-list">
              {filteredDags.map((d) => (
                <div
                  key={d.dagId}
                  className={`airflow-item ${selectedDagId === d.dagId ? 'selected' : ''}`}
                  onClick={() => void selectDag(d.dagId)}
                >
                  <div>{d.dagId}{d.isPaused ? ' (paused)' : ''}</div>
                  {d.tags.length > 0 && (
                    <div className="airflow-item-sub">{d.tags.join(', ')}</div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="airflow-pane">
            <div className="airflow-pane-header">Runs</div>
            <div className="airflow-list">
              {runs.length === 0 ? (
                <div className="airflow-empty" style={{ padding: 16 }}>Select a DAG</div>
              ) : (
                runs.map((r) => (
                  <div
                    key={r.dagRunId}
                    className={`airflow-item ${selectedRunId === r.dagRunId ? 'selected' : ''}`}
                    onClick={() => void selectRun(r.dagRunId)}
                  >
                    <div>{r.dagRunId}</div>
                    <div className={`airflow-item-sub airflow-status ${stateClass(r.state)}`}>
                      {r.state}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="airflow-pane">
            <div className="airflow-pane-header">Tasks / Log</div>
            <div className="airflow-list" style={{ maxHeight: '40%' }}>
              {tasks.map((t) => (
                <div
                  key={t.taskId}
                  className={`airflow-item ${selectedTaskId === t.taskId ? 'selected' : ''}`}
                  onClick={() => void selectTask(t)}
                >
                  <div>{t.taskId}</div>
                  <div className={`airflow-item-sub ${stateClass(t.state)}`}>{t.state}</div>
                </div>
              ))}
            </div>
            <pre className="airflow-log">{log || (selectedTaskId ? 'Loading…' : 'Select a task for logs')}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
