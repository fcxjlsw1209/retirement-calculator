import { useState, useEffect, useMemo } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { api, MarketPulse, PricePoint } from './api'

// ── Signal direction metadata ──────────────────────────────────────────────────

const DIRECTION_COLOR: Record<string, string> = {
  opportunity: '#C8A96E',
  panic:       '#C8A96E',
  normal:      '#6B6460',
  caution:     '#C06B5A',
}

const DIRECTION_LABEL: Record<string, string> = {
  opportunity: '机会',
  panic:       '极恐',
  normal:      '正常',
  caution:     '谨慎',
  mixed:       '分歧',
}

const RECOMMENDATION_COLOR: Record<string, string> = {
  '加大定投': '#C8A96E',
  '常规定投': '#E8E0D0',
  '谨慎追高': '#C06B5A',
}

const PLAYBOOK: Record<string, Record<string, string>> = {
  vix: {
    panic:       '市场进入极端恐慌区间，优先按计划分批执行，不一次性打满仓位。',
    opportunity: '恐慌加剧，可分批加仓宽基指数，按既定计划放大定投额度。',
    normal:      '市场波动平稳，按常规定投计划执行，无需调整节奏。',
    caution:     '波动极低，历史上往往是回调前兆；新增资金可分批而非一次性入场。',
  },
  vxn: {
    panic:       '科技股进入极端恐慌区间，可分批加仓科技类ETF，控制单次买入比例。',
    opportunity: '科技股波动上升，可适量加仓科技类ETF（QQQ/VGT等），注意分批。',
    normal:      '科技板块波动正常，按既定计划定投即可。',
    caution:     '科技股波动极低，过热迹象明显；避免追高，等待回调机会。',
  },
  fg: {
    opportunity: '市场情绪偏恐惧，历史上往往是中长期加仓机会，可适度增加定投。',
    normal:      '市场情绪中性，常规操作即可。',
    caution:     '市场情绪贪婪，追高风险上升；按计划定投，不追涨。',
  },
  rsi_sp500: {
    opportunity: '大盘动能偏弱（超卖区域），可关注分批加仓机会。',
    normal:      '大盘动能健康，维持正常定投节奏。',
    caution:     '大盘短期超买，注意追高风险；可等待回调后再加仓。',
  },
}

const SIGNAL_META: { key: string; label: string; invertDeltaColor?: boolean }[] = [
  { key: 'vix',       label: 'VIX', invertDeltaColor: true },
  { key: 'vxn',       label: 'VXN', invertDeltaColor: true },
  { key: 'fg',        label: 'F&G' },
  { key: 'rsi_sp500', label: 'RSI' },
]

interface ZoneItem {
  label: string
  range: string
  key: string
}

const ZONES_INFO: Record<string, ZoneItem[]> = {
  vix: [
    { label: '极度恐慌', range: '> 35', key: 'panic' },
    { label: '机会区间', range: '20 - 35', key: 'opportunity' },
    { label: '正常波动', range: '12 - 20', key: 'normal' },
    { label: '谨慎追高', range: '< 12', key: 'caution' },
  ],
  vxn: [
    { label: '极度恐慌', range: '> 45', key: 'panic' },
    { label: '机会区间', range: '22 - 45', key: 'opportunity' },
    { label: '正常波动', range: '15 - 22', key: 'normal' },
    { label: '谨慎追高', range: '< 15', key: 'caution' },
  ],
  fg: [
    { label: '谨慎追高', range: '> 55', key: 'caution' },
    { label: '中性区间', range: '45 - 55', key: 'normal' },
    { label: '机会区间', range: '< 45', key: 'opportunity' },
  ],
  rsi_sp500: [
    { label: '谨慎追高', range: '> 70', key: 'caution' },
    { label: '中性区间', range: '50 - 70', key: 'normal' },
    { label: '机会区间', range: '< 50', key: 'opportunity' },
  ],
}

function getActiveZoneKey(key: string, value: number | undefined): string | null {
  if (value === undefined || value === null) return null
  if (key === 'vix') {
    if (value > 35) return 'panic'
    if (value >= 20) return 'opportunity'
    if (value >= 12) return 'normal'
    return 'caution'
  }
  if (key === 'vxn') {
    if (value > 45) return 'panic'
    if (value >= 22) return 'opportunity'
    if (value >= 15) return 'normal'
    return 'caution'
  }
  if (key === 'fg') {
    if (value > 55) return 'caution'
    if (value >= 45) return 'normal'
    return 'opportunity'
  }
  if (key === 'rsi_sp500') {
    if (value > 70) return 'caution'
    if (value >= 50) return 'normal'
    return 'opportunity'
  }
  return null
}

// ── Helpers ────────────────────────────────────────────────────────────────────

type TimeRange = '5y' | '3y' | '1y' | 'ytd' | '6m' | '1m'
type ChartMode = 'price' | 'drawdown'

const RANGE_LABELS: [TimeRange, string][] = [
  ['5y', '5Y'], ['3y', '3Y'], ['1y', '1Y'], ['ytd', 'YTD'], ['6m', '6M'], ['1m', '1M'],
]

function toDateStr(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function getFromDate(range: TimeRange): string {
  const t = new Date()
  if (range === '5y') return toDateStr(new Date(t.getFullYear() - 5, t.getMonth(), t.getDate()))
  if (range === '3y') return toDateStr(new Date(t.getFullYear() - 3, t.getMonth(), t.getDate()))
  if (range === '1y') return toDateStr(new Date(t.getFullYear() - 1, t.getMonth(), t.getDate()))
  if (range === 'ytd') return `${t.getFullYear()}-01-01`
  if (range === '6m') return toDateStr(new Date(t.getFullYear(), t.getMonth() - 6, t.getDate()))
  return toDateStr(new Date(t.getFullYear(), t.getMonth() - 1, t.getDate()))
}

function filterPriceHistory<T extends { date: string }>(rows: T[], range: TimeRange): T[] {
  const from = getFromDate(range)
  return rows
    .filter(r => r.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function normalizePrices(rows: PricePoint[]): { date: string; sp500: number; ndx: number }[] {
  if (rows.length === 0) return []
  const base500 = rows[0].sp500
  const baseNdx = rows[0].ndx
  return rows.map(r => ({
    date: r.date,
    sp500: parseFloat(((r.sp500 / base500) * 100).toFixed(2)),
    ndx:   parseFloat(((r.ndx   / baseNdx)  * 100).toFixed(2)),
  }))
}

function calcDrawdowns(rows: PricePoint[]): { date: string; sp500: number; ndx: number }[] {
  let peak500 = 0
  let peakNdx = 0
  return rows.map(r => {
    peak500 = Math.max(peak500, r.sp500)
    peakNdx = Math.max(peakNdx, r.ndx)
    return {
      date: r.date,
      sp500: peak500 > 0 ? parseFloat((((r.sp500 / peak500) - 1) * 100).toFixed(2)) : 0,
      ndx: peakNdx > 0 ? parseFloat((((r.ndx / peakNdx) - 1) * 100).toFixed(2)) : 0,
    }
  })
}

function fmtShortDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return `${d.getFullYear().toString().slice(2)}/${String(d.getMonth() + 1).padStart(2, '0')}`
}

function fmtChartDate(dateStr: string, range: TimeRange): string {
  const d = new Date(dateStr + 'T00:00:00')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  if (range === '1m' || range === '6m' || range === 'ytd') return `${month}/${day}`
  return fmtShortDate(dateStr)
}

function fmtDelta(v: number | undefined, isInt: boolean): string {
  if (v === undefined || v === null) return ''
  const sign = v > 0 ? '+' : ''
  return isInt ? `${sign}${Math.round(v)}` : `${sign}${v.toFixed(1)}`
}

function deltaColor(delta: number, invert: boolean): string {
  if (Math.abs(delta) < 0.01) return '#6B6460'
  const opportunityMove = invert ? delta > 0 : delta < 0
  return opportunityMove ? '#C8A96E' : '#C06B5A'
}

function fmtPct(v: number | undefined): string {
  if (v === undefined || v === null) return '—'
  return `${v.toFixed(1)}%`
}

function fmtAxisPct(v: number): string {
  if (Math.abs(v) < 0.05) return '0%'
  return `${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`
}

function drawdownColor(v: number | undefined): string {
  if (v === undefined || v === null) return '#6B6460'
  if (v <= -10) return '#C8A96E'
  if (v <= -5) return '#E8E0D0'
  return '#6B6460'
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SignalCard({
  label, value, delta, deltaDays, invertDeltaColor, direction, playbook, isInt, zones, activeZoneKey, marketDate,
}: {
  label: string
  value: number | undefined
  delta: number | undefined
  deltaDays: number | undefined
  invertDeltaColor: boolean
  direction: string | undefined
  playbook: string | undefined
  isInt: boolean
  zones: ZoneItem[]
  activeZoneKey: string | null
  marketDate: string | undefined
}) {
  const [open, setOpen] = useState(false)
  const color = direction ? DIRECTION_COLOR[direction] : '#6B6460'
  const dirLabel = direction ? DIRECTION_LABEL[direction] : '—'

  return (
    <div style={{
      background: '#161616',
      border: '1px solid #2A2826',
      borderRadius: 8,
      padding: '16px',
      flex: 1,
      minWidth: 200,
      cursor: playbook ? 'pointer' : 'default',
      transition: 'border-color 0.1s',
    }}
      onClick={() => playbook && setOpen(o => !o)}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          color: '#6B6460',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}>{label}</span>
        <span style={{
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          color,
          background: color + '1A',
          borderRadius: 4,
          padding: '1px 6px',
        }}>{dirLabel}</span>
      </div>

      <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontSize: 26,
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 500,
          color: value !== undefined ? '#E8E0D0' : '#6B6460',
        }}>
          {value !== undefined ? (isInt ? Math.round(value) : value.toFixed(1)) : '—'}
        </span>
        {delta !== undefined && delta !== null && deltaDays !== undefined && deltaDays !== null && (
          <span style={{
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
            color: deltaColor(delta, invertDeltaColor),
          }}>
            {fmtDelta(delta, isInt)} vs {deltaDays}d
          </span>
        )}
      </div>

      {zones && (
        <div style={{
          marginTop: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          borderTop: '1px solid #2A2826',
          paddingTop: 10,
        }}>
          {zones.map(z => {
            const isActive = z.key === activeZoneKey
            const zoneColor = isActive
              ? (z.key === 'caution' ? '#C06B5A' : (z.key === 'opportunity' || z.key === 'panic' ? '#C8A96E' : '#E8E0D0'))
              : '#4A4340'
            const fontWeight = isActive ? 500 : 400

            return (
              <div
                key={z.key}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 10.5,
                  fontFamily: "'LXGW WenKai', sans-serif",
                  color: zoneColor,
                  fontWeight,
                }}
              >
                <span>{isActive ? '→ ' : '  '}{z.label}</span>
                <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>{z.range}</span>
              </div>
            )
          })}
        </div>
      )}

      {open && playbook && (
        <div style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: '1px solid #2A2826',
          fontSize: 12,
          fontFamily: "'LXGW WenKai', serif",
          color: '#E8E0D0',
          lineHeight: 1.7,
        }}>
          {playbook}
        </div>
      )}

      {playbook && !open && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace" }}>
          点击查看操作指引
        </div>
      )}

      <div style={{
        marginTop: 8,
        fontSize: 10.5,
        color: value !== undefined ? '#4A4340' : '#C06B5A',
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        {value !== undefined ? `截至 ${marketDate ?? '—'}` : '暂无数据'}
      </div>
    </div>
  )
}

function DecisionStrip({
  data, marketDate, stale,
}: {
  data: MarketPulse['confluence']
  marketDate: string | undefined
  stale: boolean
}) {
  const color = RECOMMENDATION_COLOR[data.recommendation] ?? '#E8E0D0'
  const signalDate = marketDate ?? '暂无数据'
  const freshness = stale ? '后台刷新中' : '已更新'
  const counterfactualCopy = formatCounterfactuals(data.counterfactuals)

  return (
    <div style={{
      background: '#161616',
      border: `1px solid ${color}40`,
      borderRadius: 8,
      padding: '18px 20px',
      marginBottom: 20,
    }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        gap: 16,
        alignItems: 'start',
      }}>
        <div>
          <div style={{
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            color: '#6B6460',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: 6,
          }}>市场通用节奏</div>
          <div style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            flexWrap: 'wrap',
          }}>
            <span style={{
              fontSize: 13,
              fontFamily: "'Space Grotesk', sans-serif",
              color: '#A89880',
            }}>今日节奏</span>
            <span style={{
              fontSize: 20,
              fontFamily: "'Space Grotesk', sans-serif",
              fontWeight: 600,
              color,
            }}>{data.action}</span>
          </div>
        </div>
        <div style={{
          justifySelf: 'end',
          fontSize: 11,
          fontFamily: "'JetBrains Mono', monospace",
          color: stale ? '#C06B5A' : '#6B6460',
          textAlign: 'right',
          lineHeight: 1.6,
        }}>
          <div>市场日期 {signalDate}</div>
          <div>{freshness}</div>
        </div>
      </div>

      <div style={{
        marginTop: 10,
        fontSize: 13,
        fontFamily: "'LXGW WenKai', serif",
        color: '#E8E0D0',
        lineHeight: 1.65,
      }}>
        宽基市场参考：{newMoneyCopy(data.recommendation)}具体加仓对象仍需遵守下方个人配置约束。
      </div>

      <div style={{
        marginTop: 4,
        fontSize: 13,
        fontFamily: "'LXGW WenKai', serif",
        color: '#A89880',
        lineHeight: 1.65,
      }}>
        原因：{data.summary}
      </div>

      {counterfactualCopy && (
        <div style={{
          marginTop: 4,
          fontSize: 12.5,
          fontFamily: "'LXGW WenKai', serif",
          color: '#6B6460',
          lineHeight: 1.65,
        }}>
          反事实：{counterfactualCopy}
        </div>
      )}
    </div>
  )
}

function formatCounterfactuals(counterfactuals: MarketPulse['confluence']['counterfactuals']): string {
  if (!counterfactuals?.length) {
    return ''
  }
  return counterfactuals
    .filter((item) => item.missing.length > 0)
    .map((item) => `未进入${item.target}，因为${item.missing.join('；')}`)
    .join('。')
}

function newMoneyCopy(recommendation: string): string {
  if (recommendation === '加大定投') {
    return '按计划加速分批投入，不一次性打满。'
  }
  if (recommendation === '谨慎追高') {
    return '降低投入速度，保留现金弹性，避免追入高波动资产。'
  }
  return '维持原节奏，不额外放大，也不因为噪音暂停。'
}

function PriceChart({ rows }: { rows: PricePoint[] }) {
  const [range, setRange] = useState<TimeRange>('5y')
  const [mode, setMode] = useState<ChartMode>('price')

  const data = useMemo(() => {
    const filtered = filterPriceHistory(rows, range)
    return mode === 'drawdown' ? calcDrawdowns(filtered) : normalizePrices(filtered)
  }, [rows, mode, range])

  const latest = data[data.length - 1]

  const tickInterval = Math.max(1, Math.floor(data.length / 6))
  const title = mode === 'drawdown' ? '回撤视图（距区间高点）' : '价格走势（标准化至 100）'

  return (
    <div style={{
      background: '#161616',
      border: '1px solid #2A2826',
      borderRadius: 8,
      padding: '16px 20px',
      marginBottom: 20,
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 12,
        marginBottom: 12,
        flexWrap: 'wrap',
      }}>
        <div>
          <span style={{
            fontSize: 13,
            fontFamily: "'Space Grotesk', sans-serif",
            fontWeight: 500,
            color: '#E8E0D0',
          }}>{title}</span>
          {mode === 'drawdown' && latest && (
            <div style={{
              display: 'flex',
              gap: 12,
              marginTop: 6,
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
            }}>
              <span style={{ color: drawdownColor(latest.sp500) }}>SP500 距高点 {fmtPct(latest.sp500)}</span>
              <span style={{ color: drawdownColor(latest.ndx) }}>NDX 距高点 {fmtPct(latest.ndx)}</span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {(['price', 'drawdown'] as ChartMode[]).map(m => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={{
                  background: mode === m ? '#2A2826' : 'none',
                  border: '1px solid',
                  borderColor: mode === m ? '#C8A96E' : '#2A2826',
                  borderRadius: 4,
                  color: mode === m ? '#C8A96E' : '#6B6460',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: "'JetBrains Mono', monospace",
                  padding: '3px 8px',
                  transition: 'color 0.1s, border-color 0.1s',
                }}
              >{m === 'price' ? '价格' : '回撤'}</button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {RANGE_LABELS.map(([r, label]) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                style={{
                  background: range === r ? '#2A2826' : 'none',
                  border: '1px solid',
                  borderColor: range === r ? '#C8A96E' : '#2A2826',
                  borderRadius: 4,
                  color: range === r ? '#C8A96E' : '#6B6460',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontFamily: "'JetBrains Mono', monospace",
                  padding: '3px 8px',
                  transition: 'color 0.1s, border-color 0.1s',
                }}
              >{label}</button>
            ))}
          </div>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 12, right: 18, left: -24, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2A2826" />
          {mode === 'drawdown' && (
            <ReferenceLine y={0} stroke="#4A4340" strokeWidth={1} strokeDasharray="3 3" />
          )}
          <XAxis
            dataKey="date"
            interval={tickInterval}
            tickFormatter={v => fmtChartDate(v, range)}
            tick={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", fill: '#6B6460' }}
            axisLine={{ stroke: '#2A2826' }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fontFamily: "'JetBrains Mono', monospace", fill: '#6B6460' }}
            axisLine={false}
            tickLine={false}
            tickFormatter={v => mode === 'drawdown' ? fmtAxisPct(v) : v.toFixed(0)}
            domain={mode === 'drawdown' ? ['auto', 0] : ['auto', 'auto']}
          />
          <Tooltip
            contentStyle={{ background: '#1F1F1F', border: '1px solid #2A2826', borderRadius: 6, fontSize: 12 }}
            labelStyle={{ color: '#6B6460', fontFamily: "'JetBrains Mono', monospace" }}
            itemStyle={{ fontFamily: "'JetBrains Mono', monospace" }}
            labelFormatter={v => fmtChartDate(v, range)}
            formatter={(v) => [
              typeof v === 'number' ? (mode === 'drawdown' ? `${v.toFixed(1)}%` : v.toFixed(1)) : v,
              undefined,
            ]}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: '#6B6460' }}
          />
          <Line
            type="monotone"
            dataKey="sp500"
            name="SP500"
            stroke="#C8A96E"
            dot={false}
            strokeWidth={1.5}
          />
          <Line
            type="monotone"
            dataKey="ndx"
            name="NDX"
            stroke="#6B9EC8"
            dot={false}
            strokeWidth={1.5}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function AllocationSummary({ notices }: { notices: MarketPulse['notices'] }) {
  const priority = notices
    .filter(n => n.guidance_bucket === 'priority')
    .map(n => n.ticker || n.name || '')
    .filter(Boolean)
  const defer = notices
    .filter(n => n.guidance_bucket === 'defer')
    .map(n => n.ticker || n.name || '')
    .filter(Boolean)

  if (priority.length === 0 && defer.length === 0) return null

  return (
    <div style={{
      background: '#0E0E0E',
      border: '1px solid #2A2826',
      borderRadius: 6,
      padding: '10px 14px',
      marginBottom: 14,
      display: 'flex',
      gap: 24,
      flexWrap: 'wrap',
      alignItems: 'center',
    }}>
      {priority.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            color: '#C8A96E',
            background: 'rgba(200,169,110,0.12)',
            borderRadius: 3,
            padding: '2px 6px',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>优先</span>
          <span style={{
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
            color: '#C8A96E',
          }}>{priority.join(' · ')}</span>
        </div>
      )}
      {defer.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            color: '#C06B5A',
            background: 'rgba(192,107,90,0.12)',
            borderRadius: 3,
            padding: '2px 6px',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}>暂缓</span>
          <span style={{
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
            color: '#C06B5A',
          }}>{defer.join(' · ')}</span>
        </div>
      )}
    </div>
  )
}

function NoticeCard({ notice }: { notice: MarketPulse['notices'][number] }) {
  const color = DIRECTION_COLOR[notice.signal_direction] ?? '#6B6460'
  return (
    <div style={{
      background: '#161616',
      border: '1px solid #2A2826',
      borderRadius: 8,
      padding: '14px 16px',
      marginBottom: 10,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {notice.ticker && (
            <span style={{
              fontSize: 12,
              fontFamily: "'JetBrains Mono', monospace",
              fontWeight: 600,
              color: '#E8E0D0',
            }}>{notice.ticker}</span>
          )}
          <span style={{
            fontSize: 11,
            fontFamily: "'JetBrains Mono', monospace",
            color: '#6B6460',
          }}>{notice.weight_pct.toFixed(1)}%</span>
          <span style={{
            fontSize: 10,
            fontFamily: "'JetBrains Mono', monospace",
            color,
            background: color + '1A',
            borderRadius: 4,
            padding: '1px 5px',
            textTransform: 'uppercase',
          }}>{notice.signal.toUpperCase()} {DIRECTION_LABEL[notice.signal_direction]}</span>
        </div>
        <span style={{
          fontSize: 13,
          fontFamily: "'JetBrains Mono', monospace",
          color,
        }}>{notice.signal_value.toFixed(1)}</span>
      </div>
      <div style={{
        fontSize: 12,
        fontFamily: "'LXGW WenKai', serif",
        color: '#A89880',
        lineHeight: 1.7,
      }}>{notice.message}</div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function MarketPulseView() {
  const [data, setData] = useState<MarketPulse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.marketPulse()
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div style={{ color: '#6B6460', fontSize: 13, padding: '48px 0', textAlign: 'center',
        fontFamily: "'JetBrains Mono', monospace" }}>
        加载中…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{
        background: 'rgba(192,107,90,0.1)', border: '1px solid #C06B5A',
        borderRadius: 6, padding: '12px 16px', color: '#C06B5A', fontSize: 13,
      }}>
        {error}
      </div>
    )
  }

  if (!data || data.signals.vix === undefined) {
    return (
      <div style={{
        background: '#161616', border: '1px solid #2A2826', borderRadius: 8,
        padding: '32px', textAlign: 'center',
      }}>
        <div style={{ fontSize: 14, color: '#E8E0D0', marginBottom: 8 }}>暂无市场数据</div>
        <div style={{ fontSize: 12, fontFamily: "'LXGW WenKai', serif", color: '#6B6460', lineHeight: 1.65 }}>
          请在服务器运行 <code style={{ fontFamily: "'JetBrains Mono', monospace" }}>python -m backend.market_fetcher</code> 获取今日数据
        </div>
      </div>
    )
  }

  const { signals, price_history, confluence, notices, stale } = data

  return (
    <div>
      {stale && (
        <div style={{
          background: 'rgba(192,107,90,0.08)', border: '1px solid #C06B5A',
          borderRadius: 6, padding: '10px 16px', marginBottom: 16,
          fontSize: 12, color: '#C06B5A', fontFamily: "'LXGW WenKai', serif",
        }}>
          ⚠ 市场数据偏旧，后台正在尝试刷新；若长时间未恢复，请检查 market_fetcher
        </div>
      )}

      <DecisionStrip data={confluence} marketDate={data.market_date} stale={stale} />
      {notices.length > 0 && <AllocationSummary notices={notices} />}

      <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
        {SIGNAL_META.map(({ key, label, invertDeltaColor }) => {
          const val = (signals as any)[key] as number | undefined
          const delta = (signals as any)[`${key === 'rsi_sp500' ? 'rsi' : key}_delta`] as number | undefined
          const deltaDays = signals.delta_days
          const dir = confluence.signal_labels[key]
          const zones = ZONES_INFO[key]
          const activeZoneKey = getActiveZoneKey(key, val)
          const cardDirection = activeZoneKey === 'panic' ? 'panic' : dir
          const pb = PLAYBOOK[key]?.[cardDirection ?? '']
          return (
            <SignalCard
              key={key}
              label={label}
              value={val}
              delta={delta}
              deltaDays={deltaDays}
              invertDeltaColor={invertDeltaColor ?? false}
              direction={cardDirection}
              playbook={pb}
              isInt={key === 'fg'}
              zones={zones}
              activeZoneKey={activeZoneKey}
              marketDate={data.market_date}
            />
          )
        })}
      </div>

      {price_history.length > 0 && <PriceChart rows={price_history} />}

      {notices.length > 0 && (
        <div>
          <div style={{
            fontSize: 12,
            fontFamily: "'JetBrains Mono', monospace",
            color: '#6B6460',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            marginBottom: 12,
          }}>个人持仓信号</div>
          {notices.map((n, i) => <NoticeCard key={i} notice={n} />)}
        </div>
      )}
    </div>
  )
}
