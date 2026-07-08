import { useState, useEffect } from 'react'
import { Portfolio, Holding, AccountSummary, CashFlow, api } from './api'
import PerformanceChart from './PerformanceChart'

interface Props { portfolio: Portfolio; hidden: boolean }

type ViewMode = 'account' | 'asset_type' | 'asset'

const SOURCE_LABEL: Record<string, string> = {
  empower: 'Empower',
}

// Categorical palette for allocation bars: cross-hue, muted, dark-mode legible
const ALLOCATION_PALETTE = [
  '#C8A96E',  // antique gold
  '#7EB87A',  // sage green
  '#C87860',  // burnt sienna
  '#7898B0',  // steel blue
  '#C0B048',  // warm ochre
  '#90A888',  // muted sage
  '#C89878',  // copper peach
  '#8878B0',  // soft violet
  '#78A8A0',  // teal
  '#B07880',  // dusty rose
  '#4A4840',  // 其他 — dark neutral
]
const OTHER_COLOR = '#4A4840'

const MASK = '●●●●●'

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function fmtPct(n: number) {
  return (n * 100).toFixed(1) + '%'
}

function fmtOrMask(n: number, hidden: boolean) {
  return hidden
    ? <span style={{ color: '#3A3228', letterSpacing: 3, fontFamily: "'JetBrains Mono', monospace" }}>{MASK}</span>
    : <>{fmt(n)}</>
}

function thStyle(align: 'left' | 'right'): React.CSSProperties {
  return {
    padding: '8px 12px',
    textAlign: align,
    fontWeight: 400,
    color: '#6B6460',
    borderBottom: '1px solid #2A2826',
    fontSize: 11,
    fontFamily: "'JetBrains Mono', monospace",
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  }
}

// ── Stacked allocation bar ────────────────────────────────────────────────────

const MAX_SEGMENTS = 7

function AllocationBar({ segments, minPct = 0 }: { segments: { label: string; pct: number }[], minPct?: number }) {
  // Sort descending, filter by minPct, cap at MAX_SEGMENTS, group tail as "其他"
  const sorted = [...segments].sort((a, b) => b.pct - a.pct)
  const above = minPct > 0 ? sorted.filter(s => s.pct >= minPct) : sorted
  const below = minPct > 0 ? sorted.filter(s => s.pct < minPct) : []
  const cap = minPct > 0 ? above.length : MAX_SEGMENTS
  const shown = above.slice(0, cap)
  const otherPct = above.slice(cap).reduce((s, x) => s + x.pct, 0)
    + below.reduce((s, x) => s + x.pct, 0)
  if (otherPct > 0.001) shown.push({ label: '其他', pct: otherPct })

  const colorFor = (i: number, label: string) =>
    label === '其他' ? OTHER_COLOR : ALLOCATION_PALETTE[i % (ALLOCATION_PALETTE.length - 1)]

  return (
    <div style={{ marginBottom: 12, padding: '12px 14px', background: '#161616', borderRadius: 6, border: '1px solid #2A2826' }}>
      <div style={{ display: 'flex', height: 5, borderRadius: 3, overflow: 'hidden', marginBottom: 10 }}>
        {shown.map((s, i) => (
          <div
            key={s.label}
            title={`${s.label}: ${fmtPct(s.pct)}`}
            style={{ width: `${s.pct * 100}%`, height: '100%', background: colorFor(i, s.label) }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 20px' }}>
        {shown.map((s, i) => (
          <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <div style={{ width: 7, height: 7, borderRadius: 1, flexShrink: 0, background: colorFor(i, s.label) }} />
            <span style={{ fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace" }}>
              {s.label} <span style={{ color: '#E8E0D0' }}>{fmtPct(s.pct)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Holdings table ────────────────────────────────────────────────────────────

function HoldingsTable({ holdings, showAccount, firmMap, portfolioTotal, hidden }: {
  holdings: Holding[]
  showAccount?: boolean
  firmMap?: Map<string, string>
  portfolioTotal?: number
  hidden: boolean
}) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ background: '#0E0E0E' }}>
          <th style={thStyle('left')}>名称</th>
          {showAccount && <th style={thStyle('left')}>账户</th>}
          <th style={thStyle('right')}>股数</th>
          <th style={thStyle('right')}>单价</th>
          <th style={thStyle('right')}>市值</th>
        </tr>
      </thead>
      <tbody>
        {holdings.map((h, i) => {
          const digits = (h.account_name ?? '').match(/(\d{4})/)
          const firmKey = digits ? `${h.source}::${digits[1]}` : `${h.source}::${h.account_name ?? ''}`
          const firmLabel = firmMap?.get(firmKey) ?? SOURCE_LABEL[h.source] ?? h.source
          const pct = portfolioTotal && portfolioTotal > 0 ? h.value_usd / portfolioTotal : null
          const price = h.shares && h.shares > 0 ? h.value_usd / h.shares : null
          const monoGray: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", color: '#9A9490', fontSize: 11 }
          return (
            <tr key={i} style={{ borderTop: '1px solid #2A2826' }}>
              <td style={{ padding: '8px 12px' }}>
                {h.ticker && (
                  <span style={{ fontWeight: 600, marginRight: 6, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
                    {h.ticker}
                  </span>
                )}
                <span style={{ color: '#6B6460' }}>{h.name}</span>
              </td>
              {showAccount && (
                <td style={{ padding: '8px 12px', color: '#6B6460', fontSize: 11 }}>
                  {h.account_name
                    ? <>{h.account_name}<br /><span style={{ color: '#2A2826', fontSize: 10 }}>{firmLabel}</span></>
                    : firmLabel}
                </td>
              )}
              <td style={{ padding: '8px 12px', textAlign: 'right', ...monoGray }}>
                {h.shares != null ? h.shares.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '—'}
              </td>
              <td style={{ padding: '8px 12px', textAlign: 'right', ...monoGray }}>
                {price != null ? '$' + price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}
              </td>
              <td style={{ padding: '8px 12px', textAlign: 'right', fontFamily: "'JetBrains Mono', monospace", fontWeight: 500 }}>
                {fmtOrMask(h.value_usd, hidden)}
                {pct !== null && (
                  <div style={{ fontSize: 11, color: '#9A9490', fontWeight: 400 }}>{fmtPct(pct)}</div>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

// ── Collapsible section ───────────────────────────────────────────────────────

function Section({
  title, subtitle, value, portfolioTotal, expanded, onToggle, children, stale, hidden,
}: {
  title: string
  subtitle?: string
  value: number
  portfolioTotal?: number
  expanded: boolean
  onToggle: () => void
  children: React.ReactNode
  stale?: boolean
  hidden: boolean
}) {
  const pct = portfolioTotal && portfolioTotal > 0 ? value / portfolioTotal : null
  return (
    <div style={{
      border: `1px solid ${stale ? '#C06B5A' : '#2A2826'}`,
      borderRadius: 6,
      overflow: 'hidden',
      marginBottom: 4,
    }}>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          background: expanded ? '#1F1F1F' : '#161616',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 11, color: '#6B6460', flexShrink: 0 }}>{expanded ? '▾' : '▸'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 500, fontSize: 13, color: stale ? '#C06B5A' : '#E8E0D0' }}>{title}</div>
          {subtitle && <div style={{ fontSize: 11, color: '#6B6460', marginTop: 1 }}>{subtitle}</div>}
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <div style={{ fontWeight: 500, fontSize: 14, fontFamily: "'JetBrains Mono', monospace", color: '#E8E0D0' }}>
            {fmtOrMask(value, hidden)}
          </div>
          {pct !== null && (
            <div style={{ fontSize: 11, color: '#9A9490', fontWeight: 400 }}>{fmtPct(pct)}</div>
          )}
        </div>
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid #2A2826' }}>
          {children}
        </div>
      )}
    </div>
  )
}

// ── Cash flow panel ───────────────────────────────────────────────────────────

function CashFlowPanel({ accountName, hidden }: { accountName: string; hidden: boolean }) {
  const [flows, setFlows] = useState<CashFlow[] | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [formDate, setFormDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [formAmount, setFormAmount] = useState('')
  const [formNote, setFormNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.cashFlows.list(accountName).then(setFlows).catch(() => setFlows([]))
  }, [accountName])

  const handleAdd = async () => {
    const amount = parseFloat(formAmount)
    if (!formDate || isNaN(amount) || amount === 0) {
      setError('请填写日期和金额（非零）')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const cf = await api.cashFlows.add({ account_name: accountName, date: formDate, amount_usd: amount, note: formNote || undefined })
      setFlows(prev => [cf, ...(prev ?? [])])
      setShowForm(false)
      setFormAmount('')
      setFormNote('')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    await api.cashFlows.delete(id)
    setFlows(prev => (prev ?? []).filter(f => f.id !== id))
  }

  return (
    <div style={{ borderTop: '1px solid #2A2826', padding: '10px 14px', background: '#0E0E0E' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", textTransform: 'uppercase', letterSpacing: '0.08em' }}>现金流</span>
        <button
          onClick={() => { setShowForm(v => !v); setError(null) }}
          style={{ fontSize: 12, color: '#C8A96E', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          {showForm ? '取消' : '+ 添加'}
        </button>
      </div>

      {showForm && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10, flexWrap: 'wrap' }}>
          <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)}
            style={{ fontSize: 12, padding: '4px 8px', border: '1px solid #2A2826', borderRadius: 4, background: '#161616', color: '#E8E0D0' }} />
          <input type="number" placeholder="金额（正=流入，负=流出）" value={formAmount}
            onChange={e => setFormAmount(e.target.value)}
            style={{ fontSize: 12, padding: '4px 8px', border: '1px solid #2A2826', borderRadius: 4, width: 190, background: '#161616', color: '#E8E0D0' }} />
          <input type="text" placeholder="备注（可选）" value={formNote}
            onChange={e => setFormNote(e.target.value)}
            style={{ fontSize: 12, padding: '4px 8px', border: '1px solid #2A2826', borderRadius: 4, width: 120, background: '#161616', color: '#E8E0D0' }} />
          <button onClick={handleAdd} disabled={saving}
            style={{ fontSize: 12, padding: '4px 12px', background: '#C8A96E', color: '#0E0E0E', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>
            {saving ? '保存中…' : '保存'}
          </button>
          {error && <span style={{ fontSize: 12, color: '#C06B5A' }}>{error}</span>}
        </div>
      )}

      {flows === null ? (
        <div style={{ fontSize: 12, color: '#6B6460' }}>加载中…</div>
      ) : flows.length === 0 ? (
        <div style={{ fontSize: 12, color: '#6B6460' }}>暂无记录</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {flows.map(cf => (
              <tr key={cf.id} style={{ borderTop: '1px solid #2A2826' }}>
                <td style={{ padding: '5px 0', color: '#6B6460', width: 90, fontFamily: "'JetBrains Mono', monospace" }}>{cf.date}</td>
                <td style={{ padding: '5px 8px', fontWeight: 500, fontFamily: "'JetBrains Mono', monospace", color: cf.amount_usd >= 0 ? '#C8A96E' : '#C06B5A' }}>
                  {hidden
                    ? <span style={{ color: '#3A3228', letterSpacing: 2 }}>{MASK}</span>
                    : <>{cf.amount_usd >= 0 ? '+' : ''}{fmt(cf.amount_usd)}</>
                  }
                </td>
                <td style={{ padding: '5px 8px', color: '#6B6460', flex: 1 }}>{cf.note ?? ''}</td>
                <td style={{ padding: '5px 0', textAlign: 'right' }}>
                  <button onClick={() => handleDelete(cf.id)}
                    style={{ fontSize: 11, color: '#6B6460', background: 'none', border: 'none', cursor: 'pointer' }}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

// ── View: By Account ──────────────────────────────────────────────────────────

function AccountView({ accounts, expanded, onToggle, portfolioTotal, hidden }: {
  accounts: AccountSummary[]
  expanded: Set<string>
  onToggle: (k: string) => void
  portfolioTotal: number
  hidden: boolean
}) {
  const now = Date.now()
  const STALE_MS = 7 * 24 * 60 * 60 * 1000

  const segments = accounts
    .map(acct => ({
      label: acct.firm_name ?? acct.account_name ?? (SOURCE_LABEL[acct.source] || acct.source),
      pct: portfolioTotal > 0 ? acct.total_value_usd / portfolioTotal : 0,
    }))
    .sort((a, b) => b.pct - a.pct)

  return (
    <div>
      <AllocationBar segments={segments} />
      {accounts.map((acct) => {
        const key = `${acct.source}::${acct.firm_name ?? ''}::${acct.account_name ?? ''}`
        const label = acct.firm_name ?? acct.account_name ?? (SOURCE_LABEL[acct.source] || acct.source)

        const refreshedMs = acct.last_refreshed ? new Date(acct.last_refreshed).getTime() : null
        const isStale = refreshedMs ? (now - refreshedMs) > STALE_MS : false
        const refreshedStr = refreshedMs
          ? new Date(acct.last_refreshed!).toLocaleDateString('zh-CN')
          : null

        const sublabelParts = [acct.account_type, acct.account_name].filter(Boolean)
        if (refreshedStr) sublabelParts.push(`数据截至 ${refreshedStr}`)
        const sublabel = sublabelParts.join(' · ') || undefined

        return (
          <Section key={key} title={label} subtitle={sublabel} value={acct.total_value_usd}
            portfolioTotal={portfolioTotal}
            expanded={expanded.has(key)} onToggle={() => onToggle(key)}
            stale={isStale} hidden={hidden}>
            {acct.account_name && <CashFlowPanel accountName={acct.account_name} hidden={hidden} />}
          </Section>
        )
      })}
    </div>
  )
}

// ── View: By Asset Type ───────────────────────────────────────────────────────

function AssetTypeView({ holdings, expanded, onToggle, firmMap, portfolioTotal, hidden }: {
  holdings: Holding[]
  expanded: Set<string>
  onToggle: (k: string) => void
  firmMap: Map<string, string>
  portfolioTotal: number
  hidden: boolean
}) {
  const groups: Record<string, Holding[]> = {}
  for (const h of holdings) {
    groups[h.holding_type] = groups[h.holding_type] ?? []
    groups[h.holding_type].push(h)
  }
  const sorted = Object.entries(groups).sort(([, a], [, b]) => {
    const av = a.reduce((s, h) => s + h.value_usd, 0)
    const bv = b.reduce((s, h) => s + h.value_usd, 0)
    return bv - av
  })
  const holdingsTotal = holdings.reduce((s, h) => s + h.value_usd, 0)
  const denominator = portfolioTotal > 0 ? portfolioTotal : holdingsTotal

  const segments = sorted.map(([type, hs]) => ({
    label: type,
    pct: denominator > 0 ? hs.reduce((s, h) => s + h.value_usd, 0) / denominator : 0,
  }))

  return (
    <div>
      <AllocationBar segments={segments} minPct={0.015} />
      {sorted.map(([type, hs]) => {
        const total = hs.reduce((s, h) => s + h.value_usd, 0)
        return (
          <Section key={type} title={type} value={total}
            portfolioTotal={denominator}
            expanded={expanded.has(type)} onToggle={() => onToggle(type)}
            hidden={hidden}>
            <HoldingsTable holdings={[...hs].sort((a, b) => b.value_usd - a.value_usd)} showAccount firmMap={firmMap} portfolioTotal={portfolioTotal} hidden={hidden} />
          </Section>
        )
      })}
    </div>
  )
}

// ── View: By Asset ────────────────────────────────────────────────────────────

function AssetView({ holdings, firmMap, portfolioTotal, hidden }: {
  holdings: Holding[]
  firmMap: Map<string, string>
  portfolioTotal: number
  hidden: boolean
}) {
  const segments = [...holdings]
    .sort((a, b) => b.value_usd - a.value_usd)
    .map(h => ({
      label: h.ticker ?? h.name ?? '—',
      pct: portfolioTotal > 0 ? h.value_usd / portfolioTotal : 0,
    }))

  return (
    <div>
      <AllocationBar segments={segments} />
      <div style={{ background: '#161616', borderRadius: 6, border: '1px solid #2A2826', overflow: 'hidden' }}>
        <HoldingsTable holdings={holdings} showAccount firmMap={firmMap} portfolioTotal={portfolioTotal} hidden={hidden} />
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function PortfolioView({ portfolio, hidden }: Props) {
  const { last_synced, sources, holdings, accounts } = portfolio
  const [view, setView] = useState<ViewMode>('asset_type')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const firmMap = new Map<string, string>()
  for (const acct of accounts) {
    if (acct.firm_name) {
      const m = (acct.account_name ?? '').match(/(\d{4})/)
      const key = m ? `${acct.source}::${m[1]}` : `${acct.source}::${acct.account_name ?? ''}`
      firmMap.set(key, acct.firm_name)
    }
  }

  const toggle = (key: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const portfolioTotal = accounts.reduce((s, a) => s + a.total_value_usd, 0)

  const total = view === 'account'
    ? portfolioTotal
    : holdings.reduce((s, h) => s + h.value_usd, 0)

  return (
    <div>
      {/* Total */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 36, fontWeight: 600, letterSpacing: -1, fontFamily: "'JetBrains Mono', monospace" }}>
          {fmtOrMask(total, hidden)}
        </div>
        {view !== 'account' && portfolioTotal !== total && (
          <div style={{ fontSize: 12, color: '#6B6460', marginTop: 4 }}>
            仅含有持仓明细的账户（不含{' '}
            {hidden
              ? <span style={{ color: '#3A3228' }}>{MASK}</span>
              : fmt(portfolioTotal - total)
            }{' '}无持仓数据的账户）
          </div>
        )}
        {last_synced && (
          <div style={{ fontSize: 11, color: '#6B6460', marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>
            上次同步：{new Date(last_synced.endsWith('Z') ? last_synced : last_synced + 'Z').toLocaleString('zh-CN')}
          </div>
        )}
      </div>

      {/* Source pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
        {Object.entries(sources).map(([src, s]) => (
          <div key={src} style={{
            padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 500,
            fontFamily: "'JetBrains Mono', monospace",
            background: s.status === 'ok' ? 'rgba(200,169,110,0.12)' : 'rgba(192,107,90,0.12)',
            color: s.status === 'ok' ? '#C8A96E' : '#C06B5A',
          }}>
            {SOURCE_LABEL[src] || src}
            {s.status !== 'ok' && s.last_ok && <span style={{ fontWeight: 400 }}> · 上次 {new Date(s.last_ok).toLocaleDateString('zh-CN')}</span>}
            {s.status !== 'ok' && !s.last_ok && <span style={{ fontWeight: 400 }}> · 未同步</span>}
          </div>
        ))}
      </div>

      {/* Performance chart */}
      <PerformanceChart />

      {/* Tab switcher */}
      <div style={{ display: 'flex', gap: 2, marginBottom: 14, background: '#1F1F1F', borderRadius: 7, padding: 3, width: 'fit-content' }}>
        {([['asset_type', '按类型'], ['account', '按账户'], ['asset', '按资产']] as [ViewMode, string][]).map(([v, label]) => (
          <button key={v} onClick={() => setView(v)} style={{
            padding: '6px 16px', borderRadius: 5, border: 'none', cursor: 'pointer',
            fontSize: 13, fontWeight: 500,
            background: view === v ? '#161616' : 'transparent',
            color: view === v ? '#E8E0D0' : '#6B6460',
            boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.3)' : 'none',
            transition: 'all 0.1s',
          }}>
            {label}
          </button>
        ))}
      </div>

      {view === 'account' && <AccountView accounts={accounts} expanded={expanded} onToggle={toggle} portfolioTotal={portfolioTotal} hidden={hidden} />}
      {view === 'asset_type' && <AssetTypeView holdings={holdings} expanded={expanded} onToggle={toggle} firmMap={firmMap} portfolioTotal={portfolioTotal} hidden={hidden} />}
      {view === 'asset' && <AssetView holdings={holdings} firmMap={firmMap} portfolioTotal={portfolioTotal} hidden={hidden} />}

      <div style={{ height: 48 }} />
    </div>
  )
}
