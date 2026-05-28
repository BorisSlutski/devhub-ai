import { describe, it, expect } from 'vitest'
import { shouldApplyDescribeResult } from './db-columns-describe'

describe('shouldApplyDescribeResult', () => {
  it('accepts matching generation and expanded table', () => {
    expect(shouldApplyDescribeResult(2, 2, 'tax_rate', 'tax_rate')).toBe(true)
  })

  it('rejects stale generation', () => {
    expect(shouldApplyDescribeResult(3, 2, 'tax_rate', 'tax_rate')).toBe(false)
  })

  it('rejects when user expanded a different table', () => {
    expect(shouldApplyDescribeResult(2, 2, 'other_table', 'tax_rate')).toBe(false)
  })
})
