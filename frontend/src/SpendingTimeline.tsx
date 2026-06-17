import { useState, useRef, useEffect, useLayoutEffect, useCallback, forwardRef } from 'react'
import type { SpendingPhase, SpendingItem } from './retirement'
import { phaseMonthlyTotal, phaseLumpSums } from './retirement'

// ─── Constants ────────────────────────────────────────────────────────────────

const PHASE_COLORS = ['#3A3530', '#4A3828', '#2E3A30', '#3A2E3A']
const TIMELINE_HEIGHT = 68
const MIN_PHASE_YEARS = 2

function phaseColor(index: number): string {
  return PHASE_COLORS[index % PHASE_COLORS.length]
}

function fmt(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n)
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  phases: SpendingPhase[]
  currentAge: number
  maxAge: number
  onChange: (phases: SpendingPhase[]) => void
}

// ─── SpendingTimeline ─────────────────────────────────────────────────────────

export default function SpendingTimeline({ phases, currentAge, maxAge, onChange }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)

  // Drag state stored in a ref so event listeners always see fresh values
  const dragRef = useRef<{
    handleIndex: number
    startX: number
    initialPhases: SpendingPhase[]
    moved: boolean
  } | null>(null)

  // Edit popover state
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editItems, setEditItems] = useState<EditItem[]>([])
  const [editExcessInflation, setEditExcessInflation] = useState<string>('')  // '' = 0, flat in today's dollars
  const [popoverPos, setPopoverPos] = useState<{ left: number; top: number; anchorTop?: number; anchorBottom?: number }>({ left: 0, top: 0 })
  const popoverRef = useRef<HTMLDivElement>(null)

  const totalSpan = maxAge - currentAge

  // ── Drag ──────────────────────────────────────────────────────────────────

  const startDrag = useCallback((e: React.MouseEvent, handleIndex: number) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = {
      handleIndex,
      startX: e.clientX,
      initialPhases: phases.map(p => ({ ...p })),
      moved: false,
    }
  }, [phases])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current
      if (!drag || !containerRef.current) return

      const { handleIndex, startX, initialPhases } = drag
      const containerWidth = containerRef.current.offsetWidth
      const deltaPx = e.clientX - startX
      const deltaYears = Math.round(deltaPx * totalSpan / containerWidth)

      if (deltaYears !== 0) drag.moved = true

      const left = initialPhases[handleIndex]
      const right = initialPhases[handleIndex + 1]
      const initialBoundary = left.endAge

      const minBoundary = left.startAge + MIN_PHASE_YEARS
      const maxBoundary = right.endAge - MIN_PHASE_YEARS
      const newBoundary = Math.max(minBoundary, Math.min(maxBoundary, initialBoundary + deltaYears))

      const newPhases = initialPhases.map(p => ({ ...p }))
      newPhases[handleIndex] = { ...newPhases[handleIndex], endAge: newBoundary }
      newPhases[handleIndex + 1] = { ...newPhases[handleIndex + 1], startAge: newBoundary }
      onChange(newPhases)
    }

    const onUp = () => { dragRef.current = null }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [totalSpan, onChange])

  // ── Edit popover ──────────────────────────────────────────────────────────

  const openEdit = useCallback((e: React.MouseEvent, phase: SpendingPhase) => {
    // Suppress click that follows a drag
    if (dragRef.current?.moved) return

    e.stopPropagation()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const left = Math.min(rect.left, window.innerWidth - 268)
    // anchor: prefer below, flip to above after render if it overflows
    setPopoverPos({ left, top: rect.bottom + 6, anchorTop: rect.top, anchorBottom: rect.bottom })
    setEditingId(phase.id)
    setEditLabel(phase.label)
    setEditItems(phase.items.map(item => ({
      id: item.id,
      label: item.label,
      spend: String(item.monthlySpend),
      isLumpSum: item.isLumpSum ?? false,
      lumpSumAge: String(item.lumpSumAge ?? phase.startAge),
      lumpSumAmount: String(item.lumpSumAmount ?? 0),
    })))
    setEditExcessInflation(phase.excessInflationRate !== undefined && phase.excessInflationRate > 0 ? String(Math.round(phase.excessInflationRate * 1000) / 10) : '')
  }, [])

  const confirmEdit = useCallback(() => {
    if (!editingId) return
    const parsedItems: SpendingItem[] = editItems
      .map(item => item.isLumpSum
        ? {
            id: item.id,
            label: item.label.trim() || '一次性支出',
            monthlySpend: 0,
            isLumpSum: true,
            lumpSumAge: Math.max(0, parseInt(item.lumpSumAge ?? '0') || 0),
            lumpSumAmount: Math.max(0, Math.round(parseFloat(item.lumpSumAmount ?? '0') || 0)),
          }
        : {
            id: item.id,
            label: item.label.trim() || '支出',
            monthlySpend: Math.max(0, Math.round(parseFloat(item.spend) || 0)),
          }
      )
      .filter(item => item.isLumpSum ? (item.lumpSumAmount ?? 0) > 0 : item.monthlySpend > 0 || editItems.length === 1)
    if (parsedItems.length === 0) parsedItems.push({ id: `item-${Date.now()}`, label: '支出', monthlySpend: 0 })
    const parsedExcess = parseFloat(editExcessInflation)
    const excessInflationRate = !isNaN(parsedExcess) && parsedExcess > 0
      ? parsedExcess / 100
      : undefined
    onChange(phases.map(p =>
      p.id === editingId
        ? { ...p, label: editLabel.trim() || p.label, items: parsedItems, excessInflationRate }
        : p
    ))
    setEditingId(null)
  }, [editingId, editLabel, editItems, phases, onChange])

  const cancelEdit = useCallback(() => setEditingId(null), [])

  const deletePhase = useCallback((id: string) => {
    if (phases.length <= 1) return
    const idx = phases.findIndex(p => p.id === id)
    const newPhases = phases.filter(p => p.id !== id)

    if (idx < phases.length - 1) {
      // Merge deleted phase duration into right-adjacent
      newPhases[idx] = { ...newPhases[idx], startAge: phases[idx].startAge }
    } else {
      // Last phase: merge into left-adjacent
      newPhases[newPhases.length - 1] = {
        ...newPhases[newPhases.length - 1],
        endAge: phases[idx].endAge,
      }
    }
    onChange(newPhases)
    setEditingId(null)
  }, [phases, onChange])

  // After popover renders (or items change), measure actual height and reposition if overflowing
  useLayoutEffect(() => {
    if (!editingId || !popoverRef.current) return
    const el = popoverRef.current
    const elRect = el.getBoundingClientRect()
    const overflow = elRect.bottom - (window.innerHeight - 8)
    if (overflow > 0) {
      setPopoverPos(prev => {
        const aboveTop = (prev.anchorTop ?? prev.top) - elRect.height - 6
        return { ...prev, top: Math.max(8, aboveTop) }
      })
    }
  }, [editingId, editItems])

  // Close popover on outside click (without saving)
  useEffect(() => {
    if (!editingId) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        cancelEdit()
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [editingId, cancelEdit])

  // ── Add phase (split last) ─────────────────────────────────────────────────

  const addPhase = useCallback(() => {
    const last = phases[phases.length - 1]
    if (last.endAge - last.startAge < MIN_PHASE_YEARS * 2) return
    const mid = Math.round((last.startAge + last.endAge) / 2)
    onChange([
      ...phases.slice(0, -1),
      { ...last, endAge: mid },
      {
        id: `phase-${Date.now()}`,
        label: '新阶段',
        startAge: mid,
        endAge: last.endAge,
        items: last.items.map(item => ({ ...item, id: `${item.id}-copy` })),
      },
    ])
  }, [phases, onChange])

  const lastPhase = phases[phases.length - 1]
  const canAdd = !!lastPhase && (lastPhase.endAge - lastPhase.startAge >= MIN_PHASE_YEARS * 2)

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Timeline bar */}
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          height: TIMELINE_HEIGHT,
          display: 'flex',
          borderRadius: 6,
          overflow: 'visible',
          userSelect: 'none',
        }}
      >
        {phases.map((phase, i) => {
          const widthPct = (phase.endAge - phase.startAge) / totalSpan * 100
          return (
            <PhaseBlock
              key={phase.id}
              phase={phase}
              widthPct={widthPct}
              color={phaseColor(i)}
              isFirst={i === 0}
              isLast={i === phases.length - 1}
              showDragHandle={i < phases.length - 1}
              onDragHandleDown={e => startDrag(e, i)}
              onClick={e => openEdit(e, phase)}
            />
          )
        })}
      </div>

      {/* Age labels */}
      <AgeLabels
        phases={phases}
        currentAge={currentAge}
        maxAge={maxAge}
        totalSpan={totalSpan}
      />

      {/* Controls */}
      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          onClick={addPhase}
          disabled={!canAdd}
          style={{
            background: 'none',
            border: `1px solid ${canAdd ? '#2A2826' : '#1A1816'}`,
            borderRadius: 4,
            cursor: canAdd ? 'pointer' : 'not-allowed',
            fontSize: 11,
            color: canAdd ? '#6B6460' : '#2A2826',
            fontFamily: "'Space Grotesk', sans-serif",
            padding: '4px 10px',
            transition: 'color 0.1s, border-color 0.1s',
          }}
        >
          + 添加阶段
        </button>
        <span style={{ fontSize: 11, color: '#3A3530', fontFamily: "'Space Grotesk', sans-serif" }}>
          点击阶段块编辑 · 拖拽分界线调整区间
        </span>
      </div>

      {/* Edit popover */}
      {editingId && (
        <EditPopover
          ref={popoverRef}
          pos={popoverPos}
          label={editLabel}
          items={editItems}
          excessInflation={editExcessInflation}
          canDelete={phases.length > 1}
          onLabelChange={setEditLabel}
          onItemsChange={setEditItems}
          onExcessInflationChange={setEditExcessInflation}
          onConfirm={confirmEdit}
          onDelete={() => deletePhase(editingId)}
        />
      )}
    </div>
  )
}

// ─── PhaseBlock ───────────────────────────────────────────────────────────────

interface PhaseBlockProps {
  phase: SpendingPhase
  widthPct: number
  color: string
  isFirst: boolean
  isLast: boolean
  showDragHandle: boolean
  onDragHandleDown: (e: React.MouseEvent) => void
  onClick: (e: React.MouseEvent) => void
}

function PhaseBlock({
  phase, widthPct, color, isFirst, isLast, showDragHandle, onDragHandleDown, onClick,
}: PhaseBlockProps) {
  const [hovered, setHovered] = useState(false)
  const borderRadius = [
    isFirst ? '6px' : '0',
    isLast  ? '6px' : '0',
    isLast  ? '6px' : '0',
    isFirst ? '6px' : '0',
  ].join(' ')

  return (
    <div
      style={{
        width: `${widthPct}%`,
        position: 'relative',
        background: color,
        filter: hovered ? 'brightness(1.18)' : 'none',
        borderRadius,
        borderLeft: isFirst ? 'none' : '1px solid rgba(255,255,255,0.04)',
        cursor: 'pointer',
        transition: 'filter 0.08s',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Text content */}
      <div style={{
        padding: '8px 10px',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        pointerEvents: 'none',
        overflow: 'hidden',
      }}>
        <div style={{
          fontSize: 11,
          color: '#E8E0D0',
          fontFamily: "'Space Grotesk', sans-serif",
          fontWeight: 500,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {phase.label}
        </div>
        <div style={{
          fontSize: 10,
          color: 'rgba(232,224,208,0.55)',
          fontFamily: "'JetBrains Mono', monospace",
          marginTop: 3,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {fmt(phaseMonthlyTotal(phase))}/月{phaseLumpSums(phase).length > 0 ? ` ·${phaseLumpSums(phase).length}笔一次性` : ''}{phase.excessInflationRate ? ` +${Math.round(phase.excessInflationRate * 1000) / 10}%` : ''}
        </div>
      </div>

      {/* Drag handle (right edge, except last phase) */}
      {showDragHandle && (
        <DragHandle onMouseDown={onDragHandleDown} />
      )}
    </div>
  )
}

// ─── DragHandle ───────────────────────────────────────────────────────────────

function DragHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onMouseDown={onMouseDown}
      onClick={e => e.stopPropagation()}  // prevent opening edit on the left phase
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'absolute',
        right: -6,
        top: 0,
        width: 12,
        height: '100%',
        cursor: 'col-resize',
        zIndex: 10,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{
        width: 2,
        height: '65%',
        background: hovered ? '#C8A96E' : 'rgba(232,224,208,0.18)',
        borderRadius: 1,
        transition: 'background 0.1s',
        pointerEvents: 'none',
      }} />
    </div>
  )
}

// ─── AgeLabels ────────────────────────────────────────────────────────────────

function AgeLabels({ phases, currentAge, maxAge, totalSpan }: {
  phases: SpendingPhase[]
  currentAge: number
  maxAge: number
  totalSpan: number
}) {
  const labelBase: React.CSSProperties = {
    position: 'absolute',
    fontSize: 10,
    color: '#6B6460',
    fontFamily: "'JetBrains Mono', monospace",
  }

  return (
    <div style={{ position: 'relative', height: 16, marginTop: 4 }}>
      {/* currentAge — left-anchored */}
      <span style={{ ...labelBase, left: 0 }}>{currentAge}</span>

      {/* Phase boundary ages — centered on each boundary */}
      {phases.slice(0, -1).map(phase => {
        const pct = (phase.endAge - currentAge) / totalSpan * 100
        return (
          <span
            key={phase.id}
            style={{ ...labelBase, left: `${pct}%`, transform: 'translateX(-50%)' }}
          >
            {phase.endAge}
          </span>
        )
      })}

      {/* maxAge — right-anchored */}
      <span style={{ ...labelBase, right: 0 }}>{maxAge}</span>
    </div>
  )
}

// ─── EditPopover ──────────────────────────────────────────────────────────────

interface EditItem {
  id: string
  label: string
  spend: string
  isLumpSum?: boolean
  lumpSumAge?: string
  lumpSumAmount?: string
}

interface EditPopoverProps {
  pos: { left: number; top: number }
  label: string
  items: EditItem[]
  excessInflation: string
  canDelete: boolean
  onLabelChange: (v: string) => void
  onItemsChange: (items: EditItem[]) => void
  onExcessInflationChange: (v: string) => void
  onConfirm: () => void
  onDelete: () => void
}

const EditPopover = forwardRef<HTMLDivElement, EditPopoverProps>(function EditPopover(
  { pos, label, items, excessInflation, canDelete, onLabelChange, onItemsChange, onExcessInflationChange, onConfirm, onDelete },
  ref,
) {
  const inputBase: React.CSSProperties = {
    background: '#0E0E0E',
    border: '1px solid #2A2826',
    borderRadius: 4,
    color: '#E8E0D0',
    fontSize: 12,
    padding: '5px 8px',
    outline: 'none',
    boxSizing: 'border-box',
    fontFamily: "'Space Grotesk', sans-serif",
  }

  const fieldLabelStyle: React.CSSProperties = {
    fontSize: 10,
    color: '#6B6460',
    fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.08em',
    textTransform: 'uppercase',
    marginBottom: 4,
    display: 'block',
  }

  const total = items.reduce((s, item) => s + (parseFloat(item.spend) || 0), 0)

  function removeItem(id: string) {
    if (items.length <= 1) return
    onItemsChange(items.filter(item => item.id !== id))
  }

  function addItem() {
    onItemsChange([...items, { id: `item-${Date.now()}`, label: '新支出', spend: '0', isLumpSum: false, lumpSumAge: '', lumpSumAmount: '0' }])
  }

  function addLumpSum() {
    onItemsChange([...items, { id: `item-${Date.now()}`, label: '一次性支出', spend: '0', isLumpSum: true, lumpSumAge: '', lumpSumAmount: '0' }])
  }

  function toggleLumpSum(id: string) {
    onItemsChange(items.map(item => item.id === id
      ? { ...item, isLumpSum: !item.isLumpSum }
      : item
    ))
  }

  function updateItem(id: string, field: keyof EditItem, value: string) {
    onItemsChange(items.map(item => item.id === id ? { ...item, [field]: value } : item))
  }

  return (
    <div
      ref={ref}
      onClick={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        zIndex: 1000,
        background: '#161616',
        border: '1px solid #2A2826',
        borderRadius: 8,
        boxShadow: '0 8px 32px rgba(0,0,0,0.65)',
        padding: '12px 14px',
        width: 260,
      }}
    >
      {/* Phase label */}
      <div style={{ marginBottom: 10 }}>
        <label style={fieldLabelStyle}>阶段名称</label>
        <input
          style={{ ...inputBase, width: '100%' }}
          value={label}
          onChange={e => onLabelChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onConfirm() }}
          placeholder="如：稳定期"
          autoFocus
        />
      </div>

      {/* Items list */}
      <label style={fieldLabelStyle}>支出项（今日美元）</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8, maxHeight: 260, overflowY: 'auto' }}>
        {items.map(item => (
          <div key={item.id} style={{ background: '#0E0E0E', border: '1px solid #2A2826', borderRadius: 4, padding: '7px 8px' }}>
            {/* Row 1: label + type toggle + delete */}
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 5 }}>
              <input
                style={{ ...inputBase, flex: 1, minWidth: 0 }}
                value={item.label}
                onChange={e => updateItem(item.id, 'label', e.target.value)}
                placeholder="描述"
              />
              <button
                onClick={() => toggleLumpSum(item.id)}
                title={item.isLumpSum ? '切换为月支出' : '切换为一次性支出'}
                style={{
                  background: item.isLumpSum ? 'rgba(200,169,110,0.12)' : 'none',
                  border: `1px solid ${item.isLumpSum ? 'rgba(200,169,110,0.4)' : '#2A2826'}`,
                  borderRadius: 3, cursor: 'pointer', fontSize: 10,
                  color: item.isLumpSum ? '#C8A96E' : '#6B6460',
                  fontFamily: "'Space Grotesk', sans-serif",
                  padding: '2px 6px', whiteSpace: 'nowrap', lineHeight: 1.5,
                }}
              >
                {item.isLumpSum ? '一次性' : '月付'}
              </button>
              {items.length > 1 && (
                <button
                  onClick={() => removeItem(item.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B6460', fontSize: 14, padding: '0 2px', lineHeight: 1 }}
                >×</button>
              )}
            </div>
            {/* Row 2: amount (+ age for lump sum) */}
            {item.isLumpSum ? (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>年龄</span>
                <input
                  style={{ ...inputBase, width: 52, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}
                  type="number" min="0" max="120" step="1"
                  value={item.lumpSumAge ?? ''}
                  onChange={e => updateItem(item.id, 'lumpSumAge', e.target.value)}
                  placeholder="岁"
                />
                <span style={{ fontSize: 10, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", whiteSpace: 'nowrap' }}>金额 $</span>
                <input
                  style={{ ...inputBase, flex: 1, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}
                  type="number" min="0" step="1000"
                  value={item.lumpSumAmount ?? '0'}
                  onChange={e => updateItem(item.id, 'lumpSumAmount', e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') onConfirm() }}
                />
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 10, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace" }}>月 $</span>
                <input
                  style={{ ...inputBase, flex: 1, fontFamily: "'JetBrains Mono', monospace", textAlign: 'right' }}
                  type="number" min="0" step="100"
                  value={item.spend}
                  onChange={e => updateItem(item.id, 'spend', e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') onConfirm() }}
                />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add item buttons + total */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 6 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={addItem}
            style={{
              background: 'none', border: '1px dashed #2A2826', borderRadius: 4,
              cursor: 'pointer', fontSize: 11, color: '#6B6460',
              fontFamily: "'Space Grotesk', sans-serif", padding: '3px 8px',
            }}
          >
            + 月付
          </button>
          <button
            onClick={addLumpSum}
            style={{
              background: 'none', border: '1px dashed rgba(200,169,110,0.3)', borderRadius: 4,
              cursor: 'pointer', fontSize: 11, color: '#C8A96E',
              fontFamily: "'Space Grotesk', sans-serif", padding: '3px 8px',
            }}
          >
            + 一次性
          </button>
        </div>
        {total > 0 && (
          <span style={{ fontSize: 11, color: '#C8A96E', fontFamily: "'JetBrains Mono', monospace" }}>
            {fmt(total)}/月
          </span>
        )}
      </div>

      {/* Per-phase excess inflation */}
      <div style={{ marginBottom: 12 }}>
        <label style={fieldLabelStyle}>超额增长率（医疗等高于市场回报的支出）</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            style={{ ...inputBase, width: 64, textAlign: 'right' }}
            type="number"
            min="0"
            max="15"
            step="0.5"
            value={excessInflation}
            onChange={e => onExcessInflationChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') onConfirm() }}
            placeholder="0"
          />
          <span style={{ fontSize: 12, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace" }}>%</span>
          {excessInflation !== '' && (
            <button
              onClick={() => onExcessInflationChange('')}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B6460', fontSize: 11, padding: '0 4px' }}
            >
              重置
            </button>
          )}
        </div>
        <div style={{ fontSize: 10, color: '#3A3530', marginTop: 2 }}>
          留空 = 今日美元不增长 · 医疗为主的阶段建议填 2–3%
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onConfirm}
          style={{
            flex: 1,
            background: 'rgba(200,169,110,0.1)',
            border: '1px solid rgba(200,169,110,0.3)',
            borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#C8A96E',
            fontFamily: "'Space Grotesk', sans-serif", padding: '5px 0',
          }}
        >
          确认
        </button>
        {canDelete && (
          <button
            onClick={onDelete}
            style={{
              background: 'rgba(192,107,90,0.08)', border: '1px solid rgba(192,107,90,0.25)',
              borderRadius: 4, cursor: 'pointer', fontSize: 12, color: '#C06B5A',
              fontFamily: "'Space Grotesk', sans-serif", padding: '5px 10px',
            }}
          >
            删除阶段
          </button>
        )}
      </div>
    </div>
  )
})
