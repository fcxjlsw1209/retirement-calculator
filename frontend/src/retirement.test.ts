import { describe, it, expect } from 'vitest'
import {
  runMonteCarlo,
  computeHoldingWeights,
  computePlanningRequired,
  checkBridgeGap,
  ASSET_PARAMS,
  type SpendingPhase,
  type RetirementParams,
} from './retirement'

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makePhases(startAge: number, endAge: number, monthlySpend = 5000): SpendingPhase[] {
  return [{ id: '1', label: '退休生活', startAge, endAge, items: [{ id: 'item-1', label: '生活费', monthlySpend }] }]
}

const BASE_PARAMS: RetirementParams = {
  currentAge: 40,
  retirementAge: 65,
  maxAge: 90,
  taxableBalance: 300_000,
  retirementBalance: 200_000,
  monthlyContribution: 3_000,
  holdingWeights: { equity: 0.8, bond: 0.2 },
  inflationRate: 0.025,
  effectiveTaxRate: 0,
  spendingPhases: makePhases(65, 90, 5_000),
  simCount: 1000,
}

// ─── Ages array ────────────────────────────────────────────────────────────────

describe('ages array', () => {
  it('has length maxAge - currentAge + 1', () => {
    const result = runMonteCarlo({ ...BASE_PARAMS, simCount: 100 })
    expect(result.ages.length).toBe(BASE_PARAMS.maxAge - BASE_PARAMS.currentAge + 1)
  })

  it('starts at currentAge and ends at maxAge', () => {
    const result = runMonteCarlo({ ...BASE_PARAMS, simCount: 100 })
    expect(result.ages[0]).toBe(BASE_PARAMS.currentAge)
    expect(result.ages[result.ages.length - 1]).toBe(BASE_PARAMS.maxAge)
  })

  it('is monotonically increasing by 1', () => {
    const result = runMonteCarlo({ ...BASE_PARAMS, simCount: 100 })
    for (let i = 1; i < result.ages.length; i++) {
      expect(result.ages[i]).toBe(result.ages[i - 1] + 1)
    }
  })
})

// ─── Percentile curves ─────────────────────────────────────────────────────────

describe('percentile ordering', () => {
  it('p10 ≤ p50 ≤ p90 at every age', () => {
    const result = runMonteCarlo(BASE_PARAMS)
    for (let i = 0; i < result.ages.length; i++) {
      expect(result.p10[i]).toBeLessThanOrEqual(result.p50[i] + 1e-9)
      expect(result.p50[i]).toBeLessThanOrEqual(result.p90[i] + 1e-9)
    }
  })

  it('curves have same length as ages', () => {
    const result = runMonteCarlo({ ...BASE_PARAMS, simCount: 200 })
    expect(result.p10.length).toBe(result.ages.length)
    expect(result.p50.length).toBe(result.ages.length)
    expect(result.p90.length).toBe(result.ages.length)
  })

  it('initial value equals total balance for all percentiles', () => {
    const initial = BASE_PARAMS.taxableBalance + BASE_PARAMS.retirementBalance
    const result = runMonteCarlo({ ...BASE_PARAMS, simCount: 200 })
    // The first yearValues entry is pushed before any simulation step, so all sims agree
    expect(result.p10[0]).toBeCloseTo(initial, 0)
    expect(result.p50[0]).toBeCloseTo(initial, 0)
    expect(result.p90[0]).toBeCloseTo(initial, 0)
  })
})

// ─── Success rate ─────────────────────────────────────────────────────────────

describe('successRate', () => {
  it('is 0 when balance is zero and spending is positive', () => {
    const result = runMonteCarlo({
      ...BASE_PARAMS,
      taxableBalance: 0,
      retirementBalance: 0,
      monthlyContribution: 0,
      simCount: 200,
    })
    // With zero balance and spending, every sim depletes immediately at retirementAge
    expect(result.successRate).toBe(0)
  })

  it('is 1 when spending is zero (no withdrawals)', () => {
    const result = runMonteCarlo({
      ...BASE_PARAMS,
      spendingPhases: makePhases(65, 90, 0),  // $0/month
      simCount: 500,
    })
    expect(result.successRate).toBe(1)
  })

  it('is between 0 and 1 for realistic params', () => {
    const result = runMonteCarlo(BASE_PARAMS)
    expect(result.successRate).toBeGreaterThanOrEqual(0)
    expect(result.successRate).toBeLessThanOrEqual(1)
  })

  it('decreases as spending increases', () => {
    const lowSpend = runMonteCarlo({ ...BASE_PARAMS, spendingPhases: makePhases(65, 90, 2_000), simCount: 500 })
    const highSpend = runMonteCarlo({ ...BASE_PARAMS, spendingPhases: makePhases(65, 90, 15_000), simCount: 500 })
    expect(lowSpend.successRate).toBeGreaterThan(highSpend.successRate)
  })
})

// ─── computePlanningRequired ──────────────────────────────────────────────────

describe('computePlanningRequired', () => {
  const planParams = { currentAge: 41, inflationRate: 0.025, effectiveTaxRate: 0.22 }

  it('returns 0 for a zero-spend phase', () => {
    const phase: SpendingPhase = { id: '1', label: 'Test', startAge: 54, endAge: 58, items: [{ id: 'i', label: 'x', monthlySpend: 0 }] }
    expect(computePlanningRequired(phase, planParams)).toBe(0)
  })

  it('returns a positive value for non-zero spend', () => {
    const phase: SpendingPhase = { id: '1', label: 'College', startAge: 54, endAge: 58, items: [{ id: 'i', label: 'tuition', monthlySpend: 20_000 }] }
    const pv = computePlanningRequired(phase, planParams)
    expect(pv).toBeGreaterThan(0)
  })

  it('is roughly $900k for flat today-dollars example (College $20k/mo, 54-58, age 41, no excess inflation, tax 22%, safeRate 3%)', () => {
    const phase: SpendingPhase = { id: '1', label: 'College', startAge: 54, endAge: 58, items: [{ id: 'i', label: 'tuition', monthlySpend: 20_000 }] }
    const pv = computePlanningRequired(phase, planParams, 0.03)
    // No excess inflation: spending stays flat in real terms, PV is lower than old nominal model
    expect(pv).toBeGreaterThan(700_000)
    expect(pv).toBeLessThan(1_100_000)
  })

  it('increases with higher monthly spend', () => {
    const base: SpendingPhase = { id: '1', label: 'X', startAge: 50, endAge: 55, items: [{ id: 'i', label: 'x', monthlySpend: 5_000 }] }
    const high: SpendingPhase = { ...base, items: [{ id: 'i', label: 'x', monthlySpend: 20_000 }] }
    expect(computePlanningRequired(high, planParams)).toBeGreaterThan(computePlanningRequired(base, planParams))
  })

  it('longer phase requires more capital', () => {
    const short: SpendingPhase = { id: '1', label: 'X', startAge: 50, endAge: 52, items: [{ id: 'i', label: 'x', monthlySpend: 5_000 }] }
    const long: SpendingPhase = { ...short, endAge: 58 }
    expect(computePlanningRequired(long, planParams)).toBeGreaterThan(computePlanningRequired(short, planParams))
  })
})

// ─── checkBridgeGap ───────────────────────────────────────────────────────────

describe('checkBridgeGap', () => {
  it('ok=true when retirementAge >= 60 (no pre-60 spending)', () => {
    const result = checkBridgeGap(BASE_PARAMS, makePhases(65, 90, 5_000))
    expect(result.ok).toBe(true)
    expect(result.pre60Cost).toBe(0)
    expect(result.shortfall).toBe(0)
  })

  it('ok=true when taxable is very large relative to pre-60 spending', () => {
    const params: RetirementParams = {
      ...BASE_PARAMS,
      currentAge: 45,
      retirementAge: 55,
      taxableBalance: 10_000_000,
      retirementBalance: 1_000_000,
      monthlyContribution: 0,
    }
    const phases = makePhases(55, 90, 5_000)
    const result = checkBridgeGap(params, phases)
    expect(result.ok).toBe(true)
    expect(result.shortfall).toBe(0)
  })

  it('ok=false and shortfall > 0 when taxable is nearly zero with pre-60 spending', () => {
    const params: RetirementParams = {
      ...BASE_PARAMS,
      currentAge: 40,
      retirementAge: 55,
      taxableBalance: 1_000,
      retirementBalance: 3_000_000,
      monthlyContribution: 0,
    }
    const phases = makePhases(55, 90, 10_000)
    const result = checkBridgeGap(params, phases)
    expect(result.ok).toBe(false)
    expect(result.shortfall).toBeGreaterThan(0)
    expect(result.pre60Cost).toBeGreaterThan(0)
  })

  it('taxableAtRetirement is always non-negative', () => {
    const params: RetirementParams = { ...BASE_PARAMS, taxableBalance: 0, monthlyContribution: 0 }
    const result = checkBridgeGap(params, makePhases(65, 90, 5_000))
    expect(result.taxableAtRetirement).toBeGreaterThanOrEqual(0)
  })

  it('shortfall = max(0, pre60Cost - taxableAtRetirement)', () => {
    const params: RetirementParams = {
      ...BASE_PARAMS,
      currentAge: 40,
      retirementAge: 55,
      taxableBalance: 500_000,
      retirementBalance: 500_000,
      monthlyContribution: 0,
    }
    const phases = makePhases(55, 90, 10_000)
    const result = checkBridgeGap(params, phases)
    expect(result.shortfall).toBeCloseTo(Math.max(0, result.pre60Cost - result.taxableAtRetirement), 0)
  })
})

// ─── runMonteCarlo with isPlanned ─────────────────────────────────────────────

describe('runMonteCarlo isPlanned filtering', () => {
  it('planned phases do not affect successRate (same as having zero spend in that phase)', () => {
    const withPlanned = runMonteCarlo({
      ...BASE_PARAMS,
      spendingPhases: [
        { id: '1', label: 'Retirement', startAge: 65, endAge: 80, items: [{ id: 'i1', label: '生活费', monthlySpend: 5_000 }] },
        { id: '2', label: 'College', startAge: 80, endAge: 90, items: [{ id: 'i2', label: 'tuition', monthlySpend: 15_000 }], isPlanned: true },
      ],
      simCount: 500,
    })
    const withZeroUnplanned = runMonteCarlo({
      ...BASE_PARAMS,
      spendingPhases: [
        { id: '1', label: 'Retirement', startAge: 65, endAge: 80, items: [{ id: 'i1', label: '生活费', monthlySpend: 5_000 }] },
        { id: '2', label: 'College', startAge: 80, endAge: 90, items: [{ id: 'i2', label: 'tuition', monthlySpend: 0 }] },
      ],
      simCount: 500,
    })
    // Success rates should be very close (same effective spending in both cases)
    expect(Math.abs(withPlanned.successRate - withZeroUnplanned.successRate)).toBeLessThan(0.08)
  })

  it('marking a phase planned increases successRate vs leaving it unplanned', () => {
    const basePhases: SpendingPhase[] = [
      { id: '1', label: 'Retirement', startAge: 65, endAge: 80, items: [{ id: 'i1', label: '生活费', monthlySpend: 5_000 }] },
      { id: '2', label: 'Expensive', startAge: 80, endAge: 90, items: [{ id: 'i2', label: 'big', monthlySpend: 20_000 }] },
    ]
    const unplanned = runMonteCarlo({ ...BASE_PARAMS, spendingPhases: basePhases, simCount: 500 })
    const planned = runMonteCarlo({
      ...BASE_PARAMS,
      spendingPhases: basePhases.map((p, i) => i === 1 ? { ...p, isPlanned: true } : p),
      simCount: 500,
    })
    expect(planned.successRate).toBeGreaterThanOrEqual(unplanned.successRate)
  })
})

// ─── Retirement threshold gap ─────────────────────────────────────────────────

describe('medianGapToRetirement', () => {
  it('is 0 when portfolio is very large relative to spending', () => {
    const result = runMonteCarlo({
      ...BASE_PARAMS,
      taxableBalance: 50_000_000,  // $50M
      retirementBalance: 50_000_000,
      spendingPhases: makePhases(65, 90, 5_000),
      simCount: 500,
    })
    expect(result.medianGapToRetirement).toBe(0)
  })

  it('is positive when portfolio is small relative to spending', () => {
    const result = runMonteCarlo({
      ...BASE_PARAMS,
      taxableBalance: 0,
      retirementBalance: 0,
      monthlyContribution: 0,
      spendingPhases: makePhases(65, 90, 5_000),
      simCount: 500,
    })
    expect(result.medianGapToRetirement).toBeGreaterThan(0)
  })

  it('is non-negative always', () => {
    const result = runMonteCarlo(BASE_PARAMS)
    expect(result.medianGapToRetirement).toBeGreaterThanOrEqual(0)
  })
})

// ─── yearsToRetirement ────────────────────────────────────────────────────────

describe('yearsToRetirement', () => {
  it('returns null when already retirement-ready (t=0 satisfies)', () => {
    // $100M balance, trivial spending, no need for any more contributions
    const result = runMonteCarlo({
      ...BASE_PARAMS,
      taxableBalance: 50_000_000,
      retirementBalance: 50_000_000,
      spendingPhases: makePhases(65, 90, 1_000),
      simCount: 100,
    })
    expect(result.yearsToRetirement).toBeNull()
    expect(result.medianGapToRetirement).toBe(0)
  })

  it('returns null when unreachable (gap too large, no path to threshold)', () => {
    // $0 balance, $0 contributions, but huge spending → threshold never reached
    const result = runMonteCarlo({
      ...BASE_PARAMS,
      taxableBalance: 0,
      retirementBalance: 0,
      monthlyContribution: 0,
      spendingPhases: makePhases(65, 90, 50_000),
      simCount: 100,
    })
    // medianGapToRetirement > 0 + yearsToRetirement null → unreachable
    expect(result.yearsToRetirement).toBeNull()
    expect(result.medianGapToRetirement).toBeGreaterThan(0)
  })

  it('returns a positive number of years when reachable with contributions', () => {
    // Moderate balance + contributions, should reach threshold in some years
    const result = runMonteCarlo({
      ...BASE_PARAMS,
      taxableBalance: 100_000,
      retirementBalance: 100_000,
      monthlyContribution: 10_000,
      spendingPhases: makePhases(65, 90, 3_000),
      simCount: 100,
    })
    if (result.yearsToRetirement !== null) {
      expect(result.yearsToRetirement).toBeGreaterThan(0)
      expect(result.yearsToRetirement).toBeLessThanOrEqual(BASE_PARAMS.retirementAge - BASE_PARAMS.currentAge)
    }
  })
})

// ─── computeHoldingWeights ────────────────────────────────────────────────────

describe('computeHoldingWeights', () => {
  it('returns { blended: 1 } for empty holdings', () => {
    expect(computeHoldingWeights([])).toEqual({ blended: 1 })
  })

  it('returns { blended: 1 } when total value is zero', () => {
    expect(computeHoldingWeights([
      { holding_type: 'US Stock', value_usd: 0 },
    ])).toEqual({ blended: 1 })
  })

  it('maps US Stock - Tech → individual_stock', () => {
    const w = computeHoldingWeights([{ holding_type: 'US Stock - Tech', value_usd: 100 }])
    expect(w.individual_stock).toBeCloseTo(1.0, 9)
  })

  it('maps US Fund - Tech → tech_fund', () => {
    const w = computeHoldingWeights([{ holding_type: 'US Fund - Tech', value_usd: 100 }])
    expect(w.tech_fund).toBeCloseTo(1.0, 9)
  })

  it('maps Bond Fund → bond', () => {
    const w = computeHoldingWeights([{ holding_type: 'Bond Fund', value_usd: 100 }])
    expect(w.bond).toBeCloseTo(1.0, 9)
  })

  it('maps Cash → cash', () => {
    const w = computeHoldingWeights([{ holding_type: 'Cash', value_usd: 100 }])
    expect(w.cash).toBeCloseTo(1.0, 9)
  })

  it('maps Intl Stock → intl_stock', () => {
    const w = computeHoldingWeights([{ holding_type: 'Intl Stock', value_usd: 100 }])
    expect(w.intl_stock).toBeCloseTo(1.0, 9)
  })

  it('maps unknown type → blended', () => {
    const w = computeHoldingWeights([{ holding_type: 'Something Exotic', value_usd: 100 }])
    expect(w.blended).toBeCloseTo(1.0, 9)
  })

  it('computes portfolio-weighted fractions correctly', () => {
    const w = computeHoldingWeights([
      { holding_type: 'US Fund - Broad', value_usd: 300 },  // 75% equity
      { holding_type: 'Bond Fund', value_usd: 100 },         // 25% bond
    ])
    expect(w.equity).toBeCloseTo(0.75, 9)
    expect(w.bond).toBeCloseTo(0.25, 9)
  })

  it('weights sum to 1 for mixed holdings', () => {
    const w = computeHoldingWeights([
      { holding_type: 'US Fund - Broad', value_usd: 400 },
      { holding_type: 'Bond', value_usd: 200 },
      { holding_type: 'Intl Stock', value_usd: 200 },
      { holding_type: 'Cash', value_usd: 200 },
    ])
    const total = Object.values(w).reduce((s, v) => s + (v ?? 0), 0)
    expect(total).toBeCloseTo(1.0, 9)
  })

  it('ignores holdings with value_usd <= 0', () => {
    const w = computeHoldingWeights([
      { holding_type: 'Bond', value_usd: -100 },
      { holding_type: 'US Fund - Broad', value_usd: 200 },
    ])
    expect(w.equity).toBeCloseTo(1.0, 9)
    expect(w.bond).toBeUndefined()
  })
})

// ─── ASSET_PARAMS sanity ──────────────────────────────────────────────────────

describe('ASSET_PARAMS', () => {
  it('equity has higher mean return than bond and cash', () => {
    expect(ASSET_PARAMS.equity.mean).toBeGreaterThan(ASSET_PARAMS.bond.mean)
    expect(ASSET_PARAMS.equity.mean).toBeGreaterThan(ASSET_PARAMS.cash.mean)
  })

  it('crypto has highest mean and std', () => {
    expect(ASSET_PARAMS.crypto.mean).toBeGreaterThan(ASSET_PARAMS.equity.mean)
    expect(ASSET_PARAMS.crypto.std).toBeGreaterThan(ASSET_PARAMS.individual_stock.std)
  })

  it('cash has lowest volatility', () => {
    expect(ASSET_PARAMS.cash.std).toBeLessThan(ASSET_PARAMS.equity.std)
    expect(ASSET_PARAMS.cash.std).toBeLessThan(ASSET_PARAMS.bond.std)
  })

  it('individual stocks more volatile than equivalent funds', () => {
    expect(ASSET_PARAMS.individual_stock.std).toBeGreaterThan(ASSET_PARAMS.equity.std)
    expect(ASSET_PARAMS.intl_stock.std).toBeGreaterThan(ASSET_PARAMS.international.std)
  })
})
