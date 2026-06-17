import { useEffect, useState, Fragment } from 'react'
import { api, SyncLogEntry } from './api'

const SOURCE_LABEL: Record<string, string> = {
  empower: 'Empower',
}

function fmt(iso: string): string {
  const d = new Date(iso + 'Z')
  return d.toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtUSD(v: number): string {
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

export default function SyncLogPanel({ open }: { open: boolean }) {
  const [logs, setLogs] = useState<SyncLogEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    api.syncLogs()
      .then(setLogs)
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null

  return (
    <div style={{
      borderBottom: '1px solid #2A2826',
      padding: '16px 0 20px',
      marginBottom: 24,
    }}>
      <div style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace", color: '#6B6460', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
        同步日志
      </div>
      {loading && <div style={{ color: '#6B6460', fontSize: 13 }}>加载中…</div>}
      {error && <div style={{ color: '#C06B5A', fontSize: 13 }}>{error}</div>}
      {!loading && !error && logs.length === 0 && (
        <div style={{ color: '#6B6460', fontSize: 13 }}>暂无同步记录</div>
      )}
      {!loading && logs.length > 0 && (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              <th style={th}>时间</th>
              <th style={th}>来源</th>
              <th style={{ ...th, textAlign: 'right' }}>持仓条数</th>
              <th style={{ ...th, textAlign: 'right' }}>总价值</th>
              <th style={th}>状态</th>
            </tr>
          </thead>
          <tbody>
            {logs.map(log => (
              <Fragment key={log.id}>
                <tr style={{ borderBottom: '1px solid #2A2826' }}>
                  <td style={{ ...td, fontFamily: "'JetBrains Mono', monospace", color: '#6B6460' }}>{fmt(log.synced_at)}</td>
                  <td style={td}>{SOURCE_LABEL[log.source] ?? log.source}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{log.holdings_count}</td>
                  <td style={{ ...td, textAlign: 'right', fontFamily: "'JetBrains Mono', monospace" }}>{fmtUSD(log.total_value_usd)}</td>
                  <td style={td}>
                    <span style={{
                      display: 'inline-block',
                      padding: '1px 8px',
                      borderRadius: 3,
                      fontSize: 10,
                      fontFamily: "'JetBrains Mono', monospace",
                      fontWeight: 500,
                      background: log.status === 'ok' ? 'rgba(200,169,110,0.12)' : 'rgba(192,107,90,0.12)',
                      color: log.status === 'ok' ? '#C8A96E' : '#C06B5A',
                    }}>
                      {log.status === 'ok' ? 'OK' : 'WARN'}
                    </span>
                  </td>
                </tr>
                {log.warnings.length > 0 && (
                  <tr style={{ borderBottom: '1px solid #2A2826' }}>
                    <td colSpan={5} style={{ padding: '2px 8px 8px 8px', color: '#C06B5A', fontSize: 12, fontFamily: "'LXGW WenKai', serif" }}>
                      {log.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '6px 8px',
  textAlign: 'left',
  fontWeight: 400,
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  color: '#6B6460',
  borderBottom: '1px solid #2A2826',
}

const td: React.CSSProperties = {
  padding: '7px 8px',
  verticalAlign: 'top',
}
