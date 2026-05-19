import type {
  AirflowConnection,
  AirflowDag,
  AirflowDagRun,
  AirflowHealthResult,
  AirflowTaskInstance,
} from '../shared/airflow-types'

function authHeader(conn: AirflowConnection): string {
  const token = Buffer.from(`${conn.username}:${conn.password}`).toString('base64')
  return `Basic ${token}`
}

async function airflowFetch<T>(
  conn: AirflowConnection,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${conn.baseUrl.replace(/\/$/, '')}${path}`
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: authHeader(conn),
      ...init?.headers,
    },
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Airflow ${res.status}: ${text.slice(0, 300) || res.statusText}`)
  }

  if (res.status === 204) return {} as T
  return res.json() as Promise<T>
}

export async function airflowHealth(conn: AirflowConnection): Promise<AirflowHealthResult> {
  try {
    await airflowFetch(conn, '/health')
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      await airflowFetch<{ dags?: unknown[] }>(conn, '/dags?limit=1')
      return { ok: true }
    } catch {
      return { ok: false, error: msg }
    }
  }
}

export async function listDags(conn: AirflowConnection, limit = 200): Promise<AirflowDag[]> {
  const data = await airflowFetch<{ dags: Array<Record<string, unknown>> }>(
    conn,
    `/dags?limit=${limit}&only_active=false`,
  )
  return (data.dags || []).map((d) => ({
    dagId: String(d.dag_id ?? ''),
    isPaused: Boolean(d.is_paused),
    tags: Array.isArray(d.tags) ? d.tags.map((t: any) => String(t?.name ?? t)) : [],
    owners: Array.isArray(d.owners) ? d.owners.map(String) : [],
    description: String(d.description ?? ''),
  }))
}

export async function patchDagPaused(
  conn: AirflowConnection,
  dagId: string,
  isPaused: boolean,
): Promise<void> {
  await airflowFetch(conn, `/dags/${encodeURIComponent(dagId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_paused: isPaused }),
  })
}

export async function triggerDag(
  conn: AirflowConnection,
  dagId: string,
  conf?: Record<string, unknown>,
): Promise<string> {
  const body: Record<string, unknown> = {}
  if (conf && Object.keys(conf).length > 0) body.conf = conf
  const data = await airflowFetch<{ dag_run_id?: string }>(
    conn,
    `/dags/${encodeURIComponent(dagId)}/dagRuns`,
    { method: 'POST', body: JSON.stringify(body) },
  )
  return String(data.dag_run_id ?? '')
}

export async function listDagRuns(
  conn: AirflowConnection,
  dagId: string,
  limit = 25,
): Promise<AirflowDagRun[]> {
  const data = await airflowFetch<{ dag_runs: Array<Record<string, unknown>> }>(
    conn,
    `/dags/${encodeURIComponent(dagId)}/dagRuns?limit=${limit}&order_by=-start_date`,
  )
  return (data.dag_runs || []).map((r) => ({
    dagRunId: String(r.dag_run_id ?? ''),
    state: String(r.state ?? ''),
    startDate: r.start_date ? String(r.start_date) : null,
    endDate: r.end_date ? String(r.end_date) : null,
    logicalDate: r.logical_date ? String(r.logical_date) : null,
  }))
}

export async function listTaskInstances(
  conn: AirflowConnection,
  dagId: string,
  dagRunId: string,
): Promise<AirflowTaskInstance[]> {
  const data = await airflowFetch<{ task_instances: Array<Record<string, unknown>> }>(
    conn,
    `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(dagRunId)}/taskInstances`,
  )
  return (data.task_instances || []).map((t) => ({
    taskId: String(t.task_id ?? ''),
    state: String(t.state ?? ''),
    startDate: t.start_date ? String(t.start_date) : null,
    endDate: t.end_date ? String(t.end_date) : null,
    tryNumber: Number(t.try_number ?? 1),
  }))
}

export async function getTaskLog(
  conn: AirflowConnection,
  dagId: string,
  dagRunId: string,
  taskId: string,
  tryNumber = 1,
): Promise<string> {
  const data = await airflowFetch<{ content?: string }>(
    conn,
    `/dags/${encodeURIComponent(dagId)}/dagRuns/${encodeURIComponent(dagRunId)}/taskInstances/${encodeURIComponent(taskId)}/logs/${tryNumber}`,
  )
  return data.content ?? ''
}
