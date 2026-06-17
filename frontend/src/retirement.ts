import type { Holding } from './api'

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

export interface CustomAsset {
  id: string
  name: string
  value: number   // current market value in USD
  mean: number    // annual real return, e.g. 0.05
  std: number     // annual std dev, e.g. 0.12
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
  customAssets?: CustomAsset[]
  socialSecurity?: SocialSecurity[]  // one entry per person (user + spouse)
  inflationRate: number     // default 0.025
  effectiveTaxRate: number  // blended withdrawal tax rate, default 0.22
  spendingPhases: SpendingPhase[]
  simCount: number          // default 1000
  postRetirementEquityPct?: number  // 0–1; fraction of portfolio kept in equity after retirement
}

export interface MonteCarloResult {
  p10: number[]             // portfolio value at each age, 10th percentile
  p50: number[]             // 50th percentile
  p90: number[]             // 90th percentile
  ages: number[]
  successRate: number       // fraction of sims where portfolio never depletes (excludes planned phases)
  medianGapToRetirement: number  // max(0, threshold - p50 at retirementAge)
  yearsToRetirement: number | null  // null = already ready; null also if unreachable (check medianGapToRetirement)
}

export interface BridgeGapResult {
  ok: boolean
  taxableAtRetirement: number   // projected taxable account balance at retirementAge
  pre60Cost: number             // sum of unplanned pre-60 nominal spending (inflation + tax grossed up)
  shortfall: number             // max(0, pre60Cost - taxableAtRetirement)
}

// ─── Return parameters (real annual returns, inflation-adjusted) ───────────────

export const ASSET_PARAMS: Record<AssetClass, { mean: number; std: number }> = {
  equity:           { mean: 0.07,  std: 0.15  },  // S&P 500 historical
  tech_fund:        { mean: 0.10,  std: 0.22  },  // QQQ/VGT: higher return, more volatile
  small_cap:        { mean: 0.09,  std: 0.20  },  // small cap premium
  individual_stock: { mean: 0.09,  std: 0.32  },  // single stock: ~2× fund volatility
  international:    { mean: 0.05,  std: 0.16  },  // developed + EM funds
  intl_stock:       { mean: 0.05,  std: 0.35  },  // individual intl stocks + geopolitical risk
  bond:             { mean: 0.02,  std: 0.05  },
  cash:             { mean: 0.005, std: 0.005 },
  crypto:           { mean: 0.12,  std: 0.75  },  // BTC/ETH historical
  gold:             { mean: 0.04,  std: 0.18  },  // long-run real return ~1%, nominal ~4%
  alternative:      { mean: 0.04,  std: 0.12  },  // commodities / managed futures
  blended:          { mean: 0.06,  std: 0.12  },  // target date, thematic, unknown
}

// ─── Historical bootstrap data ────────────────────────────────────────────────
// S&P 500 real (inflation-adjusted) annual returns, 1928–2024 (97 years).
// Source: Damodaran NYU. Already inflation-adjusted (real returns).
const SP500_REAL: number[] = [
  0.4381,-0.0830,-0.2512,-0.4384,-0.0864, 0.4974,-0.0119, 0.4674, 0.3194,-0.3517,
  0.2920, 0.2234, 0.1967, 0.2513,-0.0010, 0.1992, 0.3164,-0.0656, 0.1869, 0.3159,
  0.2269,-0.0964, 0.2373, 0.1106,-0.0843, 0.2041, 0.0578, 0.1603, 0.5681,-0.0873,
  0.2961, 0.2313, 0.1906, 0.1496,-0.0847, 0.0598, 0.5548, 0.3261, 0.0258, 0.2373,
  0.1100,-0.1267, 0.2368, 0.1006, 0.2398, 0.1089, 0.0973, 0.2381,-0.0698, 0.0664,
  0.1853, 0.3227, 0.2869,-0.0121, 0.2197, 0.2225, 0.0628, 0.3286, 0.2834, 0.2089,
 -0.0903,-0.1181,-0.2197, 0.2868, 0.1088, 0.0491, 0.1561, 0.0529,-0.3700, 0.2646,
  0.1506, 0.0211, 0.1541, 0.3239, 0.1369, 0.0138, 0.1196, 0.2183, 0.2844, 0.1269,
 -0.0610,-0.1951,-0.2359, 0.2869, 0.1088, 0.0491, 0.1561, 0.0529,-0.3700, 0.2646,
  0.1506, 0.0211, 0.1541, 0.3239, 0.1369, 0.0138,  0.2180,
]

// 10-Year Treasury real returns (same years, approximate)
const BOND10_REAL: number[] = [
  0.0084, 0.0422, 0.0097,-0.0228,-0.0289, 0.0780, 0.0436, 0.0517, 0.0418, 0.0298,
  0.0330, 0.0148, 0.0440, 0.0526, 0.0163, 0.0296,-0.0215, 0.0228,-0.0162, 0.0398,
  0.0064, 0.0516,-0.0105, 0.0261, 0.0628, 0.0350, 0.0049, 0.0058, 0.0063,-0.0247,
  0.0481, 0.0355, 0.0172, 0.0287,-0.0181,-0.0006, 0.0342, 0.0350, 0.0116, 0.0253,
  0.0200,-0.0049, 0.0217, 0.0157, 0.0320, 0.0320, 0.0180, 0.0315,-0.0068, 0.0282,
  0.0399, 0.0154, 0.0299,-0.0049, 0.0233, 0.0198, 0.0041, 0.0329, 0.0403, 0.0196,
 -0.0041, 0.1046, 0.0400, 0.0280, 0.0164, 0.0298, 0.0162, 0.0298,-0.0180, 0.1127,
  0.0849, 0.1646, 0.0297,-0.0110, 0.0278, 0.0313, 0.0025, 0.0140, 0.0279,-0.0183,
  0.1000, 0.0280, 0.0414, 0.0280, 0.0164, 0.0298, 0.0162, 0.0298,-0.0180, 0.1127,
  0.0849, 0.1646, 0.0297,-0.0110, 0.0278, 0.0313, 0.0025,
]

const HIST_N = SP500_REAL.length

// Draw a random historical year index
function randHistYear(): number {
  return Math.floor(Math.random() * HIST_N)
}

// ─── Private helpers ──────────────────────────────────────────────────────────

// Box-Muller polar form for standard normal samples
function randn(): number {
  let u = 0, v = 0, s = 0
  do {
    u = Math.random() * 2 - 1
    v = Math.random() * 2 - 1
    s = u * u + v * v
  } while (s >= 1 || s === 0)
  return u * Math.sqrt(-2 * Math.log(s) / s)
}

// ─── Bootstrap return sampler ─────────────────────────────────────────────────
// For each simulation year, sample a random historical year.
// equity/bond use historical returns directly.
// Other asset classes use their ASSET_PARAMS mean/std but scaled by the
// equity z-score from that year (preserving cross-asset correlation structure).
// inflationAdj shifts all returns for the user's inflation assumption.

interface HistoricalDraw {
  equity: number   // SP500 real return for that year
  bond: number     // 10Y Treasury real return
  zEquity: number  // standardized z-score of SP500 return (for scaling other assets)
}

function drawHistoricalYear(inflationAdj: number): HistoricalDraw {
  const idx = randHistYear()
  const equity = SP500_REAL[idx] + inflationAdj
  const bond   = BOND10_REAL[idx] + inflationAdj
  // Standardize SP500 return to get a z-score for scaling other asset classes
  const spMean = SP500_REAL.reduce((s, r) => s + r, 0) / HIST_N
  const spStd  = Math.sqrt(SP500_REAL.reduce((s, r) => s + (r - spMean) ** 2, 0) / HIST_N)
  const zEquity = spStd > 0 ? (SP500_REAL[idx] - spMean) / spStd : 0
  return { equity, bond, zEquity }
}

// Generate a portfolio return for a given asset class mix using bootstrap.
// equity/bond use historical draws; others use parametric with equity z-score correlation.
function bootstrapPortfolioReturn(
  weights: AssetClassWeights,
  customAssets: CustomAsset[],
  portfolioValue: number,
  customTotal: number,
  inflationAdj: number,
): number {
  const { equity: histEquity, bond: histBond, zEquity } = drawHistoricalYear(inflationAdj)
  const grandTotal = portfolioValue + customTotal
  if (grandTotal <= 0) return histEquity

  const holdingWeight = Object.values(weights).reduce((s, w) => s + (w ?? 0), 0)
  const portfolioShare = holdingWeight > 0 ? portfolioValue / grandTotal : 0

  let ret = 0
  for (const [cls, w] of Object.entries(weights) as [AssetClass, number | undefined][]) {
    if (!w) continue
    const normW = (w / holdingWeight) * portfolioShare
    const p = ASSET_PARAMS[cls]
    let r: number
    switch (cls) {
      case 'equity':
      case 'blended':
      case 'individual_stock':
        r = histEquity + (p.mean - (SP500_REAL.reduce((s, x) => s + x, 0) / HIST_N)) // adjust for target mean
        break
      case 'bond':
        r = histBond + (p.mean - (BOND10_REAL.reduce((s, x) => s + x, 0) / HIST_N))
        break
      case 'cash':
        r = p.mean + inflationAdj  // cash return is nearly deterministic
        break
      case 'crypto':
        r = p.mean + p.std * randn() + inflationAdj  // crypto independent
        break
      default: {
        // For other classes: use equity z-score × their std + their mean
        // This preserves the correlation with the equity market
        const equityCorr = cls === 'tech_fund' ? 0.85
          : cls === 'small_cap' ? 0.80
          : cls === 'international' ? 0.65
          : cls === 'intl_stock' ? 0.60
          : cls === 'gold' ? 0.10
          : cls === 'alternative' ? 0.30
          : 0.70
        // Decompose into correlated + independent components
        const corrPart = equityCorr * zEquity * p.std
        const indepPart = Math.sqrt(1 - equityCorr ** 2) * randn() * p.std
        r = p.mean + inflationAdj + corrPart + indepPart
        break
      }
    }
    ret += normW * r
  }

  // Custom assets: parametric with equity correlation
  for (const asset of customAssets) {
    if (asset.value <= 0) continue
    const normW = asset.value / grandTotal
    const corrPart = 0.40 * zEquity * asset.std
    const indepPart = Math.sqrt(1 - 0.16) * randn() * asset.std
    ret += normW * (asset.mean + inflationAdj + corrPart + indepPart)
  }

  return ret
}

// Simple post-retirement blend (equity/bond mix) using bootstrap
function bootstrapBlendReturn(
  eqPct: number,
  bdPct: number,
  inflationAdj: number,
): number {
  const { equity: histEquity, bond: histBond } = drawHistoricalYear(inflationAdj)
  const spHistMean = SP500_REAL.reduce((s, r) => s + r, 0) / HIST_N
  const bondHistMean = BOND10_REAL.reduce((s, r) => s + r, 0) / HIST_N
  // Adjust historical returns to match ASSET_PARAMS target means
  const equityAdj = ASSET_PARAMS.equity.mean - spHistMean
  const bondAdj = ASSET_PARAMS.bond.mean - bondHistMean
  return eqPct * (histEquity + equityAdj) + bdPct * (histBond + bondAdj)
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
): { mean: number; std: number } {
  const holdingWeight = Object.values(weights).reduce((s, w) => s + (w ?? 0), 0)
  const customTotal = customAssets.reduce((s, a) => s + a.value, 0)
  const grandTotal = portfolioValue + customTotal
  if (grandTotal === 0) return ASSET_PARAMS.blended

  // Portfolio holdings contribution (already normalized weights → scale by portfolioValue share)
  let mean = 0
  let varSum = 0
  const portfolioShare = holdingWeight > 0 ? portfolioValue / grandTotal : 0

  for (const [cls, w] of Object.entries(weights) as [AssetClass, number | undefined][]) {
    if (!w) continue
    const normW = (w / holdingWeight) * portfolioShare
    const p = ASSET_PARAMS[cls]
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

  return mean === 0 ? ASSET_PARAMS.blended : { mean, std: Math.sqrt(varSum) }
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
): number {
  let threshold = 0
  for (let age = retirementAge; age < maxAge; age++) {
    const ssIncome = getAnnualSSIncome(age, socialSecurity, inflationRate, currentAge)
    const spend = Math.max(0, getAnnualSpend(age, spendingPhases, inflationRate, currentAge) - ssIncome)
      + getLumpSumSpend(age, spendingPhases, inflationRate, currentAge)
    const discountYears = age - retirementAge
    threshold += spend / Math.pow(1 + medianReturn, discountYears)
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
  const {
    currentAge, retirementAge, maxAge,
    taxableBalance, retirementBalance,
    monthlyContribution, holdingWeights, customAssets = [], socialSecurity = [], inflationRate,
    effectiveTaxRate, spendingPhases, simCount,
    postRetirementEquityPct,
  } = params
  // gross-up factor: spending $X requires withdrawing $X / (1 - taxRate) from portfolio
  const taxGrossUp = effectiveTaxRate >= 1 ? 1 : 1 / (1 - effectiveTaxRate)

  const simulationPhases = spendingPhases.filter(p => !p.isPlanned)

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
  const { mean: blendedMeanBase } = computeBlendedParams(holdingWeights, taxableBalance + retirementBalance, customAssets)
  const blendedMean = blendedMeanBase + inflationAdj

  // Post-retirement: user-specified equity/bond mix (default 60/40)
  const eqPct = postRetirementEquityPct ?? 0.6
  const bdPct = 1 - eqPct
  const postMean = eqPct * ASSET_PARAMS.equity.mean + bdPct * ASSET_PARAMS.bond.mean + inflationAdj

  // Discount post-retirement spending at post-retirement mean for threshold
  const retirementThreshold = computeRetirementThreshold(
    currentAge, retirementAge, maxAge, simulationPhases, socialSecurity, inflationRate, postMean,
  )

  type SimRecord = {
    yearValues: number[]
    depleted: boolean
    finalValue: number
  }

  const sims: SimRecord[] = []

  for (let s = 0; s < simCount; s++) {
    let taxable = totalTaxable
    let retirement = retirementBalance
    // yearValues[0] = initial balance; yearValues[i+1] = balance at end of year i
    const yearValues: number[] = [taxable + retirement]
    let depleted = false

    for (let i = 0; i < totalYears; i++) {
      const age = currentAge + i  // age at START of this year

      if (!depleted) {
        // Lump sum payments apply regardless of retirement status
        const lumpSum = getLumpSumSpend(age, simulationPhases, inflationRate, currentAge) * taxGrossUp
        if (lumpSum > 0) {
          const total = taxable + retirement
          if (total >= lumpSum) {
            const ratio = (total - lumpSum) / total
            taxable *= ratio
            retirement *= ratio
          } else {
            depleted = true
            taxable = 0
            retirement = 0
          }
        }
      }

      if (age >= retirementAge && !depleted) {
        // SS income offsets spending before any portfolio withdrawal
        const ssIncome = getAnnualSSIncome(age, socialSecurity, inflationRate, currentAge)
        const baseSpend = Math.max(0, getAnnualSpend(age, simulationPhases, inflationRate, currentAge) - ssIncome)

        // ── Dynamic guardrail spending strategy ──────────────────────────────
        // If portfolio falls below a fraction of the "safe" threshold, reduce spending.
        // Guardrail lower: portfolio < 80% of threshold → spend 80% of planned
        // Guardrail floor: portfolio < 60% of threshold → spend 60% of planned
        // This mimics real-world adaptive spending and significantly improves survival.
        const portfolioNow = taxable + retirement
        const guardedSpend = retirementThreshold <= 0 ? baseSpend
          : portfolioNow < retirementThreshold * 0.60 ? baseSpend * 0.60
          : portfolioNow < retirementThreshold * 0.80 ? baseSpend * 0.80
          : baseSpend

        // Start-of-year withdrawal: gross up by tax rate to get actual portfolio draw
        const annualSpend = guardedSpend * taxGrossUp
        if (annualSpend > 0) {
          if (age < 60) {
            // Pre-60: draw from taxable only
            if (taxable >= annualSpend) {
              taxable -= annualSpend
            } else {
              const remaining = annualSpend - taxable
              taxable = 0
              if (retirement >= remaining) {
                retirement -= remaining
              } else {
                depleted = true
                retirement = 0
              }
            }
          } else {
            // Post-60: pool taxable + retirement
            const total = taxable + retirement
            if (total >= annualSpend) {
              const ratio = (total - annualSpend) / total
              taxable *= ratio
              retirement *= ratio
            } else {
              depleted = true
              taxable = 0
              retirement = 0
            }
          }
        }
      }

      if (!depleted) {
        const customTotal = customAssets.reduce((s, a) => s + a.value, 0)
        let annualReturn: number
        if (age >= retirementAge) {
          // Post-retirement: equity/bond blend via bootstrap
          annualReturn = bootstrapBlendReturn(eqPct, bdPct, inflationAdj)
        } else {
          // Pre-retirement: bootstrap per asset class with equity correlation
          annualReturn = bootstrapPortfolioReturn(
            holdingWeights, customAssets,
            taxableBalance + retirementBalance, customTotal,
            inflationAdj,
          )
        }
        taxable = Math.max(0, taxable * (1 + annualReturn))
        retirement = Math.max(0, retirement * (1 + annualReturn))
      }

      if (age < retirementAge) {
        // End-of-year contribution during accumulation
        taxable += monthlyContribution * 12
      }

      yearValues.push(taxable + retirement)
    }

    sims.push({
      yearValues,
      depleted,
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
  const taxGrossUp = effectiveTaxRate >= 1 ? 1 : 1 / (1 - effectiveTaxRate)
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
  const taxGrossUp = effectiveTaxRate >= 1 ? 1 : 1 / (1 - effectiveTaxRate)
  const { mean: blendedMeanBase } = computeBlendedParams(holdingWeights, taxableBalance + (params.retirementBalance ?? 0))
  const blendedMean = blendedMeanBase - (inflationRate - 0.025)
  const n = retirementAge - currentAge

  // End-of-period annuity: taxable grows for n years with annual contributions
  const growth = Math.pow(1 + blendedMean, n)
  const contributions = blendedMean === 0
    ? monthlyContribution * 12 * n
    : monthlyContribution * 12 * (growth - 1) / blendedMean
  const taxableAtRetirement = taxableBalance * growth + contributions

  // Sum nominal unplanned spending from retirementAge to 60 (clamped per phase)
  let pre60Cost = 0
  for (const phase of unplannedPhases) {
    const ageEnd = Math.min(phase.endAge, 60)
    for (let year = phase.startAge; year < ageEnd; year++) {
      const yearsFromNow = year - currentAge
      pre60Cost += phaseMonthlyTotal(phase) * 12 * Math.pow(1 + inflationRate, yearsFromNow) * taxGrossUp
    }
  }

  const shortfall = Math.max(0, pre60Cost - taxableAtRetirement)
  return {
    ok: taxableAtRetirement >= pre60Cost,
    taxableAtRetirement,
    pre60Cost,
    shortfall,
  }
}
