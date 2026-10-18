import { useState, useEffect, useRef, useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts'
import { PortfolioHistory, api } from './api'
import { calcTWR, calcTWRFrom, mergeDailySnapshots, CashFlowEntry } from './twr'

type TimeRange = 'all' | '1y' | 'ytd' | '6m' | '1m'

const RANGE_LABELS: [TimeRange, string][] = [
  ['all', 'All'], ['1y', '1Y'], ['ytd', 'YTD'], ['6m', '6M'], ['1m', '1M'],
]

function toDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getFromDate(range: TimeRange): string | undefined {
  const t = new Date()
  if (range === 'all') return undefined
  if (range === '1y') return toDateStr(new Date(t.getFullYear() - 1, t.getMonth(), t.getDate()))
  if (range === 'ytd') return `${t.getFullYear()}-01-01`
  if (range === '6m') return toDateStr(new Date(t.getFullYear(), t.getMonth() - 6, t.getDate()))
  if (range === '1m') return toDateStr(new Date(t.getFullYear(), t.getMonth() - 1, t.getDate()))
}

function fmtPct(n: number): string {
  return (n >= 0 ? '+' : '') + (n * 100).toFixed(1) + '%'
}

function fmtUSD(n: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function fmtShortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function PerfNum({ label, value }: { label: string; value: number | null }) {
  const color = value === null ? '#6B6460' : value >= 0 ? '#C8A96E' : '#C06B5A'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      <span style={{ fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 500, fontFamily: "'JetBrains Mono', monospace", color }}>
        {value === null ? '—' : fmtPct(value)}
      </span>
    </div>
  )
}

interface FirmGroup {
  firmKey: string
  accounts: { account_name: string }[]
}

function groupByFirm(accounts: { account_name: string; firm_name?: string | null }[]): FirmGroup[] {
  const map = new Map<string, FirmGroup>()
  for (const acct of accounts) {
    const key = acct.firm_name ?? acct.account_name
    if (!map.has(key)) map.set(key, { firmKey: key, accounts: [] })
    map.get(key)!.accounts.push({ account_name: acct.account_name })
  }
  return Array.from(map.values())
}

export default function PerformanceChart({ hidden, revision }: { hidden: boolean; revision?: string | null }) {
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [historyData, setHistoryData] = useState<PortfolioHistory | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedAccounts, setSelectedAccounts] = useState<Set<string>>(new Set())
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [expandedFirms, setExpandedFirms] = useState<Set<string>>(new Set())
  const popoverRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let requestId = 0
    const load = () => {
      const currentRequest = ++requestId
      setLoading(true)
      api.portfolio.history()
        .then(data => {
          if (cancelled || currentRequest !== requestId) return
          setHistoryData(data)
          setSelectedAccounts(prev =>
            prev.size === 0
              ? new Set(data.accounts.map(a => a.account_name))
              : prev
          )
        })
        .catch(() => { if (!cancelled && currentRequest === requestId) setHistoryData(null) })
        .finally(() => { if (!cancelled && currentRequest === requestId) setLoading(false) })
    }
    load()
    window.addEventListener('portfolio-history-changed', load)
    return () => { cancelled = true; window.removeEventListener('portfolio-history-changed', load) }
  }, [revision])

  // Close popover on outside click
  useEffect(() => {
    if (!popoverOpen) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setPopoverOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [popoverOpen])

  const { mergedSnapshots, allCFs, twr, sinceDate, periodReturns } = useMemo(() => {
    if (!historyData || historyData.accounts.length === 0) {
      return { mergedSnapshots: [], allCFs: [], twr: null, sinceDate: null, periodReturns: { m1: null, ytd: null, y1: null } }
    }
    const selected = historyData.accounts.filter(a => selectedAccounts.has(a.account_name))
    const groups = selected.map(a => a.snapshots.map(s => ({ date: s.date, value: s.value })))
    const merged = mergeDailySnapshots(groups)
    const cfs: CashFlowEntry[] = selected.flatMap(a =>
      a.cash_flows.map(cf => ({ date: cf.date, amount: cf.amount, note: cf.note ?? undefined }))
    )
    const twr = calcTWR(merged, cfs)
    const sinceDate = merged.length > 0 ? merged[0].date : null
    const t = new Date()
    const periodReturns = {
      m1: calcTWRFrom(merged, cfs, toDateStr(new Date(t.getFullYear(), t.getMonth() - 1, t.getDate()))),
      ytd: calcTWRFrom(merged, cfs, `${t.getFullYear()}-01-01`),
      y1: calcTWRFrom(merged, cfs, toDateStr(new Date(t.getFullYear() - 1, t.getMonth(), t.getDate()))),
    }
    return { mergedSnapshots: merged, allCFs: cfs, twr, sinceDate, periodReturns }
  }, [historyData, selectedAccounts])

  const chartData = useMemo(() => {
    const fromDate = getFromDate(timeRange)
    return mergedSnapshots
      .filter(s => !fromDate || s.date >= fromDate)
      .map(s => ({
        ts: new Date(s.date + 'T00:00:00').getTime(),
        value: s.value,
      }))
  }, [mergedSnapshots, timeRange])

  const accounts = historyData?.accounts ?? []
  const firmGroups = useMemo(() => groupByFirm(accounts), [accounts])

  const totalAccounts = accounts.length
  const selectedCount = accounts.filter(a => selectedAccounts.has(a.account_name)).length
  const selectedFirmCount = firmGroups.filter(fg =>
    fg.accounts.some(a => selectedAccounts.has(a.account_name))
  ).length

  function firmSelectionState(fg: FirmGroup): 'all' | 'partial' | 'none' {
    const sel = fg.accounts.filter(a => selectedAccounts.has(a.account_name)).length
    if (sel === 0) return 'none'
    if (sel === fg.accounts.length) return 'all'
    return 'partial'
  }

  function toggleFirm(fg: FirmGroup) {
    const state = firmSelectionState(fg)
    setSelectedAccounts(prev => {
      const next = new Set(prev)
      if (state === 'all') {
        fg.accounts.forEach(a => next.delete(a.account_name))
      } else {
        fg.accounts.forEach(a => next.add(a.account_name))
      }
      return next
    })
  }

  function toggleAccount(name: string) {
    setSelectedAccounts(prev => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  function toggleExpandFirm(firmKey: string) {
    setExpandedFirms(prev => {
      const next = new Set(prev)
      if (next.has(firmKey)) next.delete(firmKey); else next.add(firmKey)
      return next
    })
  }

  const pillBtn = (active: boolean): React.CSSProperties => ({
    padding: '4px 12px', borderRadius: 5, border: 'none', cursor: 'pointer',
    fontSize: 12, fontWeight: 500, fontFamily: "'JetBrains Mono', monospace",
    background: active ? '#161616' : 'transparent',
    color: active ? '#E8E0D0' : '#6B6460',
    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
  })

  // Checkbox styles
  const checkboxStyle = (state: 'all' | 'partial' | 'none'): React.CSSProperties => ({
    width: 14, height: 14, borderRadius: 3, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer',
    background: state === 'all' ? '#C8A96E' : state === 'partial' ? 'rgba(200,169,110,0.2)' : '#161616',
    border: state === 'none' ? '1.5px solid #2A2826' : '1.5px solid #C8A96E',
    fontSize: 9, fontWeight: 700,
    color: state === 'all' ? '#0E0E0E' : '#C8A96E',
  })

  const acctCheckStyle = (checked: boolean): React.CSSProperties => ({
    width: 13, height: 13, borderRadius: 2, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer',
    background: checked ? '#C8A96E' : '#161616',
    border: checked ? '1.5px solid #C8A96E' : '1.5px solid #2A2826',
    fontSize: 8, fontWeight: 700, color: '#0E0E0E',
  })

  if (hidden) return <p style={{ color: '#6B6460', fontSize: 12 }}>金额已隐藏，资产历史图与现金流已收起。</p>

  return (
    <div style={{ marginBottom: 24 }}>
      <p style={{ color: '#6B6460', fontSize: 12, lineHeight: 1.6 }}>
        估算时间加权收益：按共同快照日期计算，现金流区间使用 Modified Dietz；缺少可靠期初估值时显示 —。下图为资产余额，包含出入金。
      </p>
      {/* Performance number row */}
      <div style={{ display: 'flex', gap: 28, marginBottom: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <PerfNum label={sinceDate ? `Since ${fmtShortDate(sinceDate)}` : 'Since Start'} value={twr} />
        <PerfNum label="1M" value={periodReturns.m1} />
        <PerfNum label="YTD" value={periodReturns.ytd} />
        <PerfNum label="1Y" value={periodReturns.y1} />
      </div>

      {/* Time range selector */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 12, background: '#1F1F1F', borderRadius: 7, padding: 3, width: 'fit-content' }}>
        {RANGE_LABELS.map(([v, label]) => (
          <button key={v} onClick={() => setTimeRange(v)} style={pillBtn(timeRange === v)}>
            {label}
          </button>
        ))}
      </div>

      {/* Chart */}
      {loading ? (
        <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B6460', fontSize: 13 }}>
          加载中…
        </div>
      ) : chartData.length === 0 ? (
        <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B6460', fontSize: 13 }}>
          暂无数据
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 24, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2A2826" />
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(ts: number) => fmtShortDate(toDateStr(new Date(ts)))}
              tickCount={6}
              tick={{ fontSize: 11, fill: '#6B6460' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => `$${Math.round(v / 1000)}k`}
              tick={{ fontSize: 11, fill: '#6B6460' }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              formatter={(value: any) => [typeof value === 'number' ? fmtUSD(value) : String(value), '总值']}
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              labelFormatter={(ts: any) => typeof ts === 'number' ? new Date(ts).toLocaleDateString('zh-CN') : String(ts)}
              contentStyle={{ fontSize: 12, borderRadius: 6, background: '#161616', border: '1px solid #2A2826', color: '#E8E0D0' }}
            />
            <Line
              type="monotone"
              dataKey="value"
              stroke="#C8A96E"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            {Array.from(
              allCFs.reduce((map, cf) => {
                map.set(cf.date, (map.get(cf.date) ?? 0) + cf.amount)
                return map
              }, new Map<string, number>())
            ).map(([date, amount]) => {
              const ts = new Date(date + 'T00:00:00').getTime()
              const isIn = amount >= 0
              const color = isIn ? '#C8A96E' : '#C06B5A'
              const sign = isIn ? '+' : ''
              const absK = Math.abs(amount)
              const amtLabel = absK >= 1000
                ? `${sign}$${Math.round(absK / 1000)}k`
                : `${sign}$${Math.round(absK)}`
              return (
                <ReferenceLine
                  key={date}
                  x={ts}
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="4 2"
                  label={{ value: amtLabel, position: 'top', fontSize: 9, fill: color, fontFamily: "'JetBrains Mono', monospace" }}
                />
              )
            })}
          </LineChart>
        </ResponsiveContainer>
      )}

      {/* Account filter */}
      {accounts.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }} ref={popoverRef}>
          {/* Trigger button */}
          <button
            onClick={() => setPopoverOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 12px', borderRadius: 7,
              border: `1px solid ${popoverOpen ? '#C8A96E' : '#2A2826'}`,
              background: '#161616', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: '#E8E0D0',
              boxShadow: popoverOpen ? '0 0 0 2px rgba(200,169,110,0.2)' : 'none',
            }}
          >
            <span>账户筛选</span>
            {selectedFirmCount > 0 && (
              <span style={{ background: '#C8A96E', color: '#0E0E0E', borderRadius: 9, fontSize: 10, fontWeight: 700, padding: '1px 6px' }}>
                {selectedFirmCount}
              </span>
            )}
            <span style={{ fontSize: 9, color: '#9ca3af', transform: popoverOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▼</span>
          </button>

          {/* Summary text */}
          <span style={{ fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace" }}>
            {selectedCount === totalAccounts
              ? <span>全部 <b style={{ color: '#E8E0D0' }}>{totalAccounts}</b> 个账户</span>
              : <span>已选 <b style={{ color: '#E8E0D0' }}>{selectedCount}</b> / {totalAccounts}</span>
            }
          </span>

          {/* Popover */}
          {popoverOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 200,
              background: '#161616', border: '1px solid #2A2826', borderRadius: 8,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)', width: 300, overflow: 'hidden',
            }}>
              {/* Header */}
              <div style={{ padding: '8px 14px', borderBottom: '1px solid #2A2826', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 10, fontWeight: 500, color: '#6B6460', textTransform: 'uppercase', letterSpacing: '0.1em', fontFamily: "'JetBrains Mono', monospace" }}>选择账户</span>
                <div style={{ display: 'flex', gap: 12 }}>
                  <button onClick={() => setSelectedAccounts(new Set(accounts.map(a => a.account_name)))}
                    style={{ fontSize: 11, color: '#C8A96E', background: 'none', border: 'none', cursor: 'pointer' }}>全选</button>
                  <button onClick={() => setSelectedAccounts(new Set())}
                    style={{ fontSize: 11, color: '#C8A96E', background: 'none', border: 'none', cursor: 'pointer' }}>全取消</button>
                </div>
              </div>

              {/* Firm list */}
              <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                {firmGroups.map(fg => {
                  const state = firmSelectionState(fg)
                  const expanded = expandedFirms.has(fg.firmKey)
                  const selCount = fg.accounts.filter(a => selectedAccounts.has(a.account_name)).length
                  return (
                    <div key={fg.firmKey} style={{ borderBottom: '1px solid #2A2826' }}>
                      {/* Firm row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px', cursor: 'pointer' }}
                        onClick={() => toggleFirm(fg)}>
                        <div style={checkboxStyle(state)}>
                          {state === 'all' && '✓'}
                          {state === 'partial' && '−'}
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: '#E8E0D0', flex: 1 }}>{fg.firmKey}</span>
                        <span style={{ fontSize: 10, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace" }}>{selCount}/{fg.accounts.length}</span>
                        {fg.accounts.length > 1 && (
                          <button
                            onClick={e => { e.stopPropagation(); toggleExpandFirm(fg.firmKey) }}
                            style={{ fontSize: 10, color: '#6B6460', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 4 }}
                          >
                            {expanded ? '▲' : '▼'}
                          </button>
                        )}
                      </div>
                      {/* Individual accounts */}
                      {expanded && (
                        <div style={{ padding: '0 14px 6px 36px' }}>
                          {fg.accounts.map(acct => {
                            const checked = selectedAccounts.has(acct.account_name)
                            return (
                              <div key={acct.account_name}
                                onClick={() => toggleAccount(acct.account_name)}
                                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', cursor: 'pointer' }}>
                                <div style={acctCheckStyle(checked)}>{checked && '✓'}</div>
                                <span style={{ fontSize: 11, color: '#E8E0D0' }}>{acct.account_name}</span>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Footer */}
              <div style={{ padding: '8px 14px', borderTop: '1px solid #2A2826', display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => setPopoverOpen(false)}
                  style={{ padding: '5px 14px', borderRadius: 5, background: '#C8A96E', color: '#0E0E0E', border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>
                  完成
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
