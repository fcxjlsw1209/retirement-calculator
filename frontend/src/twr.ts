export interface DailySnapshot {
  date: string  // YYYY-MM-DD
  value: number
}

export interface CashFlowEntry {
  date: string  // YYYY-MM-DD
  amount: number
  note?: string
}

export const MAX_EXACT_GAP_DAYS = 7

/**
 * Returns the number of calendar days between two YYYY-MM-DD strings (to - from).
 * Can be negative if to < from.
 */
export function daysBetween(from: string, to: string): number {
  const fromMs = new Date(from).getTime()
  const toMs = new Date(to).getTime()
  return (toMs - fromMs) / 86400000
}

/**
 * Modified Dietz return estimate for a sub-period.
 * Formula: (vEnd - vStart - cfSum) / (vStart + weightedCF)
 * where weightedCF = Σ(cf.amount × (daysBetween(cf.date, to) / daysBetween(from, to)))
 */
export function modifiedDietz(
  vStart: number,
  vEnd: number,
  cashFlows: CashFlowEntry[],
  from: string,
  to: string
): number | null {
  const totalDays = daysBetween(from, to)
  if (totalDays <= 0 || !Number.isFinite(totalDays)) return null
  if (![vStart, vEnd, ...cashFlows.map(cf => cf.amount)].every(Number.isFinite)) return null
  let cfSum = 0
  let weightedCF = 0
  for (const cf of cashFlows) {
    cfSum += cf.amount
    const weight = daysBetween(cf.date, to) / totalDays
    weightedCF += cf.amount * weight
  }
  const denominator = vStart + weightedCF
  if (denominator <= 0) return null
  const result = (vEnd - vStart - cfSum) / denominator
  return Number.isFinite(result) ? result : null
}

/**
 * Compute Time-Weighted Return from a series of daily snapshots and cash flows.
 * Returns null if fewer than 2 snapshots are provided.
 *
 * Snapshot convention: each snapshot is the end-of-day balance AFTER any same-day CFs.
 *
 * Each adjacent snapshot pair is one sub-period. If cash flows occurred after the
 * start snapshot and on/before the end snapshot, use Modified Dietz for that
 * sub-period so same-day market movement is preserved instead of being skipped.
 *
 * TWR = Π(1 + rᵢ) - 1
 */
export function calcTWR(
  snapshots: DailySnapshot[],
  cashFlows: CashFlowEntry[],
  options: { includeStartDateCashFlows?: boolean } = {}
): number | null {
  if (snapshots.length < 2) return null

  // Sort snapshots ASC
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date))
  if (sorted.some((s, i) => i > 0 && s.date === sorted[i - 1].date)) return null

  // Sort cash flows ASC
  const sortedCFs = [...cashFlows].sort((a, b) => a.date.localeCompare(b.date))

  // Compute product of (1 + rᵢ)
  let product = 1.0
  let cfIndex = 0

  for (let i = 1; i < sorted.length; i++) {
    const start = sorted[i - 1]
    const end = sorted[i]

    if (start.date === end.date) continue

    while (
      cfIndex < sortedCFs.length &&
      (
        sortedCFs[cfIndex].date < start.date ||
        (
          sortedCFs[cfIndex].date === start.date &&
          !(options.includeStartDateCashFlows && i === 1)
        )
      )
    ) {
      cfIndex++
    }

    const periodCFs: CashFlowEntry[] = []
    let j = cfIndex
    while (j < sortedCFs.length && sortedCFs[j].date <= end.date) {
      periodCFs.push(sortedCFs[j])
      j++
    }
    cfIndex = j

    const r = modifiedDietz(start.value, end.value, periodCFs, start.date, end.date)
    if (r === null || r < -1) return null
    product *= (1 + r)
  }

  return Number.isFinite(product) ? product - 1 : null
}

/**
 * Compute TWR for a sub-period starting on or after fromDate.
 * Filters both snapshots and cashFlows to [fromDate, ∞), then delegates to calcTWR.
 * Returns null if fewer than 2 snapshots remain after filtering.
 */
export function calcTWRFrom(
  snapshots: DailySnapshot[],
  cashFlows: CashFlowEntry[],
  fromDate: string
): number | null {
  if (snapshots.length === 0) return null

  // Sort snapshots ASC
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date))

  // Strict: if the earliest snapshot date is after fromDate, we don't have data
  // covering the period start — return null rather than silently shifting the window.
  if (sorted[0].date > fromDate) return null

  const snapsAfter = sorted.filter(s => s.date >= fromDate)
  let finalSnaps: DailySnapshot[] = []
  let insertedSyntheticStart = false

  if (snapsAfter.length > 0 && snapsAfter[0].date === fromDate) {
    finalSnaps = snapsAfter
  } else {
    // Exact fromDate snapshot is missing. Find the last snapshot before fromDate
    // and forward-fill it to fromDate as the start snapshot of our window.
    const snapsBefore = sorted.filter(s => s.date < fromDate)
    if (snapsBefore.length > 0) {
      const lastBefore = snapsBefore[snapsBefore.length - 1]
      // A stale balance or an unvalued deposit is not a valid period boundary.
      if (daysBetween(lastBefore.date, fromDate) > MAX_EXACT_GAP_DAYS ||
          cashFlows.some(cf => cf.date > lastBefore.date && cf.date < fromDate)) return null
      finalSnaps = [{ date: fromDate, value: lastBefore.value }, ...snapsAfter]
      insertedSyntheticStart = true
    } else {
      finalSnaps = snapsAfter
    }
  }

  if (finalSnaps.length < 2) return null
  const filteredCFs = cashFlows.filter(cf => cf.date >= fromDate)
  return calcTWR(finalSnaps, filteredCFs, {
    includeStartDateCashFlows: insertedSyntheticStart,
  })
}

/**
 * Merge daily snapshots from multiple accounts into a single combined series.
 *
 * Input: array of per-account snapshot arrays (each sorted ASC).
 * Rules:
 * - Same-date values are summed across accounts
 * - Only dates valued for every selected account are eligible.
 * - Never insert a new account as investment growth or combine stale valuations.
 */
export function mergeDailySnapshots(accountSnapshots: DailySnapshot[][]): DailySnapshot[] {
  if (accountSnapshots.length === 0 || accountSnapshots.some(a => a.length === 0)) return []
  const accounts = accountSnapshots.map(snapshots => new Map(snapshots.map(s => [s.date, s.value])))
  return [...accounts[0].keys()].sort()
    .filter(date => accounts.every(account => account.has(date)))
    .map(date => ({ date, value: accounts.reduce((sum, account) => sum + account.get(date)!, 0) }))
}
