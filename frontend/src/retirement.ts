import type { Holding } from './api'
import { HISTORICAL_RETURNS } from './historicalReturns'

// ─── Types ────────────────────────────────────────────────────────────────────

export type AssetClass =
  | 'equity'           // US broad market funds (VOO, SPY)
  | 'tech_fund'        // US tech/growth funds (QQQ, VGT)
  | 'small_cap'        // US small cap funds (IWM, VB)
  | 'individual_stock' // US individual stocks (GOOG, AAPL, XOM)
  | 'international'    // International funds (IEFA, VEA)
  | 'intl_stock'       // International individual stocks (BABA, TSM)
  | 'bond'             // Bond funds / individual bonds
  | 'cash'             // Cash / money market
  | 'crypto'           // Crypto (BTC, ETH)
  | 'gold'             // Gold / precious metals
  | 'alternative'      // Commodities, managed futures
  | 'blended'          // Target date, thematic, unknown

export type AssetClassWeights = Partial<Record<AssetClass, number>>
export type AssetReturnRates = Partial<Record<AssetClass, number>>

export interface SpendingItem {
  id: string
  label: string
  monthlySpend: number   // today's dollars (ignored when isLumpSum)
  isLumpSum?: boolean    // one-time payment at lumpSumAge
  lumpSumAge?: number    // age at which lump sum is paid
  lumpSumAmount?: number // today's dollars
}

export interface SpendingPhase {
  id: string
  label: string
  startAge: number
  endAge: number
  items: SpendingItem[]
  isPlanned?: boolean
  excessInflationRate?: number  // excess above real return; 0 = today's dollars flat; 0.025 = medical-tier growth
}

export function phaseMonthlyTotal(phase: SpendingPhase): number {
  return phase.items.reduce((s, item) => s + (item.isLumpSum ? 0 : item.monthlySpend), 0)
}

export function phaseLumpSums(phase: SpendingPhase): SpendingItem[] {
  return phase.items.filter(item => item.isLumpSum && (item.lumpSumAmount ?? 0) > 0)
}

// Preserve every phase and its budget when the planning range changes.
export function fitSpendingPhases(phases: SpendingPhase[], startAge: number, endAge: number): SpendingPhase[] {
  if (!phases.length || endAge - startAge < phases.length) return phases
  let start = startAge
  return phases.map((phase, i) => {
    const end = i === phases.length - 1 ? endAge
      : Math.max(start + 1, Math.min(phase.endAge, endAge - (phases.length - i - 1)))
    const next = { ...phase, startAge: start, endAge: end }
    start = end
    return next
  })
}

export interface CustomAsset {
  id: string
  name: string
  value: number   // current market value in USD
  mean: number    // annual real return, e.g. 0.05
  std: number     // annual std dev, e.g. 0.12
  availableForSpending?: boolean // explicit consent to treat as liquid and rebalance at retirement
}

export interface SocialSecurity {
  startAge: number       // age to start receiving SS
  monthlyBenefit: number // today's dollars (engine applies inflation adjustment)
}

export interface RetirementParams {
  currentAge: number
  retirementAge: number
  maxAge: number
  taxableBalance: number
  retirementBalance: number
  monthlyContribution: number
  holdingWeights: AssetClassWeights
  returnRates?: AssetReturnRates // real annual arithmetic means at baseline inflation
  customAssets?: CustomAsset[]
  socialSecurity?: SocialSecurity[]  // one entry per person (user + spouse)
  inflationRate: number     // default 0.025
  effectiveTaxRate: number  // blended withdrawal tax rate, default 0.22
  spendingPhases: SpendingPhase[]
  simCount: number          // default 1000
  seed?: number             // stable by default; scenarios use common annual draws
  postRetirementEquityPct?: number  // 0–1; fraction of portfolio kept in equity after retirement
}

export interface MonteCarloResult {
  p10: number[]             // portfolio value at each age, 10th percentile
  p50: number[]             // 50th percentile
  p90: number[]             // 90th percentile
  ages: number[]
  earlyWithdrawalRate: number // paths requiring retirement account access before age 60
  successRate: number       // fraction of sims where portfolio never depletes (excludes planned phases)
  medianGapToRetirement: number  // max(0, threshold - p50 at retirementAge)
  yearsToRetirement: number | null  // additional contribution years before coasting to the fixed retirement age, not an earliest retirement date
}

export interface BridgeGapResult {
  ok: boolean
  taxableAtRetirement: number   // projected taxable account balance at retirementAge
  pre60Cost: number             // pre-60 net spending in today's dollars, tax grossed up
  shortfall: number             // max(0, pre60Cost - taxableAtRetirement)
}

// ─── Return parameters (real annual returns, inflation-adjusted) ───────────────

export const ASSET_PARAMS: Record<AssetClass, { mean: number; std: number }> = {
  equity:           { mean: 0.07,  std: 0.15  },  // scenario assumption; historical shocks are rescaled
  tech_fund:        { mean: 0.10,  std: 0.22  },  // QQQ/VGT: higher return, more volatile
  small_cap:        { mean: 0.09,  std: 0.20  },  // small cap premium
  individual_stock: { mean: 0.09,  std: 0.32  },  // single stock: ~2× fund volatility
  international:    { mean: 0.05,  std: 0.16  },  // developed + EM funds
  intl_stock:       { mean: 0.05,  std: 0.35  },  // individual intl stocks + geopolitical risk
  bond:             { mean: 0.02,  std: 0.05  },
  cash:             { mean: 0.005, std: 0.005 },
  crypto:           { mean: 0.12,  std: 0.75  },  // BTC/ETH historical
  gold:             { mean: 0.04,  std: 0.18  },  // scenario assumption, real return
  alternative:      { mean: 0.04,  std: 0.12  },  // commodities / managed futures
  blended:          { mean: 0.06,  std: 0.12  },  // target date, thematic, unknown
}

// Resolve per-scenario means without changing shared defaults or volatility.
export function resolveAssetParams(returnRates: AssetReturnRates = {}): typeof ASSET_PARAMS {
  if (!returnRates || typeof returnRates !== 'object' || Array.isArray(returnRates) ||
      Object.entries(returnRates).some(([cls, rate]) =>
        !Object.prototype.hasOwnProperty.call(ASSET_PARAMS, cls) || !Number.isFinite(rate) || rate <= -1 || rate > 1)) {
    throw new RangeError('Annual return rates must be greater than -100% and at most 100%')
  }
  return Object.fromEntries(Object.entries(ASSET_PARAMS).map(([cls, params]) => [cls, {
    ...params, mean: returnRates[cls as AssetClass] ?? params.mean,
  }])) as typeof ASSET_PARAMS
}

// Paired real annual returns preserve equity/bond dependence. Means and standard
// deviations below are scenario assumptions, not forecasts inferred from history.
const SP500_REAL = HISTORICAL_RETURNS.map(([, equity, , inflation]) => (1 + equity) / (1 + inflation) - 1)
const BOND10_REAL = HISTORICAL_RETURNS.map(([, , bond, inflation]) => (1 + bond) / (1 + inflation) - 1)
function standardized(values: number[]): number[] {
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length
  const std = Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / values.length)
  return values.map(n => (n - mean) / std)
}
const EQUITY_Z = standardized(SP500_REAL)
const BOND_Z = standardized(BOND10_REAL)

type Random = () => number
function seededRandom(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state += 0x6D2B79F5
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function randn(random: Random): number {
  const u = 1 - random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random())
}
function drawHistoricalYear(random: Random) {
  const idx = Math.floor(random() * EQUITY_Z.length)
  return { zEquity: EQUITY_Z[idx], zBond: BOND_Z[idx] }
}

function bootstrapPortfolioReturn(
  weights: AssetClassWeights,
  customAssets: CustomAsset[],
  portfolioValue: number,
  customTotal: number,
  inflationAdj: number,
  random: Random,
  assetParams: typeof ASSET_PARAMS,
): number {
  const { zEquity, zBond } = drawHistoricalYear(random)
  const grandTotal = portfolioValue + customTotal
  const effectiveWeights = Object.values(weights).some(w => (w ?? 0) > 0) ? weights : { blended: 1 }
  const holdingWeight = Object.values(effectiveWeights).reduce((s, w) => s + (w ?? 0), 0)
  const portfolioShare = grandTotal > 0 ? portfolioValue / grandTotal : 1
  let ret = 0
  // Stable iteration also keeps random draws comparable across allocation changes.
  for (const cls of Object.keys(ASSET_PARAMS) as AssetClass[]) {
    const independent = randn(random)
    const w = effectiveWeights[cls] ?? 0
    const p = assetParams[cls]
    let z: number
    if (cls === 'bond') z = zBond
    else if (cls === 'cash') z = 0
    else if (cls === 'crypto') z = independent
    else {
      const corr = cls === 'tech_fund' ? 0.85 : cls === 'small_cap' ? 0.8
        : cls === 'international' ? 0.65 : cls === 'intl_stock' ? 0.6
        : cls === 'gold' ? 0.1 : cls === 'alternative' ? 0.3 : 1
      z = corr * zEquity + Math.sqrt(1 - corr ** 2) * independent
    }
    ret += w / holdingWeight * portfolioShare * Math.max(-1, p.mean + inflationAdj + p.std * z)
  }
  for (const asset of customAssets) {
    const z = 0.4 * zEquity + Math.sqrt(1 - 0.16) * randn(random)
    if (grandTotal > 0) ret += asset.value / grandTotal * Math.max(-1, asset.mean + inflationAdj + asset.std * z)
  }
  return ret
}

function bootstrapBlendReturn(eqPct: number, bdPct: number, inflationAdj: number, random: Random, assetParams: typeof ASSET_PARAMS): number {
  const { zEquity, zBond } = drawHistoricalYear(random)
  return eqPct * (assetParams.equity.mean + assetParams.equity.std * zEquity + inflationAdj)
    + bdPct * (assetParams.bond.mean + assetParams.bond.std * zBond + inflationAdj)
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

function holdingTypeToAssetClass(holdingType: string): AssetClass {
  switch (holdingType) {
    case 'US Fund - Broad':
    case 'US Fund - Target Date': return 'equity'
    case 'US Fund - Tech':        return 'tech_fund'
    case 'US Fund - Small Cap':   return 'small_cap'
    case 'US Fund - Thematic':    return 'blended'
    case 'US Stock - Tech':
    case 'US Stock - Other':      return 'individual_stock'
    case 'Intl Fund':             return 'international'
    case 'Intl Stock':            return 'intl_stock'
    case 'Bond Fund':
    case 'Bond':                  return 'bond'
    case 'Cash':                  return 'cash'
    case 'Crypto':                return 'crypto'
    case 'Gold':                  return 'gold'
    case 'Alternative':           return 'alternative'
    default:                      return 'blended'
  }
}

function computeBlendedParams(
  weights: AssetClassWeights,
  portfolioValue: number,
  customAssets: CustomAsset[] = [],
  assetParams: typeof ASSET_PARAMS = ASSET_PARAMS,
): { mean: number; std: number } {
  const holdingWeight = Object.values(weights).reduce((s, w) => s + (w ?? 0), 0)
  const customTotal = customAssets.reduce((s, a) => s + a.value, 0)
  const grandTotal = portfolioValue + customTotal
  if (grandTotal === 0) return assetParams.blended

  // Portfolio holdings contribution (already normalized weights → scale by portfolioValue share)
  let mean = 0
  let varSum = 0
  const portfolioShare = holdingWeight > 0 ? portfolioValue / grandTotal : 0

  for (const [cls, w] of Object.entries(weights) as [AssetClass, number | undefined][]) {
    if (!w) continue
    const normW = (w / holdingWeight) * portfolioShare
    const p = assetParams[cls]
    mean += normW * p.mean
    varSum += (normW * p.std) ** 2
  }

  // Custom assets contribution
  for (const asset of customAssets) {
    if (asset.value <= 0) continue
    const normW = asset.value / grandTotal
    mean += normW * asset.mean
    varSum += (normW * asset.std) ** 2
  }

  // Zero is a valid configured return. Only missing allocations use the fallback.
  return holdingWeight === 0 && customTotal === 0 ? assetParams.blended : { mean, std: Math.sqrt(varSum) }
}

// Returns annual SS income in today's dollars. SS is COLA-adjusted, so in real terms
// (which is what our model uses) it stays flat — no growth multiplier needed.
function getAnnualSSIncome(
  age: number,
  ss: SocialSecurity[],
  _inflationRate: number,
  _currentAge: number,
): number {
  let total = 0
  for (const s of ss) {
    if (age >= s.startAge && s.monthlyBenefit > 0) {
      total += s.monthlyBenefit * 12
    }
  }
  return total
}

// Returns annual recurring spend in today's dollars, growing only at excess inflation rate.
// Real portfolio returns already cover base inflation; excessInflationRate captures
// costs that outpace the market (e.g. medical). Default 0 = flat in today's dollars.
function getAnnualSpend(
  age: number,
  spendingPhases: SpendingPhase[],
  _globalInflationRate: number,
  currentAge: number,
): number {
  for (const phase of spendingPhases) {
    if (age >= phase.startAge && age < phase.endAge) {
      const excess = phase.excessInflationRate ?? 0
      const yearsFromToday = age - currentAge
      return phaseMonthlyTotal(phase) * 12 * Math.pow(1 + excess, yearsFromToday)
    }
  }
  return 0
}

// Returns lump sum spend in today's dollars, grown at phase excess inflation rate.
function getLumpSumSpend(
  age: number,
  spendingPhases: SpendingPhase[],
  _globalInflationRate: number,
  currentAge: number,
): number {
  let total = 0
  for (const phase of spendingPhases) {
    const excess = phase.excessInflationRate ?? 0
    for (const item of phase.items) {
      if (item.isLumpSum && item.lumpSumAge === age && (item.lumpSumAmount ?? 0) > 0) {
        const yearsFromToday = age - currentAge
        total += (item.lumpSumAmount ?? 0) * Math.pow(1 + excess, yearsFromToday)
      }
    }
  }
  return total
}

// PV at retirementAge of all future spending phases (start-of-year withdrawal convention)
function computeRetirementThreshold(
  currentAge: number,
  retirementAge: number,
  maxAge: number,
  spendingPhases: SpendingPhase[],
  socialSecurity: SocialSecurity[],
  inflationRate: number,
  medianReturn: number,
  effectiveTaxRate: number,
): number {
  let threshold = 0
  for (let age = retirementAge; age < maxAge; age++) {
    const ssIncome = getAnnualSSIncome(age, socialSecurity, inflationRate, currentAge)
    const spend = Math.max(0, getAnnualSpend(age, spendingPhases, inflationRate, currentAge)
      + getLumpSumSpend(age, spendingPhases, inflationRate, currentAge) - ssIncome)
    const discountYears = age - retirementAge
    threshold += spend / (1 - effectiveTaxRate) / Math.pow(1 + medianReturn, discountYears)
  }
  return threshold
}

// Smallest t (years of additional contributions) such that projected balance at
// retirementAge >= threshold. Returns null if t=0 already satisfies (already ready)
// or if threshold is unreachable within retirementAge - currentAge years.
function computeYearsToRetirement(
  currentBalance: number,
  annualContribution: number,
  medianReturn: number,
  yearsToRetirementAge: number,
  retirementThreshold: number,
): number | null {
  for (let t = 0; t <= yearsToRetirementAge; t++) {
    // Phase 1: t years of contributions growing at median return
    let balance = currentBalance
    for (let i = 0; i < t; i++) {
      balance = balance * (1 + medianReturn) + annualContribution
    }
    // Phase 2: remaining years growing with no contributions
    balance *= Math.pow(1 + medianReturn, yearsToRetirementAge - t)

    if (balance >= retirementThreshold) {
      return t === 0 ? null : t
    }
  }
  return null
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function computeHoldingWeights(
  holdings: Pick<Holding, 'holding_type' | 'value_usd'>[],
): AssetClassWeights {
  const totalValue = holdings.reduce((s, h) => s + (h.value_usd > 0 ? h.value_usd : 0), 0)
  if (totalValue === 0) return { blended: 1 }

  const weights: Partial<Record<AssetClass, number>> = {}
  for (const h of holdings) {
    if (h.value_usd <= 0) continue
    const cls = holdingTypeToAssetClass(h.holding_type)
    weights[cls] = (weights[cls] ?? 0) + h.value_usd / totalValue
  }
  return weights
}

export function runMonteCarlo(params: RetirementParams): MonteCarloResult {
  const assetParams = resolveAssetParams(params.returnRates)
  const {
    currentAge, retirementAge, maxAge,
    taxableBalance, retirementBalance,
    monthlyContribution, holdingWeights, socialSecurity = [], inflationRate,
    effectiveTaxRate, spendingPhases, simCount,
    postRetirementEquityPct,
  } = params
  if (![currentAge, retirementAge, maxAge, simCount].every(Number.isInteger) ||
      currentAge < 0 || retirementAge < currentAge || maxAge <= retirementAge || maxAge > 150 || simCount <= 0 ||
      ![taxableBalance, retirementBalance, monthlyContribution, inflationRate, effectiveTaxRate].every(Number.isFinite) ||
      Math.min(taxableBalance, retirementBalance, monthlyContribution) < 0 || effectiveTaxRate < 0 || effectiveTaxRate >= 1 ||
      (postRetirementEquityPct !== undefined && !(postRetirementEquityPct >= 0 && postRetirementEquityPct <= 1))) {
    throw new RangeError('Invalid retirement simulation inputs')
  }
  const customAssets = (params.customAssets ?? []).filter(a => a.availableForSpending)
  // gross-up factor: spending $X requires withdrawing $X / (1 - taxRate) from portfolio
  const taxGrossUp = 1 / (1 - effectiveTaxRate)

  const simulationPhases = spendingPhases.filter(p => !p.isPlanned)
  const sortedPhases = [...simulationPhases].sort((a, b) => a.startAge - b.startAge)
  if (customAssets.some(a => ![a.value, a.mean, a.std].every(Number.isFinite) || a.value < 0 || a.std < 0 || a.mean <= -1) ||
      socialSecurity.some(s => !Number.isInteger(s.startAge) || !Number.isFinite(s.monthlyBenefit) || s.monthlyBenefit < 0) ||
      Object.entries(holdingWeights).some(([cls, w]) => !(cls in ASSET_PARAMS) || !Number.isFinite(w) || (w ?? 0) < 0) ||
      sortedPhases.some((p, i) => !Number.isInteger(p.startAge) || !Number.isInteger(p.endAge) || p.endAge <= p.startAge ||
        (i > 0 && p.startAge < sortedPhases[i - 1].endAge) ||
        !Number.isFinite(p.excessInflationRate ?? 0) || (p.excessInflationRate ?? 0) <= -1 ||
        p.items.some(item => item.isLumpSum
          ? !Number.isInteger(item.lumpSumAge) || !Number.isFinite(item.lumpSumAmount) || (item.lumpSumAmount ?? 0) < 0
          : !Number.isFinite(item.monthlySpend) || item.monthlySpend < 0))) {
    throw new RangeError('Invalid asset or spending assumptions')
  }

  const totalYears = maxAge - currentAge
  const ages = Array.from({ length: totalYears + 1 }, (_, i) => currentAge + i)

  // Custom assets added to taxable balance
  const customTotal = customAssets.reduce((s, a) => s + a.value, 0)
  const totalTaxable = taxableBalance + customTotal

  // Inflation adjustment: ASSET_PARAMS assume 2.5% baseline inflation.
  // If user sets a different rate, real returns shift by the difference.
  const BASELINE_INFLATION = 0.025
  const inflationAdj = -(inflationRate - BASELINE_INFLATION)

  // Pre-retirement: blended mean used only for threshold/yearsToRetirement computation
  const { mean: blendedMeanBase } = computeBlendedParams(holdingWeights, taxableBalance + retirementBalance, customAssets, assetParams)
  const blendedMean = blendedMeanBase + inflationAdj

  // Post-retirement: user-specified equity/bond mix (default 60/40)
  const eqPct = postRetirementEquityPct ?? 0.6
  const bdPct = 1 - eqPct
  const postMean = eqPct * assetParams.equity.mean + bdPct * assetParams.bond.mean + inflationAdj
  if (blendedMean <= -1 || postMean <= -1) {
    throw new RangeError('Inflation-adjusted mean returns must be greater than -100%')
  }

  // Discount post-retirement spending at post-retirement mean for threshold
  const retirementThreshold = computeRetirementThreshold(
    currentAge, retirementAge, maxAge, simulationPhases, socialSecurity, inflationRate, postMean, effectiveTaxRate,
  )

  type SimRecord = {
    yearValues: number[]
    depleted: boolean
    earlyWithdrawal: boolean
    finalValue: number
  }

  const sims: SimRecord[] = []

  for (let s = 0; s < simCount; s++) {
    let taxable = totalTaxable
    let retirement = retirementBalance
    // yearValues[0] = initial balance; yearValues[i+1] = balance at end of year i
    const yearValues: number[] = [taxable + retirement]
    let depleted = false
    let earlyWithdrawal = false

    for (let i = 0; i < totalYears; i++) {
      const age = currentAge + i  // age at START of this year

      // Fixed-budget success means every planned payment can be funded; no
      // undisclosed 20–40% spending cuts are applied on adverse paths.
      const random = seededRandom((params.seed ?? 20261017) ^ Math.imul(s + 1, 0x9E3779B1) ^ Math.imul(age, 0x85EBCA6B))
      if (!depleted) {
        const ssIncome = age >= retirementAge ? getAnnualSSIncome(age, socialSecurity, inflationRate, currentAge) : 0
        const recurring = age >= retirementAge ? getAnnualSpend(age, simulationPhases, inflationRate, currentAge) : 0
        const withdrawal = Math.max(0, recurring + getLumpSumSpend(age, simulationPhases, inflationRate, currentAge) - ssIncome) * taxGrossUp
        if (age < 60 && withdrawal > taxable && retirement > 0) earlyWithdrawal = true
        if (withdrawal > taxable + retirement) {
          depleted = true
          taxable = 0
          retirement = 0
        } else if (age < 60) {
          const fromTaxable = Math.min(taxable, withdrawal)
          taxable -= fromTaxable
          retirement -= withdrawal - fromTaxable
        } else if (withdrawal > 0) {
          const ratio = (taxable + retirement - withdrawal) / (taxable + retirement)
          taxable *= ratio
          retirement *= ratio
        }
      }

      if (!depleted) {
        const customTotal = customAssets.reduce((s, a) => s + a.value, 0)
        let annualReturn: number
        if (age >= retirementAge) {
          // Post-retirement: equity/bond blend via bootstrap
          annualReturn = bootstrapBlendReturn(eqPct, bdPct, inflationAdj, random, assetParams)
        } else {
          // Pre-retirement: bootstrap per asset class with equity correlation
          annualReturn = bootstrapPortfolioReturn(
            holdingWeights, customAssets,
            taxableBalance + retirementBalance, customTotal,
            inflationAdj, random, assetParams,
          )
        }
        taxable = Math.max(0, taxable * (1 + annualReturn))
        retirement = Math.max(0, retirement * (1 + annualReturn))
      }

      if (age < retirementAge && !depleted) {
        // End-of-year contribution during accumulation
        taxable += monthlyContribution * 12
      }

      yearValues.push(taxable + retirement)
    }

    sims.push({
      yearValues,
      depleted,
      earlyWithdrawal,
      finalValue: yearValues[yearValues.length - 1],
    })
  }

  // Percentiles at each year index
  const p10: number[] = []
  const p50: number[] = []
  const p90: number[] = []

  for (let i = 0; i <= totalYears; i++) {
    const vals = sims.map(sim => sim.yearValues[i]).sort((a, b) => a - b)
    p10.push(percentile(vals, 0.1))
    p50.push(percentile(vals, 0.5))
    p90.push(percentile(vals, 0.9))
  }

  const successRate = sims.filter(s => !s.depleted).length / simCount

  const retirementIdx = retirementAge - currentAge
  const p50AtRetirement = p50[retirementIdx] ?? 0
  const medianGapToRetirement = Math.max(0, retirementThreshold - p50AtRetirement)

  const yearsToRetirement = computeYearsToRetirement(
    totalTaxable + retirementBalance,
    monthlyContribution * 12,
    blendedMean,           // accumulation uses pre-retirement portfolio return
    retirementAge - currentAge,
    retirementThreshold,
  )

  return {
    p10, p50, p90, ages,
    successRate,
    earlyWithdrawalRate: sims.filter(s => s.earlyWithdrawal).length / simCount,
    medianGapToRetirement,
    yearsToRetirement,
  }
}

// ─── Planning functions ───────────────────────────────────────────────────────

// PV today of covering a planned phase from a safe account (CD/short bonds).
// Each year's nominal spend is discounted at safeRate, not blendedMean.
export function computePlanningRequired(
  phase: SpendingPhase,
  params: Pick<RetirementParams, 'currentAge' | 'inflationRate' | 'effectiveTaxRate'>,
  safeRate = 0.03,
): number {
  const { currentAge, effectiveTaxRate } = params
  const excess = phase.excessInflationRate ?? 0
  const taxGrossUp = 1 / (1 - effectiveTaxRate)
  let pv = 0
  for (let year = phase.startAge; year < phase.endAge; year++) {
    const yearsFromNow = year - currentAge
    const realAnnual = phaseMonthlyTotal(phase) * 12 * Math.pow(1 + excess, yearsFromNow)
    pv += realAnnual * taxGrossUp / Math.pow(1 + safeRate, yearsFromNow)
  }
  return pv
}

// Deterministic bridge gap check: does projected taxable balance at retirement
// cover all unplanned spending before age 60?
export function checkBridgeGap(
  params: RetirementParams,
  unplannedPhases: SpendingPhase[],
): BridgeGapResult {
  const {
    currentAge, retirementAge,
    taxableBalance, monthlyContribution,
    holdingWeights, inflationRate, effectiveTaxRate,
  } = params
  const taxGrossUp = 1 / (1 - effectiveTaxRate)
  const { mean: blendedMeanBase } = computeBlendedParams(holdingWeights, taxableBalance + (params.retirementBalance ?? 0), [], resolveAssetParams(params.returnRates))
  const blendedMean = blendedMeanBase - (inflationRate - 0.025)
  const n = retirementAge - currentAge

  // End-of-period annuity: taxable grows for n years with annual contributions
  const growth = Math.pow(1 + blendedMean, n)
  const contributions = blendedMean === 0
    ? monthlyContribution * 12 * n
    : monthlyContribution * 12 * (growth - 1) / blendedMean
  const taxableAtRetirement = taxableBalance * growth + contributions

  // Rough bridge budget in the same real-dollar units as projected balances.
  // No investment growth during this bridge is assumed.
  let pre60Cost = 0
  const phases = unplannedPhases.filter(p => !p.isPlanned)
  for (let age = Math.max(currentAge, retirementAge); age < Math.min(60, params.maxAge); age++) {
    const spending = getAnnualSpend(age, phases, inflationRate, currentAge)
      + getLumpSumSpend(age, phases, inflationRate, currentAge)
    const income = getAnnualSSIncome(age, params.socialSecurity ?? [], inflationRate, currentAge)
    pre60Cost += Math.max(0, spending - income) * taxGrossUp
  }

  const shortfall = Math.max(0, pre60Cost - taxableAtRetirement)
  return {
    ok: taxableAtRetirement >= pre60Cost,
    taxableAtRetirement,
    pre60Cost,
    shortfall,
  }
}
