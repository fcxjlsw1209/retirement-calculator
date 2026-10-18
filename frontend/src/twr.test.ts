import { describe, it, expect } from 'vitest'
import { calcTWR, calcTWRFrom, mergeDailySnapshots, modifiedDietz, MAX_EXACT_GAP_DAYS } from './twr'

describe('calcTWR', () => {
  // Test 1: Design doc numerical example (core)
  it('matches design doc example: one CF, two sub-periods', () => {
    const snapshots = [
      { date: '2026-01-01', value: 100000 },
      { date: '2026-03-14', value: 103000 },
      { date: '2026-03-15', value: 153000 },
      { date: '2026-12-31', value: 160000 },
    ]
    const cashFlows = [
      { date: '2026-03-15', amount: 50000 },
    ]
    const twr = calcTWR(snapshots, cashFlows)
    expect(twr).not.toBeNull()
    // r1 = (103000 - 100000) / 100000 = 0.03
    // r2 = (160000 - 153000) / 153000 = 0.04575...
    // TWR = 1.03 * 1.04575... - 1 ≈ 0.07712...
    expect(twr!).toBeCloseTo(0.0771, 2)
  })

  // Test 2: No CF, simple return
  it('returns 0.10 for simple 10% gain with no cash flows', () => {
    const snapshots = [
      { date: '2026-01-01', value: 100000 },
      { date: '2026-12-31', value: 110000 },
    ]
    const twr = calcTWR(snapshots, [])
    expect(twr).toBeCloseTo(0.10, 10)
  })

  // Test 3: Single snapshot → null
  it('returns null for single snapshot', () => {
    const twr = calcTWR([{ date: '2026-01-01', value: 100000 }], [])
    expect(twr).toBeNull()
  })

  // Test 4: Empty snapshots → null
  it('returns null for empty snapshots', () => {
    const twr = calcTWR([], [])
    expect(twr).toBeNull()
  })

  // Test 5b: CF on day immediately after period start (zero-length bridge fix)
  it('captures market return when CF is on the day after period start', () => {
    // Scenario mirrors the real bug: period starts 4/1, CF contributed on 4/2,
    // market flat from 4/2 to 4/5. Without fix, TWR ≈ 0% (misses 4/1→4/2 gain).
    const snapshots = [
      { date: '2026-04-01', value: 100000 },
      { date: '2026-04-02', value: 105000 },  // +$4k market, +$1k CF
      { date: '2026-04-05', value: 104000 },  // market down slightly
    ]
    const cashFlows = [
      { date: '2026-04-02', amount: 1000 },
    ]
    // Bridge [4/1→4/2]: modifiedDietz = (105000 - 100000 - 1000) / 100000 = 0.04
    // Final [4/2→4/5]: (104000 - 105000) / 105000 ≈ -0.009524
    // TWR = 1.04 × 0.990476 - 1 ≈ 0.03010
    const twr = calcTWR(snapshots, cashFlows)
    expect(twr).not.toBeNull()
    expect(twr!).toBeCloseTo(0.0301, 3)
  })

  it('keeps same-day market movement when a later cash flow splits the period', () => {
    const snapshots = [
      { date: '2026-05-01', value: 100000 },
      { date: '2026-05-13', value: 100000 },
      { date: '2026-05-14', value: 111000 },  // +$10k market, +$1k CF
      { date: '2026-05-19', value: 111000 },
    ]
    const cashFlows = [
      { date: '2026-05-14', amount: 1000 },
    ]
    const twr = calcTWR(snapshots, cashFlows)
    expect(twr).not.toBeNull()
    expect(twr!).toBeCloseTo(0.10, 6)
  })

  it('keeps same-day drawdown when a cash flow lands on a down day', () => {
    const snapshots = [
      { date: '2026-05-01', value: 100000 },
      { date: '2026-05-13', value: 100000 },
      { date: '2026-05-14', value: 89000 },  // -$10k market, -$1k CF
      { date: '2026-05-19', value: 89000 },
    ]
    const cashFlows = [
      { date: '2026-05-14', amount: -1000 },
    ]
    const twr = calcTWR(snapshots, cashFlows)
    expect(twr).not.toBeNull()
    expect(twr!).toBeCloseTo(-0.10, 6)
  })

  it('includes multiple cash flows within the same snapshot interval', () => {
    const snapshots = [
      { date: '2026-05-01', value: 100000 },
      { date: '2026-05-31', value: 113000 },
    ]
    const cashFlows = [
      { date: '2026-05-10', amount: 5000 },
      { date: '2026-05-20', amount: 3000 },
    ]
    const twr = calcTWR(snapshots, cashFlows)
    expect(twr).not.toBeNull()
    expect(twr!).toBeCloseTo(modifiedDietz(100000, 113000, cashFlows, '2026-05-01', '2026-05-31')!, 10)
  })

  // Test 5: Two CFs (three sub-periods)
  it('handles two cash flows (three sub-periods)', () => {
    const snapshots = [
      { date: '2026-01-01', value: 100000 },
      { date: '2026-03-14', value: 103000 },
      { date: '2026-03-15', value: 153000 },
      { date: '2026-06-29', value: 155000 },
      { date: '2026-06-30', value: 205000 },
      { date: '2026-12-31', value: 210000 },
    ]
    const cashFlows = [
      { date: '2026-03-15', amount: 50000 },
      { date: '2026-06-30', amount: 50000 },
    ]
    // r1 = (103000-100000)/100000 = 0.03
    // r2 = (155000-153000)/153000 ≈ 0.01307
    // r3 = (210000-205000)/205000 ≈ 0.02439
    // TWR = 1.03 × 1.01307 × 1.02439 - 1 ≈ 0.0699
    const twr = calcTWR(snapshots, cashFlows)
    expect(twr).not.toBeNull()
    expect(twr!).toBeCloseTo(0.0699, 2)
  })
})

describe('mergeDailySnapshots', () => {
  // Test 6: Two accounts, aligned dates
  it('sums two accounts with aligned dates', () => {
    const accountA = [
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-02', value: 110 },
    ]
    const accountB = [
      { date: '2026-01-01', value: 200 },
      { date: '2026-01-02', value: 210 },
    ]
    const result = mergeDailySnapshots([accountA, accountB])
    expect(result).toEqual([
      { date: '2026-01-01', value: 300 },
      { date: '2026-01-02', value: 320 },
    ])
  })

  // Test 7: Account B starts later (gap at beginning)
  it('starts only when both accounts have a valuation', () => {
    const accountA = [
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-02', value: 110 },
      { date: '2026-01-03', value: 115 },
    ]
    const accountB = [
      { date: '2026-01-02', value: 200 },
      { date: '2026-01-03', value: 210 },
    ]
    const result = mergeDailySnapshots([accountA, accountB])
    expect(result).toEqual([
      { date: '2026-01-02', value: 310 },
      { date: '2026-01-03', value: 325 },
    ])
  })

  // Test 8: Forward-fill (account A missing Jan 2)
  it('omits dates with an unvalued account', () => {
    const accountA = [
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-03', value: 120 },  // Jan 2 missing
    ]
    const accountB = [
      { date: '2026-01-01', value: 200 },
      { date: '2026-01-02', value: 210 },
      { date: '2026-01-03', value: 220 },
    ]
    const result = mergeDailySnapshots([accountA, accountB])
    expect(result).toEqual([
      { date: '2026-01-01', value: 300 },
      { date: '2026-01-03', value: 340 },
    ])
  })

  // Test 9: Single account (passthrough)
  it('returns identical snapshots for single account', () => {
    const accountA = [
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-02', value: 110 },
    ]
    const result = mergeDailySnapshots([accountA])
    expect(result).toEqual([
      { date: '2026-01-01', value: 100 },
      { date: '2026-01-02', value: 110 },
    ])
  })
})

describe('modifiedDietz', () => {
  // Test 10: Basic case
  it('computes modified dietz correctly', () => {
    // vStart = 100000, vEnd = 160000
    // CF: Jun 1, amount = 50000
    // from = Jan 1 2026, to = Dec 31 2026
    // totalDays = 364 (2026 non-leap)
    // daysBetween("2026-06-01", "2026-12-31") = 213
    // weight = 213/364 ≈ 0.5852
    // weightedCF = 50000 * 0.5852 = 29260
    // return = (160000 - 100000 - 50000) / (100000 + 29260) = 10000/129260 ≈ 0.0774
    const result = modifiedDietz(
      100000,
      160000,
      [{ date: '2026-06-01', amount: 50000 }],
      '2026-01-01',
      '2026-12-31'
    )
    expect(result).toBeCloseTo(0.0774, 2)
  })
})

describe('MAX_EXACT_GAP_DAYS', () => {
  // Test 11: constant value
  it('is 7', () => {
    expect(MAX_EXACT_GAP_DAYS).toBe(7)
  })
})

describe('calcTWRFrom', () => {
  const snapshots = [
    { date: '2026-01-01', value: 100000 },
    { date: '2026-04-01', value: 103000 },
    { date: '2026-06-01', value: 106000 },
  ]
  const cashFlows = [
    { date: '2026-03-01', amount: 5000 },  // before mid-point
    { date: '2026-05-01', amount: 2000 },  // after mid-point
  ]

  // T1: fromDate earlier than all snapshots — strict mode returns null (no data at period start)
  it('returns null when fromDate precedes all snapshots', () => {
    const from = calcTWRFrom(snapshots, cashFlows, '2025-01-01')
    expect(from).toBeNull()
  })

  // T2: fromDate matches an existing snapshot — starts from that snapshot
  it('starts from exact snapshot when fromDate matches', () => {
    // from 4/1: snapshots [4/1=103000, 6/1=106000], CF [5/1=2000]
    // CF on 5/1: preSnap=4/1(103000), postSnap=6/1(106000) → modifiedDietz
    const result = calcTWRFrom(snapshots, cashFlows, '2026-04-01')
    expect(result).not.toBeNull()
    // one sub-period with CF using modifiedDietz(103000, 106000, [{5/1, 2000}], 4/1, 6/1)
    const days = (new Date('2026-06-01').getTime() - new Date('2026-04-01').getTime()) / 86400000
    const w = (new Date('2026-06-01').getTime() - new Date('2026-05-01').getTime()) / 86400000 / days
    const expected = (106000 - 103000 - 2000) / (103000 + 2000 * w)
    expect(result!).toBeCloseTo(expected, 6)
  })

  it('does not manufacture a month-old period-start valuation', () => {
    expect(calcTWRFrom(snapshots, cashFlows, '2026-02-01')).toBeNull()
  })

  it('includes cash flow on synthetic fromDate start', () => {
    const result = calcTWRFrom(
      [
        { date: '2026-04-19', value: 100000 },
        { date: '2026-05-20', value: 110000 },
      ],
      [{ date: '2026-04-20', amount: 10000 }],
      '2026-04-20'
    )

    expect(result).not.toBeNull()
    expect(result!).toBeCloseTo(0, 10)
  })

  // T4: fromDate after all snapshots — returns null (< 2 snapshots)
  it('returns null when fromDate is after all snapshots', () => {
    expect(calcTWRFrom(snapshots, cashFlows, '2027-01-01')).toBeNull()
  })

  // T5: CFs before fromDate are excluded
  it('excludes cash flows before fromDate', () => {
    // from 4/1: CF on 3/1 should be excluded, only CF on 5/1 counts
    const withEarlyCF = calcTWRFrom(snapshots, cashFlows, '2026-04-01')
    const withoutEarlyCF = calcTWRFrom(
      snapshots,
      [{ date: '2026-05-01', amount: 2000 }],  // only the 5/1 CF
      '2026-04-01'
    )
    expect(withEarlyCF).toBeCloseTo(withoutEarlyCF!, 10)
  })
})


describe('incomplete and zero-balance history', () => {
  it('does not report an unfunded account as an infinite return', () => {
    expect(calcTWR([{ date: '2026-01-01', value: 0 }, { date: '2026-01-02', value: 100 }], [])).toBeNull()
    expect(modifiedDietz(100, 0, [{ date: '2026-01-01', amount: -100 }], '2026-01-01', '2026-01-02')).toBeNull()
  })
  it('does not count a deposit before a synthetic period start as growth', () => {
    const snapshots = [{ date: '2026-01-01', value: 100 }, { date: '2026-01-10', value: 200 }]
    expect(calcTWRFrom(snapshots, [{ date: '2026-01-02', amount: 100 }], '2026-01-03')).toBeNull()
  })
  it('returns no aggregate when a selected account has no history', () => {
    expect(mergeDailySnapshots([[{ date: '2026-01-01', value: 100 }], []])).toEqual([])
  })
  it('does not turn a newly included account into a 100% gain', () => {
    const merged = mergeDailySnapshots([
      [{ date: '2026-01-01', value: 100 }, { date: '2026-01-02', value: 100 }, { date: '2026-01-03', value: 100 }],
      [{ date: '2026-01-02', value: 100 }, { date: '2026-01-03', value: 100 }],
    ])
    expect(calcTWR(merged, [])).toBe(0)
  })
  it('rejects non-finite valuations', () => {
    expect(modifiedDietz(100, Infinity, [], '2026-01-01', '2026-01-02')).toBeNull()
  })
})

it('does not report a return from ambiguous duplicate-date valuations', () => {
  expect(calcTWR([{ date: '2026-01-01', value: 100 }, { date: '2026-01-01', value: 101 }], [])).toBeNull()
})
