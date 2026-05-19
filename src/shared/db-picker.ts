export interface DbProducerPicker {
  name: string
  cluster: string
  database: string
  dbName: string
  type: 'mysql' | 'mongo'
}

function matchesProducerQuery(p: DbProducerPicker, q: string): boolean {
  return (
    p.dbName.toLowerCase().includes(q) ||
    p.database.toLowerCase().includes(q) ||
    p.cluster.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q)
  )
}

/** Filter by db name, host segment, cluster, or full producer path. Empty query returns []. */
export function filterProducers(producers: DbProducerPicker[], query: string): DbProducerPicker[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return producers.filter((p) => matchesProducerQuery(p, q))
}

/** All producers matching query, or every producer when query is empty (database browse mode). */
export function listProducersForBrowse(
  producers: DbProducerPicker[],
  query: string,
): DbProducerPicker[] {
  const q = query.trim().toLowerCase()
  const list = q ? producers.filter((p) => matchesProducerQuery(p, q)) : producers
  return [...list].sort(
    (a, b) => a.dbName.localeCompare(b.dbName) || a.cluster.localeCompare(b.cluster),
  )
}

export function groupProducersByCluster(
  producers: DbProducerPicker[],
): { cluster: string; producers: DbProducerPicker[] }[] {
  const byCluster = new Map<string, DbProducerPicker[]>()
  for (const p of producers) {
    const list = byCluster.get(p.cluster) ?? []
    list.push(p)
    byCluster.set(p.cluster, list)
  }
  return Array.from(byCluster.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cluster, clusterProducers]) => ({
      cluster,
      producers: clusterProducers.sort((a, b) => a.dbName.localeCompare(b.dbName)),
    }))
}

/** dbName values that appear more than once in the list */
export function duplicateDbNames(producers: DbProducerPicker[]): Set<string> {
  const counts = new Map<string, number>()
  for (const p of producers) {
    counts.set(p.dbName, (counts.get(p.dbName) ?? 0) + 1)
  }
  const dupes = new Set<string>()
  for (const [name, count] of counts) {
    if (count > 1) dupes.add(name)
  }
  return dupes
}

export function shouldShowDatabaseSubtitle(
  producer: DbProducerPicker,
  dupes: Set<string>,
): boolean {
  return dupes.has(producer.dbName)
}
