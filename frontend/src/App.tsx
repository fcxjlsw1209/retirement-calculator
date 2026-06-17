import { useState, useEffect, useCallback, useRef } from 'react'
import { api, Portfolio, Attribution } from './api'
import PortfolioView from './Portfolio'
import AttributionPanel from './Attribution'
import SyncLogPanel from './SyncLogPanel'
import MarketPulseView from './MarketPulse'
import RetirementCalculator from './RetirementCalculator'

type Tab = 'portfolio' | 'market-pulse' | 'retirement'

const HIDE_AFTER_MS = 60_000
const MARKET_PULSE_PREFETCH_TIMEOUT_MS = 3_000

export default function App() {
  const [tab, setTab] = useState<Tab>('portfolio')
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [attribution, setAttribution] = useState<Attribution | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncLogOpen, setSyncLogOpen] = useState(false)
  const [hidden, setHidden] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setHidden(true), HIDE_AFTER_MS)
  }, [])

  const toggleHidden = useCallback(() => {
    setHidden(prev => {
      if (prev) {
        scheduleHide()
        return false
      }
      if (hideTimer.current) clearTimeout(hideTimer.current)
      return true
    })
  }, [scheduleHide])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'h' && !e.metaKey && !e.ctrlKey && !e.altKey &&
          !(e.target instanceof HTMLInputElement) &&
          !(e.target instanceof HTMLTextAreaElement)) {
        toggleHidden()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleHidden])

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current) }, [])

  const loadData = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([api.portfolio.get(), api.attribution()])
      setPortfolio(p)
      setAttribution(a)
    } catch (e: any) {
      setError(e.message)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  useEffect(() => {
    if (tab !== 'portfolio') return

    const prefetch = () => {
      void api.marketPulse().catch(() => {
        // Prefetch should never surface errors; the tab handles its own load state.
      })
    }

    if ('requestIdleCallback' in window) {
      const id = window.requestIdleCallback(prefetch, { timeout: MARKET_PULSE_PREFETCH_TIMEOUT_MS })
      return () => window.cancelIdleCallback(id)
    }

    const id = setTimeout(prefetch, MARKET_PULSE_PREFETCH_TIMEOUT_MS)
    return () => clearTimeout(id)
  }, [tab])

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '0 16px' }}>
      <header style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '20px 0 16px',
        borderBottom: '1px solid #2A2826',
        marginBottom: 24,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#C8A96E', letterSpacing: '0.02em' }}>
            Retirement Calculator
          </span>
          <nav style={{ display: 'flex', gap: 2 }}>
            {([['portfolio', '投资组合'], ['market-pulse', '大盘脉搏'], ['retirement', '退休计算']] as [Tab, string][]).map(([t, label]) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                style={{
                  background: 'none',
                  border: 'none',
                  borderBottom: `2px solid ${tab === t ? '#C8A96E' : 'transparent'}`,
                  cursor: 'pointer',
                  fontSize: 13,
                  fontFamily: "'Space Grotesk', sans-serif",
                  color: tab === t ? '#E8E0D0' : '#6B6460',
                  padding: '4px 10px',
                  transition: 'color 0.1s, border-color 0.1s',
                }}
              >{label}</button>
            ))}
          </nav>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <button
            onClick={toggleHidden}
            style={{
              background: 'none',
              border: '1px solid',
              borderColor: hidden ? '#2A2826' : 'rgba(200,169,110,0.4)',
              borderRadius: 4,
              cursor: 'pointer',
              fontSize: 11,
              color: hidden ? '#6B6460' : '#C8A96E',
              fontFamily: "'JetBrains Mono', monospace",
              padding: '3px 8px',
              letterSpacing: '0.05em',
              transition: 'color 0.1s, border-color 0.1s',
            }}
            title="按 H 键切换"
          >
            {hidden ? '● ● ●' : '显示中'}
          </button>
          <button
            onClick={() => setSyncLogOpen(o => !o)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 12,
              color: syncLogOpen ? '#E8E0D0' : '#6B6460',
              fontFamily: "'Space Grotesk', sans-serif",
              padding: '4px 0',
              transition: 'color 0.1s',
            }}
          >
            同步日志
          </button>
        </div>
      </header>

      <SyncLogPanel open={syncLogOpen} />

      {error && (
        <div style={{
          background: 'rgba(192,107,90,0.1)',
          border: '1px solid #C06B5A',
          borderRadius: 6,
          padding: '12px 16px',
          marginBottom: 16,
          color: '#C06B5A',
          fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {portfolio?.warnings && portfolio.warnings.length > 0 && (
        <div style={{
          background: 'rgba(192,107,90,0.08)',
          border: '1px solid #C06B5A',
          borderRadius: 6,
          padding: '12px 16px',
          marginBottom: 16,
          color: '#C06B5A',
        }}>
          <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>⚠ 数据异常</div>
          {portfolio.warnings.map((w, i) => (
            <div key={i} style={{ fontSize: 13, fontFamily: "'LXGW WenKai', serif" }}>{w}</div>
          ))}
        </div>
      )}

      {tab === 'portfolio' && (
        <>
          {portfolio && <PortfolioView portfolio={portfolio} hidden={hidden} />}
          {attribution && <AttributionPanel attribution={attribution} />}
        </>
      )}
      {tab === 'market-pulse' && <MarketPulseView />}
      {tab === 'retirement' && <RetirementCalculator hidden={hidden} />}
    </div>
  )
}
