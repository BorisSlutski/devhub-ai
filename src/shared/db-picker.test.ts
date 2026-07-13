import { describe, it, expect } from 'vitest'
import {
  filterProducers,
  listProducersForBrowse,
  dedupeProducersForBrowse,
  groupProducersByKgb,
  groupProducersByCluster,
  parseProducerPathFields,
  producerCluster,
  applyProducerBrowseFilters,
  duplicateDbNames,
  shouldShowProducerSubtitle,
  type DbProducerPicker,
} from './db-picker'

const REAL_PATH =
  '/prod/dba/developer-access/mysql/kgb-aglianico/editor_services/locality_common_us/db-mysql-locality-common-us2a.42-config_service'

const producers: DbProducerPicker[] = [
  {
    name: '/prod/dba/developer-access/mysql/kgb-a/host-a/host-a/p-host-a',
    kgb: 'kgb-a',
    cluster: 'host-a',
    producer: 'p-host-a',
    dbName: 'mydb',
    type: 'mysql',
  },
  {
    name: '/prod/dba/developer-access/mysql/kgb-a/host-b/host-b/p-host-b',
    kgb: 'kgb-a',
    cluster: 'host-b',
    producer: 'p-host-b',
    dbName: 'mydb',
    type: 'mysql',
  },
  {
    name: '/prod/dba/developer-access/mysql/kgb-b/other/other/p-other',
    kgb: 'kgb-b',
    cluster: 'other',
    producer: 'p-other',
    dbName: 'other',
    type: 'mysql',
  },
  {
    name: '/prod/dba/developer-access/mysql/kgb-a/billing/billing/db-mysql-billing0a.42-wix_billing',
    kgb: 'kgb-a',
    cluster: 'billing',
    producer: 'db-mysql-billing0a.42-wix_billing',
    dbName: 'wix_billing',
    type: 'mysql',
  },
]

describe('parseProducerPathFields', () => {
  it('reads cluster from the last folder before the producer leaf', () => {
    expect(parseProducerPathFields(REAL_PATH)).toEqual({
      kgb: 'kgb-aglianico',
      cluster: 'locality_common_us',
      producer: 'db-mysql-locality-common-us2a.42-config_service',
      dbName: 'config_service',
    })
  })
})

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
    expect(filterProducers(producers, 'p-host-b')).toHaveLength(1)
  })

  it('matches Akeyless cluster folder name', () => {
    expect(filterProducers(producers, 'locality_common_us')).toHaveLength(0)
    expect(filterProducers(producers, 'billing')).toHaveLength(1)
  })
})

describe('producerCluster', () => {
  it('uses the cluster field when present', () => {
    expect(producerCluster(producers[3])).toBe('billing')
  })

  it('falls back to parsing the path when cluster is missing', () => {
    expect(
      producerCluster({
        name: REAL_PATH,
        cluster: '',
      }),
    ).toBe('locality_common_us')
  })
})

describe('groupProducersByCluster', () => {
  it('groups and sorts by cluster folder', () => {
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
    expect(filtered[0].producer).toBe('p-host-a')
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
      {
        name: '/prod/.../long-path/cronulla',
        kgb: 'kgb-a',
        cluster: 'internal_services',
        producer: 'loc',
        dbName: 'cronulla',
        type: 'mysql',
      },
      {
        name: '/p/a',
        kgb: 'kgb-a',
        cluster: 'internal_services',
        producer: 'loc',
        dbName: 'cronulla',
        type: 'mysql',
      },
      {
        name: '/p/b',
        kgb: 'kgb-a',
        cluster: 'internal_services',
        producer: 'loc',
        dbName: 'cronulla',
        type: 'mysql',
      },
    ]
    const list = dedupeProducersForBrowse(dupes)
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('/p/a')
  })

  it('keeps rows that differ by producer leaf', () => {
    const list = dedupeProducersForBrowse([
      {
        name: '/p/1',
        kgb: 'kgb-a',
        cluster: 'domains',
        producer: 'loc_a',
        dbName: 'domain_audit',
        type: 'mysql',
      },
      {
        name: '/p/2',
        kgb: 'kgb-a',
        cluster: 'domains',
        producer: 'loc_b',
        dbName: 'domain_audit',
        type: 'mysql',
      },
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
