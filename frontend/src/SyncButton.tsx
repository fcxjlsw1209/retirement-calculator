import { useState } from 'react'
import { api, SourceStatus } from './api'

interface Props {
  state: 'idle' | 'syncing' | 'reauth' | 'error'
  onSync: () => void
  onReauthComplete: () => void
  sources?: Record<string, SourceStatus>
}

export default function SyncButton({ state, onSync, onReauthComplete, sources }: Props) {
  const [otp, setOtp] = useState('')
  const [otpError, setOtpError] = useState('')
  const [showOtpModal, setShowOtpModal] = useState(false)
  const [otpSending, setOtpSending] = useState(false)

  const handleSyncClick = async () => {
    if (state === 'reauth') {
      // Start auth flow first
      setOtpSending(true)
      try {
        const r = await api.authStart()
        if (r.status === 'complete') {
          onReauthComplete()
        } else {
          setShowOtpModal(true)
        }
      } finally {
        setOtpSending(false)
      }
    } else {
      onSync()
    }
  }

  const handleOtpSubmit = async () => {
    if (!otp.trim()) return
    setOtpError('')
    setOtpSending(true)
    try {
      await api.authOtp(otp.trim())
      setShowOtpModal(false)
      setOtp('')
      onReauthComplete()
    } catch (e: any) {
      setOtpError(e.message || '验证码错误，请重试')
    } finally {
      setOtpSending(false)
    }
  }

  const buttonLabel = {
    idle: '同步',
    syncing: '同步中…',
    reauth: '重新登录',
    error: '重试',
  }[state]

  const staleSource = sources && Object.entries(sources).find(([, s]) => s.status === 'error')

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {staleSource && (
          <span style={{ fontSize: 12, color: '#f59e0b' }}>
            {staleSource[0]} 数据过期
          </span>
        )}
        <button
          onClick={handleSyncClick}
          disabled={state === 'syncing' || otpSending}
          style={{
            padding: '8px 16px',
            background: state === 'reauth' ? '#f59e0b' : '#3b82f6',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            fontWeight: 500,
            opacity: state === 'syncing' ? 0.7 : 1,
          }}
        >
          {buttonLabel}
        </button>
      </div>

      {/* OTP Modal */}
      {showOtpModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50,
        }}>
          <div style={{
            background: '#fff', borderRadius: 10, padding: 28, width: 360,
            boxShadow: '0 20px 60px rgba(0,0,0,0.2)',
          }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>Empower 二步验证</h2>
            <p style={{ color: '#6b7280', marginBottom: 16, fontSize: 13 }}>
              已发送验证码到你的手机，请输入：
            </p>
            <input
              type="text"
              value={otp}
              onChange={e => setOtp(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleOtpSubmit()}
              placeholder="6位验证码"
              maxLength={8}
              autoFocus
              style={{
                width: '100%', padding: '10px 12px', border: '1px solid #d1d5db',
                borderRadius: 6, fontSize: 18, letterSpacing: 4, textAlign: 'center',
                marginBottom: 8,
              }}
            />
            {otpError && <p style={{ color: '#dc2626', fontSize: 12, marginBottom: 8 }}>{otpError}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                onClick={() => { setShowOtpModal(false); setOtp(''); setOtpError('') }}
                style={{ flex: 1, padding: '10px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff' }}
              >
                取消
              </button>
              <button
                onClick={handleOtpSubmit}
                disabled={!otp.trim() || otpSending}
                style={{ flex: 2, padding: '10px', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontWeight: 500 }}
              >
                {otpSending ? '验证中…' : '确认'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
