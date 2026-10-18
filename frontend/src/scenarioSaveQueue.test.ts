import { describe, expect, it, vi } from 'vitest'
import { ScenarioSaveQueue } from './scenarioSaveQueue'
import type { RetirementScenario } from './api'

describe('scenario persistence', () => {
  it('serializes drafts so a slow request cannot overwrite the latest change', async () => {
    let release!: (value: RetirementScenario) => void
    const write = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      .mockResolvedValueOnce({ id: 1, monthly_contribution: 200, post_retirement_equity_pct: 0.8 })
    const queue = new ScenarioSaveQueue(write)
    const first = queue.save(1, { monthly_contribution: 100 })
    const second = queue.save(1, { monthly_contribution: 200, post_retirement_equity_pct: 0.8 })
    await Promise.resolve()
    expect(write).toHaveBeenCalledTimes(1)
    release({ id: 1, monthly_contribution: 100 } as RetirementScenario)
    await first
    await second
    expect(write.mock.calls[1]).toEqual([1, { monthly_contribution: 200, post_retirement_equity_pct: 0.8 }])
    expect(queue.isSaved(1, { monthly_contribution: 200, post_retirement_equity_pct: 0.8 })).toBe(true)
  })

  it('does not mark a failed draft as saved and allows a retry', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ id: 1 })
    const queue = new ScenarioSaveQueue(write)
    const draft = { monthly_contribution: 100 }
    await expect(queue.save(1, draft)).rejects.toThrow('offline')
    expect(queue.isSaved(1, draft)).toBe(false)
    await queue.save(1, draft)
    expect(queue.isSaved(1, draft)).toBe(true)
  })

  it('does not rewrite loaded scenarios or enqueue duplicate drafts', async () => {
    const write = vi.fn().mockResolvedValue({ id: 1 })
    const queue = new ScenarioSaveQueue(write)
    queue.acknowledge(1, { current_age: 40 })
    await queue.save(1, { current_age: 40 })
    expect(write).not.toHaveBeenCalled()
    await Promise.all([queue.save(1, { current_age: 41 }), queue.save(1, { current_age: 41 })])
    expect(write).toHaveBeenCalledTimes(1)
  })
})
