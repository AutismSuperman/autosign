/**
 * 按账号分区的串行锁。
 *
 * 背景：每个「站点 × 账号」共用一个持久化分区（`accountPartition`），
 * 取令牌、静默重授权、读额度、签到全在这里。窗口层面却没有任何互斥，
 * 于是同一账号可能被两条链路同时打开隐藏窗口：
 *
 *   - 手动「刷新额度」与定时恢复同时撞上会话失效 → 两个静默授权窗口
 *     在同一个分区里各自取 `state`，先兑换成功的那个会让另一个的 state 失效
 *   - 批量签到与 keepAlive 恢复重叠 → 同一个 sitekey 同时起两个 Turnstile 挂件，
 *     这正好触发 Cloudflare `300030`（客户端频率上限），然后重试逻辑再开更多窗口
 *
 * 与 `session.ts` 的 `refreshLocks` 是同一套思路：那个锁保证了同账号的令牌续期
 * 不并发消费同一个 refresh cookie；这里把同样的约束延伸到隐藏窗口。
 *
 * 不同分区之间必须并行 —— 批量签到要能同时处理多个账号，串成全局锁会让
 * 20 个账号的批量任务退化成严格串行，慢 20 倍。
 */

/** 每个分区一条 Promise 队列；后进的任务挂在队尾。 */
const chains = new Map<string, Promise<unknown>>()
/** 每个分区当前排队 + 执行中的任务数，归零时删键，避免 Map 无限增长。 */
const pending = new Map<string, number>()

/**
 * 在同一分区的任务之间建立先后顺序。
 *
 * @param partitionKey 分区标识，通常用 `accountPartition()` 的结果
 * @param task 要执行的任务
 *
 * 保证：同 key 严格串行（前一个结束后才开始下一个，无论成功失败）；
 * 异 key 完全并行。任务抛错不会污染队列 —— 后续任务照常执行。
 */
export async function withPartitionLock<T>(
  partitionKey: string,
  task: () => Promise<T>
): Promise<T> {
  const prev = chains.get(partitionKey) ?? Promise.resolve()
  pending.set(partitionKey, (pending.get(partitionKey) ?? 0) + 1)

  // 接在队尾：前一个任务的结果（无论成败）都不影响本任务的启动
  const run = prev.then(
    () => task(),
    () => task()
  )

  // 队列里放的是「已吞掉异常」的版本，避免一次失败让后续任务的 .then 链断掉
  const tail = run.then(
    () => undefined,
    () => undefined
  )
  chains.set(partitionKey, tail)

  try {
    return await run
  } finally {
    const left = (pending.get(partitionKey) ?? 1) - 1
    if (left <= 0) {
      pending.delete(partitionKey)
      // 只有队列尾还是自己时才删键，否则会把后来者的链一起丢掉
      if (chains.get(partitionKey) === tail) chains.delete(partitionKey)
    } else {
      pending.set(partitionKey, left)
    }
  }
}

/** 当前有多少任务在某个分区里排队/执行。测试与诊断用。 */
export function partitionPendingCount(partitionKey: string): number {
  return pending.get(partitionKey) ?? 0
}
