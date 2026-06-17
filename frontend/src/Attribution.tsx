import { Attribution } from './api'

interface Props { attribution: Attribution }

export default function AttributionPanel({ attribution }: Props) {
  if (!attribution.text) {
    return (
      <div style={{
        marginTop: 24, background: '#f9fafb', border: '1px solid #e5e7eb',
        borderRadius: 8, padding: 20, color: '#9ca3af', fontSize: 13,
      }}>
        AI 解释将在第二次同步后生成（需要两期数据对比）
      </div>
    )
  }

  return (
    <div style={{ marginTop: 24, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: 20 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: '#1d4ed8' }}>AI 表现解释</h2>
        {attribution.period_start && attribution.period_end && (
          <span style={{ fontSize: 11, color: '#93c5fd' }}>
            {attribution.period_start} → {attribution.period_end}
          </span>
        )}
      </div>
      <p style={{ fontSize: 15, lineHeight: 1.8, color: '#1e3a5f' }}>
        {attribution.text}
      </p>
      {attribution.generated_at && (
        <p style={{ marginTop: 12, fontSize: 11, color: '#93c5fd' }}>
          生成于 {new Date(attribution.generated_at).toLocaleString('zh-CN')}
        </p>
      )}
    </div>
  )
}
