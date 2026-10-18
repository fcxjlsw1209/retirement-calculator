import type { RetirementScenario } from './api'

export type ScenarioPatch = Partial<Omit<RetirementScenario, 'id' | 'created_at' | 'updated_at'>>

// Full draft writes are serialized so a slow earlier request cannot overwrite a
// newer edit. A failed write does not poison the queue and can be retried.
export class ScenarioSaveQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private saved = new Map<number, string>()

  constructor(private write: (id: number, patch: ScenarioPatch) => Promise<RetirementScenario>) {}

  acknowledge(id: number, patch: ScenarioPatch) {
    this.saved.set(id, JSON.stringify(patch))
  }

  isSaved(id: number, patch: ScenarioPatch) {
    return this.saved.get(id) === JSON.stringify(patch)
  }

  save(id: number, patch: ScenarioPatch): Promise<RetirementScenario | null> {
    const snapshot = { ...patch }
    const next = this.tail.then(async () => {
      if (this.isSaved(id, snapshot)) return null
      const updated = await this.write(id, snapshot)
      this.acknowledge(id, snapshot)
      return updated
    })
    this.tail = next.catch(() => {})
    return next
  }
}
