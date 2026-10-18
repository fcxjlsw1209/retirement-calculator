import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { type AccountSummary, type Portfolio, api } from './api'
import { computeHoldingWeights, type AssetClassWeights } from './retirement'

// ─── Constants ────────────────────────────────────────────────────────────────

const RETIREMENT_KEYWORDS = ['401k', '401(k)', 'ira', 'roth', '403b', '403(b)', 'pension', 'retirement', 'hsa', 'health saving']

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function accountKey(acct: AccountSummary): string {
  return acct.account_name ?? `${acct.source}:${acct.firm_name ?? 'unknown'}`
}

function isRetirementByKeyword(acct: AccountSummary): boolean {
  const text = [acct.account_name, acct.account_type, acct.firm_name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return RETIREMENT_KEYWORDS.some(kw => text.includes(kw))
}

// Merges existing DB tags with auto-detected suggestions for new accounts
export function initializeTags(
  accounts: AccountSummary[],
  existing: Record<string, boolean>,
): Record<string, boolean> {
  const result: Record<string, boolean> = { ...existing }
  for (const acct of accounts) {
    const key = accountKey(acct)
    if (!(key in result)) {
      result[key] = isRetirementByKeyword(acct)
    }
  }
  return result
}

// ─── useRetirementData hook ───────────────────────────────────────────────────

export interface RetirementData {
  portfolio: Portfolio | null
  accounts: AccountSummary[]
  tags: Record<string, boolean>
  setTags: (tags: Record<string, boolean>) => void
  taxableTotal: number
  retirementTotal: number
  holdingWeights: AssetClassWeights
  loading: boolean
  error: string | null
  tagSaveError: boolean
  noSync: boolean  // true when no holdings have been synced yet
}

export function useRetirementData(): RetirementData {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [tags, setTagsInternal] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tagSaveError, setTagSaveError] = useState(false)
  const tagSaveQueue = useRef<Promise<unknown>>(Promise.resolve())
  const tagRevision = useRef(0)

  useEffect(() => {
    Promise.all([api.portfolio.get(), api.retirement.accountTags.get()])
      .then(([p, savedTags]) => {
        setPortfolio(p)
        setTagsInternal(initializeTags(p.accounts, savedTags))
        setLoading(false)
      })
      .catch((e: Error) => {
        setError(e.message)
        setLoading(false)
      })
  }, [])

  const setTags = useCallback((newTags: Record<string, boolean>) => {
    setTagsInternal(newTags)
    setTagSaveError(false)
    const revision = ++tagRevision.current
    const snapshot = { ...newTags }
    tagSaveQueue.current = tagSaveQueue.current.then(() => api.retirement.accountTags.set(snapshot))
      .catch(() => { if (revision === tagRevision.current) setTagSaveError(true) })
  }, [])

  const accounts = useMemo(() => portfolio?.accounts ?? [], [portfolio])
  const holdings = useMemo(() => portfolio?.holdings ?? [], [portfolio])
  const noSync = holdings.length === 0

  const taxableTotal = useMemo(
    () => accounts.filter(a => !tags[accountKey(a)]).reduce((s, a) => s + a.total_value_usd, 0),
    [accounts, tags],
  )

  const retirementTotal = useMemo(
    () => accounts.filter(a => tags[accountKey(a)]).reduce((s, a) => s + a.total_value_usd, 0),
    [accounts, tags],
  )

  const holdingWeights = useMemo(
    () => noSync ? { blended: 1 } as AssetClassWeights : computeHoldingWeights(holdings),
    [noSync, holdings],
  )

  return {
    portfolio,
    accounts,
    tags,
    setTags,
    taxableTotal,
    retirementTotal,
    holdingWeights,
    loading,
    error,
    tagSaveError,
    noSync,
  }
}

// ─── RetirementAccountTagger component ───────────────────────────────────────

interface Props {
  accounts: AccountSummary[]
  tags: Record<string, boolean>
  onTagsChange: (tags: Record<string, boolean>) => void
  taxableTotal: number
  retirementTotal: number
  hidden: boolean
}

const MASK = '●●●●●'
const SOURCE_LABEL: Record<string, string> = {
  empower: 'Empower',
}

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n)
}

export default function RetirementAccountTagger({
  accounts,
  tags,
  onTagsChange,
  taxableTotal,
  retirementTotal,
  hidden,
}: Props) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number; right: number } | null>(null)

  const autoCount = accounts.filter(a => isRetirementByKeyword(a)).length

  const openPopover = useCallback(() => {
    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect()
      setPopoverPos({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      })
    }
    setOpen(true)
  }, [])

  const toggle = useCallback((key: string, checked: boolean) => {
    onTagsChange({ ...tags, [key]: checked })
  }, [tags, onTagsChange])

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const balanceCardStyle: React.CSSProperties = {
    background: '#161616',
    border: '1px solid #2A2826',
    borderRadius: 6,
    padding: '10px 16px',
    minWidth: 140,
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {/* Balance cards */}
      <div style={balanceCardStyle}>
        <div style={{ fontSize: 10, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
          常规账户
        </div>
        <div style={{ fontSize: 18, color: '#E8E0D0', fontFamily: "'JetBrains Mono', monospace", fontWeight: 500 }}>
          {hidden
            ? <span style={{ color: '#3A3228', letterSpacing: 3 }}>{MASK}</span>
            : fmt(taxableTotal)
          }
        </div>
      </div>

      <div style={balanceCardStyle}>
        <div style={{ fontSize: 10, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>
          退休账户
        </div>
        <div style={{ fontSize: 18, color: '#C8A96E', fontFamily: "'JetBrains Mono', monospace", fontWeight: 500 }}>
          {hidden
            ? <span style={{ color: '#3A3228', letterSpacing: 3 }}>{MASK}</span>
            : fmt(retirementTotal)
          }
        </div>
      </div>

      {/* Tagger button */}
      <div style={{ position: 'relative' }}>
        <button
          ref={buttonRef}
          onClick={open ? () => setOpen(false) : openPopover}
          style={{
            background: 'none',
            border: '1px solid',
            borderColor: open ? 'rgba(200,169,110,0.5)' : '#2A2826',
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 12,
            color: open ? '#C8A96E' : '#6B6460',
            fontFamily: "'Space Grotesk', sans-serif",
            padding: '6px 12px',
            transition: 'color 0.1s, border-color 0.1s',
            whiteSpace: 'nowrap',
          }}
        >
          账户标记 {open ? '▴' : '▾'}
        </button>
      </div>

      {/* Popover */}
      {open && popoverPos && (
        <div
          ref={popoverRef}
          style={{
            position: 'fixed',
            top: popoverPos.top,
            right: popoverPos.right,
            zIndex: 1000,
            background: '#161616',
            border: '1px solid #2A2826',
            borderRadius: 8,
            boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
            width: 320,
            maxHeight: 420,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Header */}
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #2A2826' }}>
            <div style={{ fontSize: 13, color: '#E8E0D0', fontWeight: 600, fontFamily: "'Space Grotesk', sans-serif", marginBottom: 4 }}>
              标记退休账户
            </div>
            <div style={{ fontSize: 11, color: '#6B6460', fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1.5 }}>
              退休账户（如 401k/IRA/Roth）60 岁前无法自由提取
            </div>
          </div>

          {/* Account list */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            {accounts.length === 0 && (
              <div style={{ padding: '20px 16px', color: '#6B6460', fontSize: 12, textAlign: 'center' }}>
                暂无账户数据，请先同步
              </div>
            )}
            {accounts.map(acct => {
              const key = accountKey(acct)
              const isRetirement = tags[key] ?? false
              const sourceLabel = SOURCE_LABEL[acct.source] ?? acct.source
              return (
                <label
                  key={key}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 16px',
                    borderBottom: '1px solid #1A1816',
                    cursor: 'pointer',
                    transition: 'background 0.08s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#1F1F1F')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  {/* Checkbox */}
                  <div
                    onClick={e => { e.preventDefault(); toggle(key, !isRetirement) }}
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: 3,
                      border: `1.5px solid ${isRetirement ? '#C8A96E' : '#3A3530'}`,
                      background: isRetirement ? 'rgba(200,169,110,0.15)' : 'transparent',
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      transition: 'border-color 0.1s, background 0.1s',
                    }}
                  >
                    {isRetirement && (
                      <span style={{ color: '#C8A96E', fontSize: 10, lineHeight: 1 }}>✓</span>
                    )}
                  </div>

                  {/* Account info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12,
                      color: '#E8E0D0',
                      fontFamily: "'Space Grotesk', sans-serif",
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}>
                      {acct.account_name ?? acct.firm_name ?? sourceLabel}
                    </div>
                    <div style={{ fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", marginTop: 1 }}>
                      {sourceLabel}{acct.account_type ? ` · ${acct.account_type}` : ''}
                    </div>
                  </div>

                  {/* Value */}
                  <div style={{
                    fontSize: 12,
                    color: '#6B6460',
                    fontFamily: "'JetBrains Mono', monospace",
                    flexShrink: 0,
                  }}>
                    {hidden ? MASK : fmt(acct.total_value_usd)}
                  </div>
                </label>
              )
            })}
          </div>

          {/* Footer */}
          {autoCount > 0 && (
            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid #2A2826',
              fontSize: 11,
              color: '#6B6460',
              fontFamily: "'Space Grotesk', sans-serif",
            }}>
              自动识别了 {autoCount} 个退休账户，可手动调整
            </div>
          )}
        </div>
      )}
    </div>
  )
}
