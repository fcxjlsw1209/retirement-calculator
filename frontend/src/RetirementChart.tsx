import { useState } from 'react'
import {
  ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts'
import type { MonteCarloResult } from './retirement'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Props {
  result: MonteCarloResult
  retirementAge: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtMoney(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

function fmtMoneyFull(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n)
}

function successColor(rate: number): string {
  if (rate >= 0.8) return '#C8A96E'
  if (rate >= 0.6) return '#E8E0D0'
  return '#C06B5A'
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null

  const p10 = payload.find((p: any) => p.dataKey === 'p10')?.value ?? 0
  const p50 = payload.find((p: any) => p.dataKey === 'p50')?.value ?? 0
  const p90 = payload.find((p: any) => p.dataKey === 'p90')?.value ?? 0

  return (
    <div style={{
      background: '#161616',
      border: '1px solid #2A2826',
      borderRadius: 6,
      padding: '8px 12px',
      fontSize: 11,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      <div style={{ color: '#6B6460', marginBottom: 6 }}>年龄 {label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ color: '#C8A96E' }}>90分位 {fmtMoney(p90)}</div>
        <div style={{ color: '#E8E0D0' }}>中位数 {fmtMoney(p50)}</div>
        <div style={{ color: '#C06B5A' }}>10分位 {fmtMoney(p10)}</div>
      </div>
    </div>
  )
}

// ─── RetirementChart ──────────────────────────────────────────────────────────

export default function RetirementChart({ result, retirementAge }: Props) {
  const { p10, p50, p90, ages, successRate } = result

  const data = ages.map((age, i) => ({
    age,
    p10: Math.max(0, p10[i]),
    p50: Math.max(0, p50[i]),
    p90: Math.max(0, p90[i]),
  }))

  const successPct = Math.round(successRate * 100)

  return (
    <div>
      {/* Chart header: title + success rate badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          模拟结果
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: '#6B6460', fontFamily: "'Space Grotesk', sans-serif" }}>成功率</span>
          <span style={{
            fontSize: 22,
            fontFamily: "'JetBrains Mono', monospace",
            fontWeight: 600,
            color: successColor(successRate),
            letterSpacing: '-0.02em',
          }}>
            {successPct}%
          </span>
        </div>
      </div>

      {/* Chart */}
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: -8, bottom: 0 }}>


          <CartesianGrid stroke="#1E1C1A" strokeDasharray="3 3" vertical={false} />

          <XAxis
            dataKey="age"
            tick={{ fill: '#6B6460', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
            tickLine={false}
            axisLine={{ stroke: '#2A2826' }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={fmtMoney}
            tick={{ fill: '#6B6460', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}
            tickLine={false}
            axisLine={false}
            width={56}
          />

          <Tooltip content={<ChartTooltip />} />

          {/* y=0 baseline */}
          <ReferenceLine y={0} stroke="#2A2826" strokeWidth={1} />

          {/* Retirement age vertical line */}
          <ReferenceLine
            x={retirementAge}
            stroke="rgba(200,169,110,0.5)"
            strokeDasharray="4 3"
            label={{
              value: `退休 ${retirementAge}`,
              position: 'insideTopRight',
              fill: 'rgba(200,169,110,0.7)',
              fontSize: 10,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          />

          {/* p90 — optimistic (gold, area) */}
          <Area
            type="monotone"
            dataKey="p90"
            stroke="#C8A96E"
            strokeWidth={1.5}
            fill="#C8A96E" fillOpacity={0.08}
            dot={false}
            activeDot={false}
            name="90分位"
          />

          {/* p50 — median (warm white, prominent) */}
          <Area
            type="monotone"
            dataKey="p50"
            stroke="#E8E0D0"
            strokeWidth={2}
            fill="none"
            dot={false}
            activeDot={{ r: 3, fill: '#E8E0D0' }}
            name="中位数"
          />

          {/* p10 — pessimistic (terra cotta, area) */}
          <Area
            type="monotone"
            dataKey="p10"
            stroke="#C06B5A"
            strokeWidth={1.5}
            fill="#C06B5A" fillOpacity={0.08}
            dot={false}
            activeDot={false}
            name="10分位"
          />
        </ComposedChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 6, justifyContent: 'center' }}>
        {[
          { color: '#C8A96E', label: '乐观 (90分位)' },
          { color: '#E8E0D0', label: '中位数 (50分位)' },
          { color: '#C06B5A', label: '悲观 (10分位)' },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />
            <span style={{ fontSize: 10, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace" }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── YearlyTable ──────────────────────────────────────────────────────────────

interface YearlyTableProps {
  result: MonteCarloResult
  retirementAge: number
}

export function YearlyTable({ result, retirementAge }: YearlyTableProps) {
  const { p10, p50, p90, ages } = result
  const [expanded, setExpanded] = useState(false)

  // Show every year when expanded, every 5 years when collapsed
  const rows = ages
    .map((age, i) => ({ age, p10: p10[i], p50: p50[i], p90: p90[i] }))
    .filter((_, i) => expanded ? true : i % 5 === 0 || ages[i] === retirementAge || i === ages.length - 1)

  const thStyle: React.CSSProperties = {
    fontSize: 10,
    color: '#6B6460',
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    padding: '6px 12px',
    textAlign: 'right',
    borderBottom: '1px solid #2A2826',
    fontWeight: 400,
    whiteSpace: 'nowrap',
  }

  const tdStyle: React.CSSProperties = {
    fontSize: 12,
    fontFamily: "'JetBrains Mono', monospace",
    padding: '5px 12px',
    textAlign: 'right',
    borderBottom: '1px solid #1A1816',
  }

  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          逐年资产预测（今日美元）
        </span>
        <button
          onClick={() => setExpanded(e => !e)}
          style={{
            background: 'none', border: '1px solid #2A2826', borderRadius: 4,
            color: '#6B6460', fontSize: 11, fontFamily: "'Space Grotesk', sans-serif",
            padding: '3px 8px', cursor: 'pointer',
          }}
        >
          {expanded ? '折叠（每5年）' : '展开（每年）'}
        </button>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#0E0E0E' }}>
              <th style={{ ...thStyle, textAlign: 'left' }}>年龄</th>
              <th style={{ ...thStyle, color: '#C8A96E' }}>乐观 (P90)</th>
              <th style={{ ...thStyle, color: '#E8E0D0' }}>中位数 (P50)</th>
              <th style={{ ...thStyle, color: '#C06B5A' }}>悲观 (P10)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => {
              const isRetirement = row.age === retirementAge
              return (
                <tr
                  key={row.age}
                  style={{
                    background: isRetirement ? 'rgba(200,169,110,0.05)' : 'transparent',
                  }}
                >
                  <td style={{ ...tdStyle, textAlign: 'left', color: isRetirement ? '#C8A96E' : '#6B6460' }}>
                    {row.age}{isRetirement ? ' ← 退休' : ''}
                  </td>
                  <td style={{ ...tdStyle, color: '#C8A96E' }}>{fmtMoneyFull(Math.max(0, row.p90))}</td>
                  <td style={{ ...tdStyle, color: '#E8E0D0', fontWeight: 500 }}>{fmtMoneyFull(Math.max(0, row.p50))}</td>
                  <td style={{ ...tdStyle, color: row.p10 <= 0 ? '#C06B5A' : '#E8E0D0' }}>{fmtMoneyFull(Math.max(0, row.p10))}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── OutputCards ──────────────────────────────────────────────────────────────

interface OutputCardsProps {
  result: MonteCarloResult
  retirementAge: number
}

export function OutputCards({ result, retirementAge }: OutputCardsProps) {
  const cards = [
    ['计划退休年龄', `${retirementAge} 岁`, '按此年龄之前持续投入、之后开始支出计算'],
    ['完整预算成功率', `${Math.round(result.successRate * 100)}%`, '整个规划期内能够支付全部预算的模拟比例'],
    ['退休当年参考缺口', fmtMoneyFull(result.medianGapToRetirement), '按资产中位数与平均回报折现预算比较'],
  ]
  return <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '16px 0' }}>
    {cards.map(([label, value, detail]) => <div key={label} style={{ background: '#161616', border: '1px solid #2A2826', borderRadius: 8, padding: 16, flex: '1 1 200px' }}>
      <div style={{ fontSize: 11, color: '#6B6460', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 22, color: '#C8A96E', fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
      <div style={{ fontSize: 11, color: '#6B6460', marginTop: 8 }}>{detail}</div>
    </div>)}
  </div>
}
