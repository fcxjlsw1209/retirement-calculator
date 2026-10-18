import { useState, useEffect, useCallback, useRef } from 'react'
import { ScenarioSaveQueue, type ScenarioPatch } from './scenarioSaveQueue'
import { useRetirementData } from './RetirementAccountTagger'
import RetirementAccountTagger from './RetirementAccountTagger'
import SpendingTimeline from './SpendingTimeline'
import RetirementChart, { OutputCards, YearlyTable } from './RetirementChart'
import { runMonteCarlo, fitSpendingPhases, ASSET_PARAMS, type SpendingPhase, type MonteCarloResult, type CustomAsset, type SocialSecurity } from './retirement'

function migratePhase(p: SpendingPhase & { monthlySpend?: number }): SpendingPhase {
  const base = p.items ? p : {
    id: p.id, label: p.label, startAge: p.startAge, endAge: p.endAge,
    items: [{ id: `${p.id}-item`, label: '生活费', monthlySpend: p.monthlySpend ?? 0 }],
  }
  // The current editor includes every phase in the displayed retirement budget.
  return { ...base, isPlanned: false }
}
import { api, type RetirementScenario } from './api'

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_RETIREMENT_AGE = 65
const DEFAULT_MAX_AGE = 90
const DEFAULT_MONTHLY_CONTRIBUTION = 3_000
const DEFAULT_INFLATION_RATE = 0.025
const DEFAULT_TAX_RATE = 0.22
const SIM_COUNT = 1_000
const DEBOUNCE_MS = 300

function makeDefaultPhases(retirementAge: number, maxAge: number): SpendingPhase[] {
  return [
    { id: 'phase-default', label: '退休生活', startAge: retirementAge, endAge: maxAge,
      items: [{ id: 'item-default', label: '生活费', monthlySpend: 5_000 }] },
  ]
}

interface ScenarioPayload {
  phases: SpendingPhase[]
  customAssets?: CustomAsset[]
  socialSecurity?: SocialSecurity[]
  inflationRate?: number
}

function parsePayload(json: string): ScenarioPayload {
  try {
    const parsed = JSON.parse(json)
    // Legacy: plain array of phases
    if (Array.isArray(parsed)) {
      return { phases: parsed.map(migratePhase) }
    }
    // New: { phases, customAssets }
    return {
      phases: (parsed.phases as SpendingPhase[]).map(migratePhase),
      customAssets: parsed.customAssets ?? [],
      socialSecurity: parsed.socialSecurity ?? [],
      inflationRate: parsed.inflationRate,
    }
  } catch {
    return { phases: makeDefaultPhases(DEFAULT_RETIREMENT_AGE, DEFAULT_MAX_AGE), customAssets: [] }
  }
}

function serializePayload(phases: SpendingPhase[], customAssets: CustomAsset[], socialSecurity: SocialSecurity[], inflationRate: number): string {
  return JSON.stringify({ phases, customAssets, socialSecurity, inflationRate })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_POST_RETIREMENT_EQUITY = 0.6

function inputStyle(error?: boolean): React.CSSProperties {
  return {
    background: '#0E0E0E',
    border: `1px solid ${error ? '#C06B5A' : '#2A2826'}`,
    borderRadius: 4,
    color: '#E8E0D0',
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    padding: '6px 10px',
    outline: 'none',
    width: 80,
    textAlign: 'right' as const,
  }
}

function labelStyle(): React.CSSProperties {
  return {
    fontSize: 11,
    color: '#6B6460',
    fontFamily: "'Space Grotesk', sans-serif",
    marginBottom: 4,
    display: 'block',
  }
}

// ─── ScenarioBar ──────────────────────────────────────────────────────────────

interface ScenarioBarProps {
  scenarios: RetirementScenario[]
  activeId: number | null
  onSwitch: (id: number) => void
  onCreate: () => void
  onDuplicate: () => void
  onDelete: (id: number) => void
  onRename: (id: number, name: string) => void
}

function ScenarioBar({ scenarios, activeId, onSwitch, onCreate, onDuplicate, onDelete, onRename }: ScenarioBarProps) {
  const [renaming, setRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Reset confirmation when active scenario changes
  useEffect(() => { setConfirmingDelete(false) }, [activeId])

  const startRename = useCallback(() => {
    const active = scenarios.find(s => s.id === activeId)
    if (!active) return
    setRenameValue(active.name)
    setRenaming(true)
    setTimeout(() => renameInputRef.current?.select(), 0)
  }, [scenarios, activeId])

  const confirmRename = useCallback(() => {
    if (activeId !== null && renameValue.trim()) {
      onRename(activeId, renameValue.trim())
    }
    setRenaming(false)
  }, [activeId, renameValue, onRename])

  const cancelRename = useCallback(() => setRenaming(false), [])

  const btnStyle: React.CSSProperties = {
    background: 'none', border: '1px solid #2A2826', borderRadius: 4,
    color: '#6B6460', fontSize: 12, fontFamily: "'Space Grotesk', sans-serif",
    padding: '5px 10px', cursor: 'pointer',
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 24, flexWrap: 'wrap' }}>
      <span style={{
        fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace",
        letterSpacing: '0.08em', textTransform: 'uppercase', flexShrink: 0,
      }}>
        方案
      </span>

      {renaming ? (
        <input
          ref={renameInputRef}
          value={renameValue}
          onChange={e => setRenameValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') confirmRename(); if (e.key === 'Escape') cancelRename() }}
          onBlur={confirmRename}
          style={{
            background: '#161616', border: '1px solid #C8A96E', borderRadius: 4,
            color: '#E8E0D0', fontSize: 13, fontFamily: "'Space Grotesk', sans-serif",
            padding: '5px 10px', outline: 'none', minWidth: 140,
          }}
        />
      ) : (
        <select aria-label="退休方案"
          value={activeId ?? ''}
          onChange={e => { setConfirmingDelete(false); onSwitch(Number(e.target.value)) }}
          style={{
            background: '#161616', border: '1px solid #2A2826', borderRadius: 4,
            color: '#E8E0D0', fontSize: 13, fontFamily: "'Space Grotesk', sans-serif",
            padding: '5px 10px', cursor: 'pointer', outline: 'none', minWidth: 140,
          }}
        >
          {scenarios.map(s => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      )}

      {!renaming && !confirmingDelete && (
        <button onClick={startRename} title="重命名当前方案" style={btnStyle}>改名</button>
      )}
      {!renaming && !confirmingDelete && (
        <button onClick={onDuplicate} title="复制当前方案" style={btnStyle}>复制</button>
      )}
      {!confirmingDelete && (
        <button onClick={onCreate} title="新建空白方案" style={btnStyle}>+ 新建</button>
      )}
      {scenarios.length > 1 && activeId !== null && !renaming && (
        confirmingDelete ? (
          <>
            <span style={{
              fontSize: 12, color: '#C06B5A',
              fontFamily: "'Space Grotesk', sans-serif", flexShrink: 0,
            }}>
              确认删除？
            </span>
            <button
              onClick={() => { setConfirmingDelete(false); onDelete(activeId) }}
              style={{ ...btnStyle, border: '1px solid rgba(192,107,90,0.6)', color: '#C06B5A' }}
            >
              确定
            </button>
            <button onClick={() => setConfirmingDelete(false)} style={btnStyle}>
              取消
            </button>
          </>
        ) : (
          <button
            onClick={() => setConfirmingDelete(true)}
            style={{ ...btnStyle, border: '1px solid rgba(192,107,90,0.3)', color: '#C06B5A' }}
          >
            删除
          </button>
        )
      )}
    </div>
  )
}

// ─── RetirementCalculator ─────────────────────────────────────────────────────

interface Props { hidden: boolean }

export default function RetirementCalculator({ hidden }: Props) {
  const data = useRetirementData()

  // ── Scenarios ─────────────────────────────────────────────────────────────

  const [scenarios, setScenarios] = useState<RetirementScenario[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [scenariosLoading, setScenariosLoading] = useState(true)
  const [scenarioLoadError, setScenarioLoadError] = useState(false)

  // Load scenarios on mount; create default if none exist
  useEffect(() => {
    api.retirement.scenarios.list().then(async list => {
      if (list.length === 0) {
        const defaultPhases = makeDefaultPhases(DEFAULT_RETIREMENT_AGE, DEFAULT_MAX_AGE)
        const created = await api.retirement.scenarios.create({
          name: '默认方案',
          current_age: 0,
          retirement_age: DEFAULT_RETIREMENT_AGE,
          max_age: DEFAULT_MAX_AGE,
          monthly_contribution: DEFAULT_MONTHLY_CONTRIBUTION,
          phases_json: JSON.stringify(defaultPhases),
          withdrawal_tax_rate: DEFAULT_TAX_RATE,
        })
        setScenarios([created])
        setActiveId(created.id)
      } else {
        setScenarios(list)
        setActiveId(list[0].id)  // list is sorted by updated_at desc
      }
      setScenariosLoading(false)
    }).catch(() => { setScenarioLoadError(true); setScenariosLoading(false) })
  }, [])

  // ── User inputs ──────────────────────────────────────────────────────────

  const [currentAgeStr, setCurrentAgeStr] = useState('')
  const [retirementAge, setRetirementAge] = useState(DEFAULT_RETIREMENT_AGE)
  const [maxAge, setMaxAge] = useState(DEFAULT_MAX_AGE)
  const [monthlyContribution, setMonthlyContribution] = useState(DEFAULT_MONTHLY_CONTRIBUTION)
  const [withdrawalTaxRate, setWithdrawalTaxRate] = useState(DEFAULT_TAX_RATE)
  const [postRetirementEquity, setPostRetirementEquity] = useState(DEFAULT_POST_RETIREMENT_EQUITY)
  const [inflationRate, setInflationRate] = useState(DEFAULT_INFLATION_RATE)
  const [phases, setPhases] = useState<SpendingPhase[]>(
    makeDefaultPhases(DEFAULT_RETIREMENT_AGE, DEFAULT_MAX_AGE)
  )
  const [customAssets, setCustomAssets] = useState<CustomAsset[]>([])
  const [socialSecurity, setSocialSecurity] = useState<SocialSecurity[]>([])

  // Load active scenario params into state when active scenario changes
  const [loadedId, setLoadedId] = useState<number | null>(null)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'error'>('saved')
  const [operationBusy, setOperationBusy] = useState(false)
  const operationRef = useRef(false)
  const saver = useRef(new ScenarioSaveQueue(api.retirement.scenarios.update))
  const draftRef = useRef<{ id: number; patch: ScenarioPatch } | null>(null)
  useEffect(() => {
    if (activeId === null) return
    const s = scenarios.find(x => x.id === activeId)
    if (!s) return
    setCurrentAgeStr(s.current_age > 0 ? String(s.current_age) : '')
    setRetirementAge(s.retirement_age)
    setMaxAge(s.max_age)
    setMonthlyContribution(s.monthly_contribution)
    setWithdrawalTaxRate(s.withdrawal_tax_rate ?? DEFAULT_TAX_RATE)
    setPostRetirementEquity(s.post_retirement_equity_pct ?? DEFAULT_POST_RETIREMENT_EQUITY)
    const payload = parsePayload(s.phases_json)
    setPhases(payload.phases)
    setCustomAssets(payload.customAssets ?? [])
    setSocialSecurity(payload.socialSecurity ?? [])
    setInflationRate(payload.inflationRate ?? DEFAULT_INFLATION_RATE)
    saver.current.acknowledge(s.id, {
      current_age: s.current_age,
      retirement_age: s.retirement_age,
      max_age: s.max_age,
      monthly_contribution: s.monthly_contribution,
      phases_json: serializePayload(payload.phases, payload.customAssets ?? [], payload.socialSecurity ?? [], payload.inflationRate ?? DEFAULT_INFLATION_RATE),
      withdrawal_tax_rate: s.withdrawal_tax_rate ?? DEFAULT_TAX_RATE,
      post_retirement_equity_pct: s.post_retirement_equity_pct ?? DEFAULT_POST_RETIREMENT_EQUITY,
    })
    prevRetirementAge.current = s.retirement_age
    prevMaxAge.current = s.max_age
    setLoadedId(s.id)
    setSaveStatus('saved')
  }, [activeId]) // eslint-disable-line react-hooks/exhaustive-deps

  const currentAge = parseInt(currentAgeStr, 10)
  const currentAgeValid = !isNaN(currentAge) && currentAge >= 18 && currentAge <= retirementAge
  const retirementAgeValid = retirementAge >= (currentAgeValid ? currentAge : 0) && retirementAge < maxAge

  // Keep phases clamped to retirementAge/maxAge when those change
  const prevRetirementAge = useRef(retirementAge)
  const prevMaxAge = useRef(maxAge)

  useEffect(() => {
    if (loadedId !== activeId) return
    const retAgeChanged = retirementAge !== prevRetirementAge.current
    const maxAgeChanged = maxAge !== prevMaxAge.current
    prevRetirementAge.current = retirementAge
    prevMaxAge.current = maxAge

    if (!retAgeChanged && !maxAgeChanged) return

    setPhases(prev => {
      if (prev.length === 0) return makeDefaultPhases(retirementAge, maxAge)
      return fitSpendingPhases(prev, retirementAge, maxAge)
    })
  }, [retirementAge, maxAge, loadedId, activeId])

  // ── Auto-save ────────────────────────────────────────────────────────────

  const draft: ScenarioPatch = {
    current_age: Number.isFinite(currentAge) ? currentAge : 0,
    retirement_age: retirementAge,
    max_age: maxAge,
    monthly_contribution: monthlyContribution,
    phases_json: serializePayload(phases, customAssets, socialSecurity, inflationRate),
    withdrawal_tax_rate: withdrawalTaxRate,
    post_retirement_equity_pct: postRetirementEquity,
  }
  draftRef.current = activeId !== null && loadedId === activeId ? { id: activeId, patch: draft } : null
  const draftSignature = JSON.stringify(draftRef.current)

  const saveScenario = useCallback(async (): Promise<boolean> => {
    const current = draftRef.current
    if (!current || saver.current.isSaved(current.id, current.patch)) return true
    setSaveStatus('saving')
    try {
      const updated = await saver.current.save(current.id, current.patch)
      if (updated) setScenarios(prev => prev.map(s => s.id === updated.id ? updated : s))
      const latest = draftRef.current
      if (latest && saver.current.isSaved(latest.id, latest.patch)) setSaveStatus('saved')
      return true
    } catch {
      setSaveStatus('error')
      return false
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { void saveScenario() }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [draftSignature, saveScenario])

  useEffect(() => () => {
    const latest = draftRef.current
    if (latest) void saver.current.save(latest.id, latest.patch).catch(() => {})
  }, [])

  useEffect(() => {
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      const latest = draftRef.current
      if (latest && !saver.current.isSaved(latest.id, latest.patch)) {
        event.preventDefault()
        event.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warnUnsaved)
    return () => window.removeEventListener('beforeunload', warnUnsaved)
  }, [])

  async function performOperation(operation: () => Promise<void>) {
    if (operationRef.current) return
    operationRef.current = true
    setOperationBusy(true)
    try {
      do {
        if (!await saveScenario()) return
      } while (draftRef.current && !saver.current.isSaved(draftRef.current.id, draftRef.current.patch))
      await operation()
    } catch {
      setSaveStatus('error')
    } finally {
      operationRef.current = false
      setOperationBusy(false)
    }
  }

  const handleSwitch = (id: number) => { void performOperation(async () => { setActiveId(id) }) }
  const handleCreate = () => { void performOperation(async () => {
    const created = await api.retirement.scenarios.create({
      name: `方案 ${scenarios.length + 1}`,
      current_age: 0, retirement_age: DEFAULT_RETIREMENT_AGE, max_age: DEFAULT_MAX_AGE,
      monthly_contribution: DEFAULT_MONTHLY_CONTRIBUTION,
      phases_json: JSON.stringify(makeDefaultPhases(DEFAULT_RETIREMENT_AGE, DEFAULT_MAX_AGE)),
      withdrawal_tax_rate: DEFAULT_TAX_RATE, post_retirement_equity_pct: DEFAULT_POST_RETIREMENT_EQUITY,
    })
    setScenarios(prev => [created, ...prev])
    setActiveId(created.id)
  }) }
  const handleDuplicate = () => { void performOperation(async () => {
    const active = scenarios.find(s => s.id === activeId)
    const latest = draftRef.current
    if (!active || !latest) return
    const { id: _id, created_at: _created, updated_at: _updated, ...original } = active
    const created = await api.retirement.scenarios.create({ ...original, ...latest.patch, name: `${active.name} 副本` })
    setScenarios(prev => [created, ...prev])
    setActiveId(created.id)
  }) }
  const handleDelete = (id: number) => { void performOperation(async () => {
    await api.retirement.scenarios.delete(id)
    const remaining = scenarios.filter(s => s.id !== id)
    setScenarios(remaining)
    setActiveId(remaining[0]?.id ?? null)
  }) }
  const handleRename = (id: number, name: string) => { void performOperation(async () => {
    const updated = await api.retirement.scenarios.update(id, { name })
    setScenarios(prev => prev.map(s => s.id === updated.id ? updated : s))
  }) }

  // ── Monte Carlo ───────────────────────────────────────────────────────────

  const [mcResult, setMcResult] = useState<MonteCarloResult | null>(null)
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const runSim = useCallback(() => {
    if (!currentAgeValid || !retirementAgeValid || data.loading || monthlyContribution < 0) { setMcResult(null); return }

    try {
      const result = runMonteCarlo({
        currentAge,
        retirementAge,
        maxAge,
        taxableBalance: data.taxableTotal,
        retirementBalance: data.retirementTotal,
        monthlyContribution,
        holdingWeights: data.holdingWeights,
        customAssets,
        socialSecurity,
        inflationRate,
        effectiveTaxRate: withdrawalTaxRate,
        spendingPhases: phases,
        simCount: SIM_COUNT,
        postRetirementEquityPct: postRetirementEquity,
      })
      setMcResult(result)
    } catch { setMcResult(null) }
  }, [
    currentAgeValid, retirementAgeValid, data.loading,
    currentAge, retirementAge, maxAge,
    data.taxableTotal, data.retirementTotal,
    monthlyContribution, data.holdingWeights, customAssets, socialSecurity, inflationRate, phases, withdrawalTaxRate, postRetirementEquity,
  ])

  useEffect(() => {
    setMcResult(null)
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(runSim, DEBOUNCE_MS)
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current) }
  }, [runSim])

  // ── Loading / error states ────────────────────────────────────────────────

  if (data.loading || scenariosLoading) {
    return (
      <div style={{ padding: '48px 0', textAlign: 'center', color: '#6B6460', fontSize: 13 }}>
        加载中…
      </div>
    )
  }

  if (data.error || scenarioLoadError) {
    return (
      <div style={{
        background: 'rgba(192,107,90,0.1)', border: '1px solid #C06B5A',
        borderRadius: 6, padding: '12px 16px', color: '#C06B5A', fontSize: 13,
      }}>
        加载失败：{data.error ?? '未能读取退休方案，请刷新页面重试。'}
      </div>
    )
  }

  if (hidden) return <p style={{ color: '#6B6460', padding: '24px 0' }}>金额已隐藏。点击顶部金额开关后查看或编辑退休方案。</p>

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <fieldset disabled={operationBusy} style={{ padding: 0, paddingBottom: 64, border: 0, margin: 0, minWidth: 0 }}>
      {/* Page title */}
      <div style={{ marginBottom: 24 }}>
        <h2 style={{
          margin: 0,
          fontSize: 22,
          fontWeight: 600,
          color: '#E8E0D0',
          fontFamily: "'Space Grotesk', sans-serif",
          letterSpacing: '-0.01em',
        }}>
          退休计算器
        </h2>
        <p style={{
          margin: '4px 0 0',
          fontSize: 12,
          color: '#6B6460',
          fontFamily: "'Space Grotesk', sans-serif",
        }}>
          基于当前持仓，预测不同消费阶段下的退休资产轨迹
        </p>
      </div>

      {/* Scenario bar */}
      <ScenarioBar
        scenarios={scenarios}
        activeId={activeId}
        onSwitch={handleSwitch}
        onCreate={handleCreate}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
        onRename={handleRename}
      />

      <div role="status" style={{ fontSize: 12, color: saveStatus === 'error' ? '#C06B5A' : '#6B6460', marginBottom: 16 }}>
        {saveStatus === 'saving' ? '保存中…' : saveStatus === 'error' ? '保存或操作失败，当前修改仍保留在页面中。' : draftRef.current && !saver.current.isSaved(draftRef.current.id, draftRef.current.patch) ? '尚未保存…' : '已保存'}
        {saveStatus === 'error' && <button onClick={() => { void saveScenario() }} style={stepBtnStyle}>重试保存</button>}
      </div>
      {mcResult && <OutputCards result={mcResult} retirementAge={retirementAge} />}
      <p style={{ fontSize: 12, color: '#6B6460', lineHeight: 1.7 }}>
        成功率按完整支出预算计算，不自动削减开支；金额均为今日购买力。相同参数使用相同的 1,000 条随机路径。
        资金缺口是按平均回报折现的参考值，不是安全退休门槛。
      </p>
      <details style={{ fontSize: 12, color: '#6B6460', marginBottom: 16, lineHeight: 1.7 }}>
        <summary style={{ cursor: 'pointer' }}>计算假设与数据来源</summary>
        <p>按年模拟，年初支出、年末投入。股债冲击按同一历史年份抽样，再缩放至假设的均值与波动率；不代表预测收益。</p>
        <p>退休后权益假设：实际年均 {ASSET_PARAMS.equity.mean * 100}%，波动率 {ASSET_PARAMS.equity.std * 100}%；债券：实际年均 {ASSET_PARAMS.bond.mean * 100}%，波动率 {ASSET_PARAMS.bond.std * 100}%。通胀基准为 2.5%。</p>
        <p>社保金额按今日购买力，先抵扣支出；净支出再按综合税率折算。尚未逐项模拟 Roth、RMD、提前提款例外和房产出售税费。</p>
        <a href="https://pages.stern.nyu.edu/~adamodar/New_Home_Page/datafile/histretSP.html" target="_blank" rel="noreferrer" style={{ color: '#C8A96E' }}>NYU 历史收益数据（1928–2025，已逐年扣除通胀）</a>
      </details>
      {mcResult && mcResult.earlyWithdrawalRate > 0 && <p style={{ color: '#C06B5A', fontSize: 12 }}>
        {Math.round(mcResult.earlyWithdrawalRate * 100)}% 的路径需要在 60 岁前动用退休账户。成功率尚未扣除提前提款税费，也未验证提款资格，需另行安排过渡资金。
      </p>}
      {/* No-sync banner */}
      {data.noSync && (
        <div style={{
          background: 'rgba(200,169,110,0.06)',
          border: '1px solid rgba(200,169,110,0.2)',
          borderRadius: 6, padding: '10px 14px', marginBottom: 20,
          fontSize: 12, color: '#C8A96E',
          fontFamily: "'Space Grotesk', sans-serif",
        }}>
          尚未同步数据，回报率使用默认值（均衡组合 6%/年），建议先同步 Empower。
        </div>
      )}

      {/* ── Section: 当前资产 ── */}
      <Section title="当前资产（来自最新同步）">
        {data.tagSaveError && <p role="alert" style={{ color: '#C06B5A', fontSize: 12 }}>
          账户标记未保存。<button onClick={() => data.setTags(data.tags)} style={stepBtnStyle}>重试</button>
        </p>}
        <RetirementAccountTagger
          accounts={data.accounts}
          tags={data.tags}
          onTagsChange={data.setTags}
          taxableTotal={data.taxableTotal}
          retirementTotal={data.retirementTotal}
          hidden={hidden}
        />
      </Section>

      {/* ── Section: 其他资产 ── */}
      <Section title="其他资产（房产、私募等）">
        <CustomAssetEditor assets={customAssets} onChange={setCustomAssets} />
      </Section>

      {/* ── Section: 社保收入 ── */}
      <Section title="社保收入（Social Security）">
        <SSEditor entries={socialSecurity} onChange={setSocialSecurity} />
      </Section>

      {/* ── Section: 基本参数 ── */}
      <Section title="基本参数">
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <Field label="当前年龄">
            <input aria-label="当前年龄"
              style={inputStyle(!currentAgeValid && currentAgeStr !== '')}
              type="number"
              min="18"
              max="79"
              value={currentAgeStr}
              onChange={e => setCurrentAgeStr(e.target.value)}
              placeholder="—"
            />
            {!currentAgeValid && currentAgeStr !== '' && (
              <div style={{ fontSize: 10, color: '#C06B5A', marginTop: 2 }}>18–{retirementAge}</div>
            )}
          </Field>

          <Field label="退休年龄">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <button
                onClick={() => setRetirementAge(a => Math.max((currentAgeValid ? currentAge : 20), a - 1))}
                style={{ ...stepBtnStyle, borderRadius: '4px 0 0 4px' }}
              >−</button>
              <input aria-label="退休年龄"
                style={{ ...inputStyle(!retirementAgeValid), borderRadius: 0, borderLeft: 'none', borderRight: 'none', width: 52, textAlign: 'center' }}
                type="number"
                min={currentAgeValid ? currentAge : 20}
                max={maxAge - 1}
                value={retirementAge}
                onChange={e => setRetirementAge(parseInt(e.target.value, 10) || DEFAULT_RETIREMENT_AGE)}
              />
              <button
                onClick={() => setRetirementAge(a => Math.min(maxAge - 1, a + 1))}
                style={{ ...stepBtnStyle, borderRadius: '0 4px 4px 0' }}
              >+</button>
            </div>
            <div style={{ fontSize: 10, color: '#6B6460', marginTop: 2 }}>设为当前年龄，可测算现在退休</div>
          </Field>

          <Field label="预期寿命">
            <input aria-label="预期寿命"
              style={inputStyle()}
              type="number"
              min={retirementAge + 1}
              max="150"
              value={maxAge}
              onChange={e => setMaxAge(parseInt(e.target.value, 10) || DEFAULT_MAX_AGE)}
            />
          </Field>

          <Field label="退休前月投入">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#6B6460', fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>$</span>
              <input aria-label="退休前月投入"
                style={{ ...inputStyle(), width: 96 }}
                type="number"
                min="0"
                step="100"
                value={monthlyContribution}
                onChange={e => setMonthlyContribution(parseInt(e.target.value, 10) || 0)}
              />
            </div>
          </Field>

          <Field label="通胀率假设">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input aria-label="通胀率假设"
                style={{ ...inputStyle(), width: 64 }}
                type="number"
                min="0"
                max="15"
                step="0.5"
                value={Math.round(inflationRate * 1000) / 10}
                onChange={e => {
                  const v = parseFloat(e.target.value)
                  if (!isNaN(v) && v >= 0 && v <= 15) setInflationRate(v / 100)
                }}
              />
              <span style={{ color: '#6B6460', fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>%</span>
            </div>
            <div style={{ fontSize: 10, color: '#3A3530', marginTop: 2 }}>影响实际投资回报率</div>
          </Field>

          <Field label="综合提取税率">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input aria-label="综合提取税率"
                style={{ ...inputStyle(), width: 64 }}
                type="number"
                min="0"
                max="60"
                step="1"
                value={Math.round(withdrawalTaxRate * 100)}
                onChange={e => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 0 && v <= 60) setWithdrawalTaxRate(v / 100)
                }}
              />
              <span style={{ color: '#6B6460', fontSize: 13, fontFamily: "'JetBrains Mono', monospace" }}>%</span>
            </div>
            <div style={{ fontSize: 10, color: '#6B6460', marginTop: 2 }}>统一税率估算，尚未区分账户税务</div>
          </Field>

          <Field label="退休后权益比例">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input aria-label="退休后权益比例"
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(postRetirementEquity * 100)}
                onChange={e => setPostRetirementEquity(parseInt(e.target.value, 10) / 100)}
                style={{ width: 96, accentColor: '#C8A96E', cursor: 'pointer' }}
              />
              <span style={{ fontSize: 13, color: '#E8E0D0', fontFamily: "'JetBrains Mono', monospace", minWidth: 32 }}>
                {Math.round(postRetirementEquity * 100)}%
              </span>
            </div>
            <div style={{ fontSize: 10, color: '#3A3530', marginTop: 2 }}>
              余下为债券 · 影响退休后模拟回报率
            </div>
          </Field>
        </div>
      </Section>

      {/* ── Section: 支出规划 ── */}
      <Section title="支出规划（拖拽分界线调整阶段）">
        {currentAgeValid && retirementAgeValid ? (
          <SpendingTimeline
            phases={phases}
            currentAge={retirementAge}
            maxAge={maxAge}
            onChange={setPhases}
          />
        ) : (
          <div style={{ color: '#6B6460', fontSize: 12, padding: '12px 0' }}>
            请先填写有效的当前年龄和退休年龄
          </div>
        )}
      </Section>

      {/* ── Section: 模拟结果 ── */}
      <Section title="">
        {!currentAgeValid ? (
          <div style={{ color: '#6B6460', fontSize: 12, padding: '20px 0', textAlign: 'center' }}>
            填写当前年龄后显示模拟结果
          </div>
        ) : mcResult ? (
          <>
            <RetirementChart result={mcResult} retirementAge={retirementAge} />
            <YearlyTable result={mcResult} retirementAge={retirementAge} />
          </>
        ) : <p style={{ color: '#6B6460', fontSize: 12 }}>计算中，或参数无效；请检查年龄、阶段重叠和非负金额。</p>}
      </Section>
    </fieldset>
  )
}

// ─── CustomAssetEditor ────────────────────────────────────────────────────────

const REAL_ESTATE_DEFAULTS = { mean: 0.05, std: 0.12 }

function fmt(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
}

function CustomAssetEditor({ assets, onChange }: { assets: CustomAsset[]; onChange: (a: CustomAsset[]) => void }) {
  const totalValue = assets.reduce((s, a) => s + a.value, 0)

  function add() {
    onChange([...assets, {
      id: `asset-${Date.now()}`,
      name: '投资房',
      value: 0,
      mean: REAL_ESTATE_DEFAULTS.mean,
      std: REAL_ESTATE_DEFAULTS.std,
    }])
  }

  function update(id: string, patch: Partial<CustomAsset>) {
    onChange(assets.map(a => a.id === id ? { ...a, ...patch } : a))
  }

  function remove(id: string) {
    onChange(assets.filter(a => a.id !== id))
  }

  const cellStyle: React.CSSProperties = {
    background: '#0E0E0E', border: '1px solid #2A2826', borderRadius: 4,
    color: '#E8E0D0', fontSize: 12, padding: '5px 8px', outline: 'none',
    fontFamily: "'JetBrains Mono', monospace",
  }
  const capStyle: React.CSSProperties = {
    fontSize: 10, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.06em', textTransform: 'uppercase' as const,
  }

  return (
    <div>
      {assets.length > 0 && (
        <div style={{ marginBottom: 8, overflowX: 'auto' }}>
          {/* Header */}
          <div style={{ display: 'grid', minWidth: 440, gridTemplateColumns: '1fr 110px 80px 80px 28px', gap: 6, marginBottom: 4, paddingLeft: 2 }}>
            <span style={capStyle}>名称</span>
            <span style={{ ...capStyle, textAlign: 'right' }}>当前市值</span>
            <span style={{ ...capStyle, textAlign: 'right' }}>年化收益</span>
            <span style={{ ...capStyle, textAlign: 'right' }}>标准差</span>
            <span />
          </div>
          {assets.map(asset => (
            <div key={asset.id}><div style={{ display: 'grid', minWidth: 440, gridTemplateColumns: '1fr 110px 80px 80px 28px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <input
                style={{ ...cellStyle, width: '100%', boxSizing: 'border-box' }}
                value={asset.name}
                onChange={e => update(asset.id, { name: e.target.value })}
                placeholder="资产名称"
              />
              <input
                style={{ ...cellStyle, width: '100%', boxSizing: 'border-box', textAlign: 'right' }}
                type="number" min="0" step="10000"
                value={asset.value || ''}
                onChange={e => update(asset.id, { value: parseFloat(e.target.value) || 0 })}
                placeholder="0"
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <input
                  style={{ ...cellStyle, width: '100%', boxSizing: 'border-box', textAlign: 'right' }}
                  type="number" min="-20" max="50" step="0.5"
                  value={Math.round(asset.mean * 100 * 10) / 10}
                  onChange={e => update(asset.id, { mean: (parseFloat(e.target.value) || 0) / 100 })}
                />
                <span style={{ fontSize: 11, color: '#6B6460' }}>%</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <input
                  style={{ ...cellStyle, width: '100%', boxSizing: 'border-box', textAlign: 'right' }}
                  type="number" min="0" max="100" step="0.5"
                  value={Math.round(asset.std * 100 * 10) / 10}
                  onChange={e => update(asset.id, { std: (parseFloat(e.target.value) || 0) / 100 })}
                />
                <span style={{ fontSize: 11, color: '#6B6460' }}>%</span>
              </div>
              <button
                onClick={() => remove(asset.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B6460', fontSize: 16, padding: 0, lineHeight: 1 }}
              >×</button>
            </div>
            <label style={{ fontSize: 11, color: '#6B6460', display: 'block', marginBottom: 12 }}>
              <input type="checkbox" checked={asset.availableForSpending ?? false} onChange={e => update(asset.id, { availableForSpending: e.target.checked })} />
              按可变现净额纳入；假设退休时无额外费用转入上述股债组合
            </label></div>
          ))}
          {assets.length > 0 && (
            <div style={{ fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>
              记录市值 {fmt(totalValue)} · 仅勾选的可变现资产纳入模拟
            </div>
          )}
        </div>
      )}
      <button
        onClick={add}
        style={{
          background: 'none', border: '1px dashed #2A2826', borderRadius: 4,
          cursor: 'pointer', fontSize: 11, color: '#6B6460',
          fontFamily: "'Space Grotesk', sans-serif", padding: '4px 10px', marginTop: 4,
        }}
      >
        + 添加资产
      </button>
      {assets.length === 0 && (
        <span style={{ marginLeft: 10, fontSize: 11, color: '#3A3530', fontFamily: "'Space Grotesk', sans-serif" }}>
          如房产、私募等；未勾选的资产不用于支付退休开支
        </span>
      )}
    </div>
  )
}

// ─── SSEditor ─────────────────────────────────────────────────────────────────

function SSEditor({ entries, onChange }: { entries: SocialSecurity[]; onChange: (e: SocialSecurity[]) => void }) {
  const totalMonthly = entries.reduce((s, e) => s + e.monthlyBenefit, 0)

  function add() {
    onChange([...entries, { startAge: 67, monthlyBenefit: 0 }])
  }

  function update(idx: number, patch: Partial<SocialSecurity>) {
    onChange(entries.map((e, i) => i === idx ? { ...e, ...patch } : e))
  }

  function remove(idx: number) {
    onChange(entries.filter((_, i) => i !== idx))
  }

  const cellStyle: React.CSSProperties = {
    background: '#0E0E0E', border: '1px solid #2A2826', borderRadius: 4,
    color: '#E8E0D0', fontSize: 12, padding: '5px 8px', outline: 'none',
    fontFamily: "'JetBrains Mono', monospace",
  }
  const capStyle: React.CSSProperties = {
    fontSize: 10, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace",
    letterSpacing: '0.06em', textTransform: 'uppercase' as const,
  }

  return (
    <div>
      {entries.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 110px 28px', gap: 6, marginBottom: 4, paddingLeft: 2 }}>
            <span style={capStyle}>描述</span>
            <span style={{ ...capStyle, textAlign: 'right' }}>开始年龄</span>
            <span style={{ ...capStyle, textAlign: 'right' }}>月收入</span>
            <span />
          </div>
          {entries.map((entry, idx) => (
            <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 100px 110px 28px', gap: 6, marginBottom: 6, alignItems: 'center' }}>
              <input
                style={{ ...cellStyle, width: '100%', boxSizing: 'border-box' }}
                value={idx === 0 ? '本人' : '配偶'}
                readOnly
              />
              <input
                style={{ ...cellStyle, width: '100%', boxSizing: 'border-box', textAlign: 'right' }}
                type="number" min="62" max="70" step="1"
                value={entry.startAge}
                onChange={e => update(idx, { startAge: parseInt(e.target.value) || 67 })}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <span style={{ fontSize: 11, color: '#6B6460' }}>$</span>
                <input
                  style={{ ...cellStyle, flex: 1, width: '100%', boxSizing: 'border-box', textAlign: 'right' }}
                  type="number" min="0" step="100"
                  value={entry.monthlyBenefit || ''}
                  onChange={e => update(idx, { monthlyBenefit: parseFloat(e.target.value) || 0 })}
                  placeholder="0"
                />
                <span style={{ fontSize: 11, color: '#6B6460' }}>/月</span>
              </div>
              <button
                onClick={() => remove(idx)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6B6460', fontSize: 16, padding: 0, lineHeight: 1 }}
              >×</button>
            </div>
          ))}
          {totalMonthly > 0 && (
            <div style={{ fontSize: 11, color: '#6B6460', fontFamily: "'JetBrains Mono', monospace", marginTop: 2 }}>
              合计 ${totalMonthly.toLocaleString()}/月 · 退休后自动抵扣支出，减少从投资组合取款
            </div>
          )}
        </div>
      )}
      {entries.length < 2 && (
        <button
          onClick={add}
          style={{
            background: 'none', border: '1px dashed #2A2826', borderRadius: 4,
            cursor: 'pointer', fontSize: 11, color: '#6B6460',
            fontFamily: "'Space Grotesk', sans-serif", padding: '4px 10px', marginTop: 4,
          }}
        >
          + {entries.length === 0 ? '添加社保' : '添加配偶社保'}
        </button>
      )}
      {entries.length === 0 && (
        <span style={{ marginLeft: 10, fontSize: 11, color: '#3A3530', fontFamily: "'Space Grotesk', sans-serif" }}>
          SSA.gov 可查询预估收益，开始年龄 62–70 岁可选
        </span>
      )}
    </div>
  )
}

// ─── Layout helpers ───────────────────────────────────────────────────────────

const stepBtnStyle: React.CSSProperties = {
  background: '#161616',
  border: '1px solid #2A2826',
  color: '#6B6460',
  fontSize: 14,
  lineHeight: 1,
  padding: '5px 8px',
  cursor: 'pointer',
  fontFamily: "'JetBrains Mono', monospace",
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 32 }}>
      {title && (
        <div style={{
          fontSize: 11,
          color: '#6B6460',
          fontFamily: "'JetBrains Mono', monospace",
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          marginBottom: 12,
          paddingBottom: 8,
          borderBottom: '1px solid #1E1C1A',
        }}>
          {title}
        </div>
      )}
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={labelStyle()}>{label}</label>
      {children}
    </div>
  )
}
