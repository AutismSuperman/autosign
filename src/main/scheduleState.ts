import { readFile, rename, writeFile } from 'node:fs/promises'
import type { ScheduleState, ScheduleAttempt } from './scheduler'

/** Contains only internal account IDs and retry metadata, never credentials. */
export class ScheduleStateStore {
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async read(): Promise<ScheduleState | undefined> {
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8')) as ScheduleState
      if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) ||
          !data.accounts || typeof data.accounts !== 'object' || Array.isArray(data.accounts)) return
      const accounts: Record<string, ScheduleAttempt> = {}
      for (const [id, entry] of Object.entries(data.accounts)) {
        if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue
        if (!entry || !Number.isInteger(entry.attempts) || entry.attempts < 1 ||
            entry.attempts > 4 || !Number.isFinite(entry.nextAt) || entry.nextAt < 0 ||
            !['pending', 'done', 'blocked', 'exhausted'].includes(entry.status)) continue
        accounts[id] = entry
      }
      return { date: data.date, accounts }
    } catch {
      return undefined
    }
  }

  save(state: ScheduleState): Promise<void> {
    const payload = JSON.stringify(state)
    this.writing = this.writing.catch(() => undefined).then(async () => {
      const tmp = `${this.file}.tmp`
      await writeFile(tmp, payload, 'utf8')
      await rename(tmp, this.file)
    })
    return this.writing
  }
}
