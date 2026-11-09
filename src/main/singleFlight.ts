/** Coalesce overlapping work for one account; later calls can run again after settlement. */
export function createSingleFlight<T>(): (key: string, work: () => Promise<T>) => Promise<T> {
  const pending = new Map<string, Promise<T>>()
  return (key, work) => {
    const existing = pending.get(key)
    if (existing) return existing
    const task = Promise.resolve().then(work).finally(() => {
      if (pending.get(key) === task) pending.delete(key)
    })
    pending.set(key, task)
    return task
  }
}
