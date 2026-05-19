import { describe, it, expect } from 'vitest'
import {
  filterProducers,
  listProducersForBrowse,
  groupProducersByCluster,
  duplicateDbNames,
  shouldShowDatabaseSubtitle,
  type DbProducerPicker,
} from './db-picker'

const producers: DbProducerPicker[] = [
  { name: '/p/a', cluster: 'c1', database: 'host-a', dbName: 'mydb', type: 'mysql' },
  { name: '/p/b', cluster: 'c1', database: 'host-b', dbName: 'mydb', type: 'mysql' },
  { name: '/p/c', cluster: 'c2', database: 'host-c', dbName: 'other', type: 'mysql' },
]

describe('filterProducers', () => {
  it('returns empty for blank query', () => {
    expect(filterProducers(producers, '')).toEqual([])
    expect(filterProducers(producers, '   ')).toEqual([])
  })

  it('matches dbName across clusters', () => {
    const matches = filterProducers(producers, 'mydb')
    expect(matches).toHaveLength(2)
    expect(matches.every((p) => p.dbName === 'mydb')).toBe(true)
  })

  it('matches cluster name', () => {
    expect(filterProducers(producers, 'c2')).toHaveLength(1)
  })

  it('matches database host segment', () => {
    expect(filterProducers(producers, 'host-b')).toHaveLength(1)
  })
})

describe('groupProducersByCluster', () => {
  it('groups and sorts clusters', () => {
    const groups = groupProducersByCluster(filterProducers(producers, 'mydb'))
    expect(groups.map((g) => g.cluster)).toEqual(['c1'])
    expect(groups[0].producers).toHaveLength(2)
  })
})

describe('duplicateDbNames', () => {
  it('detects duplicate dbName in cluster list', () => {
    const dupes = duplicateDbNames(producers.filter((p) => p.cluster === 'c1'))
    expect(dupes.has('mydb')).toBe(true)
    expect(dupes.has('other')).toBe(false)
  })
})

describe('listProducersForBrowse', () => {
  it('returns all producers sorted when query is empty', () => {
    const list = listProducersForBrowse(producers, '')
    expect(list).toHaveLength(3)
    expect(list[0].dbName).toBe('mydb')
  })

  it('filters by name when query is set', () => {
    expect(listProducersForBrowse(producers, 'other')).toHaveLength(1)
  })
})

describe('shouldShowDatabaseSubtitle', () => {
  it('shows subtitle when dbName is duplicated', () => {
    const dupes = duplicateDbNames(producers.filter((p) => p.cluster === 'c1'))
    expect(shouldShowDatabaseSubtitle(producers[0], dupes)).toBe(true)
    expect(shouldShowDatabaseSubtitle(producers[2], dupes)).toBe(false)
  })
})
