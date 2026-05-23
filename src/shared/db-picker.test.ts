import { describe, it, expect } from 'vitest'
import {
  filterProducers,
  listProducersForBrowse,
  dedupeProducersForBrowse,
  groupProducersByKgb,
  groupProducersByCluster,
  clusterFromProducer,
  applyProducerBrowseFilters,
  duplicateDbNames,
  shouldShowProducerSubtitle,
  type DbProducerPicker,
} from './db-picker'

const producers: DbProducerPicker[] = [
  { name: '/p/a', kgb: 'kgb-a', producer: 'host-a', dbName: 'mydb', type: 'mysql' },
  { name: '/p/b', kgb: 'kgb-a', producer: 'host-b', dbName: 'mydb', type: 'mysql' },
  { name: '/p/c', kgb: 'kgb-b', producer: 'host-c', dbName: 'other', type: 'mysql' },
  {
    name: '/p/d',
    kgb: 'kgb-a',
    producer: 'db-mysql-billing0a.42-wix_billing',
    dbName: 'wix_billing',
    type: 'mysql',
  },
]

describe('filterProducers', () => {
  it('returns empty for blank query', () => {
    expect(filterProducers(producers, '')).toEqual([])
    expect(filterProducers(producers, '   ')).toEqual([])
  })

  it('matches dbName across KGB tags', () => {
    const matches = filterProducers(producers, 'mydb')
    expect(matches).toHaveLength(2)
    expect(matches.every((p) => p.dbName === 'mydb')).toBe(true)
  })

  it('matches KGB tag', () => {
    expect(filterProducers(producers, 'kgb-b')).toHaveLength(1)
  })

  it('matches producer leaf', () => {
    expect(filterProducers(producers, 'host-b')).toHaveLength(1)
  })

  it('matches cluster id derived from producer leaf', () => {
    expect(filterProducers(producers, 'billing0a')).toHaveLength(1)
  })
})

describe('clusterFromProducer', () => {
  it('strips db name suffix from producer leaf', () => {
    expect(clusterFromProducer(producers[3])).toBe('db-mysql-billing0a.42')
  })
})

describe('groupProducersByCluster', () => {
  it('groups and sorts by cluster id', () => {
    const groups = groupProducersByCluster(filterProducers(producers, 'mydb'))
    expect(groups.map((g) => g.cluster)).toEqual(['host-a', 'host-b'])
    expect(groups[0].producers).toHaveLength(1)
  })
})

describe('applyProducerBrowseFilters', () => {
  it('filters by kgb and cluster together', () => {
    const filtered = applyProducerBrowseFilters(producers, {
      kgb: 'kgb-a',
      cluster: 'host-a',
    })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].producer).toBe('host-a')
  })
})

describe('groupProducersByKgb', () => {
  it('groups and sorts by KGB tag', () => {
    const groups = groupProducersByKgb(filterProducers(producers, 'mydb'))
    expect(groups.map((g) => g.kgb)).toEqual(['kgb-a'])
    expect(groups[0].producers).toHaveLength(2)
  })
})

describe('duplicateDbNames', () => {
  it('detects duplicate dbName under same KGB', () => {
    const dupes = duplicateDbNames(producers.filter((p) => p.kgb === 'kgb-a'))
    expect(dupes.has('mydb')).toBe(true)
    expect(dupes.has('other')).toBe(false)
  })
})

describe('dedupeProducersForBrowse', () => {
  it('collapses identical browse keys to one row', () => {
    const dupes: DbProducerPicker[] = [
      { name: '/prod/.../long-path/cronulla', kgb: 'kgb-a', producer: 'loc', dbName: 'cronulla', type: 'mysql' },
      { name: '/p/a', kgb: 'kgb-a', producer: 'loc', dbName: 'cronulla', type: 'mysql' },
      { name: '/p/b', kgb: 'kgb-a', producer: 'loc', dbName: 'cronulla', type: 'mysql' },
    ]
    const list = dedupeProducersForBrowse(dupes)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('/p/a')
  })

  it('keeps rows that differ by producer leaf', () => {
    const list = dedupeProducersForBrowse([
      { name: '/p/1', kgb: 'kgb-a', producer: 'loc_a', dbName: 'domain_audit', type: 'mysql' },
      { name: '/p/2', kgb: 'kgb-a', producer: 'loc_b', dbName: 'domain_audit', type: 'mysql' },
    ])
    expect(list).toHaveLength(2)
  })
})

describe('listProducersForBrowse', () => {
  it('returns all producers sorted when query is empty', () => {
    const list = listProducersForBrowse(producers, '')
    expect(list).toHaveLength(4)
    expect(list[0].dbName).toBe('mydb')
  })

  it('filters by name when query is set', () => {
    expect(listProducersForBrowse(producers, 'other')).toHaveLength(1)
  })
})

describe('shouldShowProducerSubtitle', () => {
  it('shows subtitle when dbName is duplicated', () => {
    const dupes = duplicateDbNames(producers.filter((p) => p.kgb === 'kgb-a'))
    expect(shouldShowProducerSubtitle(producers[0], dupes)).toBe(true)
    expect(shouldShowProducerSubtitle(producers[2], dupes)).toBe(false)
  })
})
