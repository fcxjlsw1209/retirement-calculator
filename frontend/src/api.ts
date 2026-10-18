// API client — talks to FastAPI backend at /api/*
// VITE_API_BASE: set to backend URL (e.g. http://GCP_IP:8000/api) for production.
// Unset during local dev — Vite proxy handles /api/* → http://127.0.0.1:8000.

const BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'
const CACHE_PREFIX = 'retirement-calculator:api:'

const TTL = {
  portfolio: 60_000,
  history: 5 * 60_000,
  attribution: 5 * 60_000,
  marketPulse: 30 * 60_000,
}

export interface SourceStatus {
  status: 'ok' | 'error' | 'auth_required' | 'pending'
  synced_at?: string
  last_ok?: string
  error?: string
  rows?: number
}

export interface Holding {
  ticker?: string
  asset_class: string
  holding_type: string
  name?: string
  value_usd: number
  shares?: number
  market_price?: number | null
  market_value_usd?: number | null
  market_date?: string | null
  gain_usd?: number
  gain_pct?: number
  source: string
  account_name?: string
  account_type?: string
}

export interface AssetClassSummary {
  value_usd: number
  weight: number
}

export interface AccountSummary {
  source: string
  firm_name?: string
  account_name?: string
  account_type?: string
  total_value_usd: number
  last_refreshed?: string
}

export interface Portfolio {
  total_value_usd: number
  last_synced?: string
  sources: Record<string, SourceStatus>
  holdings: Holding[]
  asset_class_summary: Record<string, AssetClassSummary>
  accounts: AccountSummary[]
  warnings: string[]
}

export interface Attribution {
  text?: string
  period_start?: string
  period_end?: string
  generated_at?: string
}

export interface SyncResult {
  reauth_required: boolean
  sources: Record<string, SourceStatus>
}

export interface CashFlow {
  id: number
  account_name: string
  date: string        // ISO date string "YYYY-MM-DD"
  amount_usd: number  // positive = money in, negative = money out
  note?: string
  created_at: string
}

export interface SyncLogEntry {
  id: number
  synced_at: string       // ISO datetime string
  source: string
  holdings_count: number
  total_value_usd: number
  status: 'ok' | 'warning'
  warnings: string[]
}

export interface SnapshotPoint {
  date: string   // YYYY-MM-DD
  value: number
}

export interface CashFlowPoint {
  date: string   // YYYY-MM-DD
  amount: number
  note?: string
}

export interface AccountHistory {
  source: string
  account_name: string
  firm_name?: string
  account_type?: string
  snapshots: SnapshotPoint[]
  cash_flows: CashFlowPoint[]
}

export interface PortfolioHistory {
  accounts: AccountHistory[]
}

export interface MarketSignals {
  vix?: number
  vxn?: number
  fg?: number
  rsi_sp500?: number
  vix_delta?: number
  vxn_delta?: number
  fg_delta?: number
  rsi_delta?: number
  delta_days?: number
}

export interface PricePoint {
  date: string   // YYYY-MM-DD
  sp500: number
  ndx: number
}

export interface Confluence {
  override: boolean
  recommendation: string   // '加大定投' | '常规定投' | '谨慎追高'
  action: string
  summary: string
  signal_labels: Record<string, string>
  regimes: Record<string, string>
  reasons: string[]
  counterfactuals: Array<{
    target: string
    missing: string[]
  }>
}

export interface PersonalizedNotice {
  ticker?: string
  name?: string
  weight_pct: number
  signal: string           // 'vix' | 'vxn'
  signal_value: number
  signal_direction: string // 'opportunity' | 'normal' | 'caution'
  message: string
  unmapped: boolean
  guidance_bucket: string  // 'priority' | 'defer' | 'maintain' | 'neutral'
}

export interface RetirementScenario {
  id: number
  name: string
  current_age: number
  retirement_age: number
  max_age: number
  monthly_contribution: number
  phases_json: string
  withdrawal_tax_rate: number
  post_retirement_equity_pct?: number
  created_at: string
  updated_at: string
}

export interface RetirementScenarioIn {
  name: string
  current_age: number
  retirement_age: number
  max_age: number
  monthly_contribution: number
  phases_json: string
  withdrawal_tax_rate: number
  post_retirement_equity_pct?: number
}

export interface MarketPulse {
  signals: MarketSignals
  price_history: PricePoint[]
  confluence: Confluence
  notices: PersonalizedNotice[]
  market_date?: string
  fetched_at?: string
  stale: boolean
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const r = await fetch(`${BASE}${path}`, options)
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }))
    throw new Error(err.detail || `HTTP ${r.status}`)
  }
  if (r.status === 204) return undefined as T
  return r.json()
}

interface CacheEntry<T> {
  ts: number
  value: T
}

function cacheKey(path: string): string {
  return `${CACHE_PREFIX}${BASE}${path}`
}

function readCache<T>(path: string, ttlMs: number): T | null {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(cacheKey(path))
    if (!raw) return null
    const entry = JSON.parse(raw) as CacheEntry<T>
    if (!entry || Date.now() - entry.ts > ttlMs) {
      sessionStorage.removeItem(cacheKey(path))
      return null
    }
    return entry.value
  } catch {
    sessionStorage.removeItem(cacheKey(path))
    return null
  }
}

function writeCache<T>(path: string, value: T): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.setItem(cacheKey(path), JSON.stringify({ ts: Date.now(), value }))
  } catch {
    // Cache is a convenience only; quota/private-mode failures should not affect data loading.
  }
}

async function cachedRequest<T>(path: string, ttlMs: number): Promise<T> {
  const cached = readCache<T>(path, ttlMs)
  if (cached !== null) return cached
  const value = await request<T>(path)
  writeCache(path, value)
  return value
}

function clearReadCache(): void {
  if (typeof sessionStorage === 'undefined') return
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i)
    if (key?.startsWith(CACHE_PREFIX)) sessionStorage.removeItem(key)
  }
}

function clearCacheMatching(fragment: string): void {
  if (typeof sessionStorage === 'undefined') return
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const key = sessionStorage.key(i)
    if (key?.startsWith(CACHE_PREFIX) && key.includes(fragment)) {
      sessionStorage.removeItem(key)
    }
  }
}

async function cachedMarketPulse(): Promise<MarketPulse> {
  const path = '/market-pulse'
  const cached = readCache<MarketPulse>(path, TTL.marketPulse)
  if (cached !== null && !cached.stale) return cached

  if (cached?.stale) clearCacheMatching(path)

  const value = await request<MarketPulse>(path)
  if (!value.stale) writeCache(path, value)
  return value
}

export const api = {
  sync: async () => {
    const result = await request<SyncResult>('/sync', { method: 'POST' })
    clearReadCache()
    return result
  },
  priceRefresh: async () => {
    const result = await request<{ status: string; prices_updated: number; prices_skipped: number; detail?: string }>('/price-refresh', { method: 'POST' })
    if (result.status !== 'ok') throw new Error(result.detail ?? '行情刷新失败')
    clearReadCache()
    return result
  },
  portfolio: {
    get: () => cachedRequest<Portfolio>('/portfolio', TTL.portfolio),
    history: (from?: string, to?: string) => {
      const params = new URLSearchParams()
      if (from) params.set('from', from)
      if (to) params.set('to', to)
      const q = params.toString()
      return cachedRequest<PortfolioHistory>(`/portfolio/history${q ? '?' + q : ''}`, TTL.history)
    },
  },
  attribution: () => cachedRequest<Attribution>('/attribution', TTL.attribution),
  authStart: () => request<{ status: string; message: string }>('/auth/start', { method: 'POST' }),
  authOtp: (code: string) =>
    request<{ status: string }>('/auth/otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }),
  uploadMsStatement: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<{ status: string; holdings_imported: number; total_value_usd: number }>(
      '/upload/ms-statement',
      { method: 'POST', body: form },
    ).then(result => {
      clearReadCache()
      return result
    })
  },
  syncLogs: () => request<SyncLogEntry[]>('/sync-logs'),
  marketPulse: cachedMarketPulse,
  cashFlows: {
    list: (account_name: string) =>
      request<CashFlow[]>(`/cash-flows?account_name=${encodeURIComponent(account_name)}`),
    add: (body: { account_name: string; date: string; amount_usd: number; note?: string }) =>
      request<CashFlow>('/cash-flows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(result => {
        clearCacheMatching('/portfolio/history')
        return result
      }),
    delete: (id: number) =>
      request<{ status: string }>(`/cash-flows/${id}`, { method: 'DELETE' }).then(result => {
        clearCacheMatching('/portfolio/history')
        return result
      }),
  },
  retirement: {
    accountTags: {
      get: () =>
        request<{ tags: Record<string, boolean> }>('/retirement/account-tags').then(r => r.tags),
      set: (tags: Record<string, boolean>) =>
        request<{ tags: Record<string, boolean> }>('/retirement/account-tags', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tags }),
        }).then(r => r.tags),
    },
    scenarios: {
      list: () => request<RetirementScenario[]>('/retirement/scenarios'),
      create: (body: RetirementScenarioIn) =>
        request<RetirementScenario>('/retirement/scenarios', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      update: (id: number, body: Partial<RetirementScenarioIn>) =>
        request<RetirementScenario>(`/retirement/scenarios/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      delete: (id: number) =>
        request<void>(`/retirement/scenarios/${id}`, { method: 'DELETE' }),
    },
  },
}
