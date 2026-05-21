export interface DbProducerPicker {
  name: string
  /** KGB ownership tag from the Akeyless path (e.g. kgb-aglianico). */
  kgb: string
  /** Akeyless producer leaf / host routing id — not the MySQL database name. */
  producer: string
  /** MySQL/Mongo schema name. */
  dbName: string
  type: 'mysql' | 'mongo'
}

function matchesProducerQuery(p: DbProducerPicker, q: string): boolean {
  return (
    p.dbName.toLowerCase().includes(q) ||
    p.producer.toLowerCase().includes(q) ||
    p.kgb.toLowerCase().includes(q) ||
    p.name.toLowerCase().includes(q)
  )
}

/** Stable browse identity — same display tuple from different Akeyless paths collapses to one row. */
export function producerBrowseKey(p: DbProducerPicker): string {
  return `${p.type}\0${p.dbName}\0${p.kgb}\0${p.producer}`
}

function pickCanonicalProducer(candidates: DbProducerPicker[]): DbProducerPicker {
  return [...candidates].sort(
    (a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name),
  )[0]
}

/** Collapse producers that share the same browse identity (type + dbName + kgb + producer). */
export function dedupeProducersForBrowse(producers: DbProducerPicker[]): DbProducerPicker[] {
  const byKey = new Map<string, DbProducerPicker[]>()
  for (const p of producers) {
    const key = producerBrowseKey(p)
    const list = byKey.get(key) ?? []
    list.push(p)
    byKey.set(key, list)
  }
  return Array.from(byKey.values()).map(pickCanonicalProducer)
}

/** Filter by db name, producer leaf, KGB tag, or full path. Empty query returns []. */
export function filterProducers(producers: DbProducerPicker[], query: string): DbProducerPicker[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return dedupeProducersForBrowse(producers.filter((p) => matchesProducerQuery(p, q)))
}

/** All producers matching query, or every producer when query is empty (database browse mode). */
export function listProducersForBrowse(
  producers: DbProducerPicker[],
  query: string,
): DbProducerPicker[] {
  const q = query.trim().toLowerCase()
  const list = q ? producers.filter((p) => matchesProducerQuery(p, q)) : producers
  return dedupeProducersForBrowse(list).sort(
    (a, b) => a.dbName.localeCompare(b.dbName) || a.kgb.localeCompare(b.kgb),
  )
}

export function groupProducersByKgb(
  producers: DbProducerPicker[],
): { kgb: string; producers: DbProducerPicker[] }[] {
  const byKgb = new Map<string, DbProducerPicker[]>()
  for (const p of producers) {
    const list = byKgb.get(p.kgb) ?? []
    list.push(p)
    byKgb.set(p.kgb, list)
  }
  return Array.from(byKgb.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kgb, kgbProducers]) => ({
      kgb,
      producers: kgbProducers.sort((a, b) => a.dbName.localeCompare(b.dbName)),
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

export function shouldShowProducerSubtitle(
  producer: DbProducerPicker,
  dupes: Set<string>,
): boolean {
  return dupes.has(producer.dbName)
}
