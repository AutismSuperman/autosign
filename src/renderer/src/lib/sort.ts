import type { Account, AccountSort, Site, SiteSort, SortDirection } from '@shared/types'

/** 站点排序下拉的文案。 */
export const SITE_SORT_LABEL: Record<SiteSort, string> = {
  custom: '自定义顺序',
  available: '可用额度',
  used: '累计消耗',
  name: '站点名称'
}

/** 站点内账号排序下拉的文案。 */
export const ACCOUNT_SORT_LABEL: Record<AccountSort, string> = {
  custom: '登录顺序',
  available: '可用额度',
  used: '累计消耗',
  name: '账号名称',
  refreshed: '最近刷新'
}

function byLabel(a: Account, b: Account): number {
  return a.label.localeCompare(b.label, 'zh-Hans-CN', { sensitivity: 'base' })
}

/**
 * 取排序用的指标值。没有可用数据时返回 undefined，
 * 让这类账号/站点无论升降序都沉到末尾。
 */
function metric(account: Account, sort: AccountSort): number | undefined {
  const status = account.lastStatus
  if (sort === 'refreshed') return status?.at
  if (!status?.ok) return undefined
  return sort === 'available' ? status.available : status.used
}

/**
 * 站点内账号排序。
 *
 * custom 保持登录顺序；其余按单账号指标排序（名称默认升序，金额默认降序）。
 * 加载失败、尚未刷新的账号没有指标值，统一排在末尾。
 */
export function sortSiteAccounts(
  accounts: Account[],
  sort: AccountSort,
  dir: SortDirection
): Account[] {
  if (sort === 'custom') return accounts
  const sign = dir === 'asc' ? 1 : -1

  return [...accounts].sort((a, b) => {
    if (sort === 'name') return sign * byLabel(a, b)
    const av = metric(a, sort)
    const bv = metric(b, sort)
    if (av === undefined && bv === undefined) return byLabel(a, b)
    if (av === undefined) return 1
    if (bv === undefined) return -1
    if (av === bv) return byLabel(a, b)
    return sign * (av - bv)
  })
}

/** 站点聚合出某个金额指标：只统计刷新成功的账号，没有数据时返回 undefined。 */
function sumMetric(site: Site, pick: (account: Account) => number | undefined): number | undefined {
  let total = 0
  let seen = false
  for (const account of site.accounts) {
    if (!account.lastStatus?.ok) continue
    const value = pick(account)
    if (value === undefined) continue
    total += value
    seen = true
  }
  return seen ? total : undefined
}

function byName(a: Site, b: Site): number {
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { sensitivity: 'base' })
}

/**
 * 站点排序。
 *
 * custom 原样返回（拖拽顺序即配置顺序）；其余按聚合指标排序，
 * 没有数据的站点无论升降序都排在末尾，避免「未刷新」的站点顶到最前面。
 */
export function sortSites(sites: Site[], sort: SiteSort, dir: SortDirection): Site[] {
  if (sort === 'custom') return sites
  const sign = dir === 'asc' ? 1 : -1

  return [...sites].sort((a, b) => {
    if (sort === 'name') return sign * byName(a, b)

    const pick = (account: Account): number | undefined =>
      sort === 'available' ? account.lastStatus?.available : account.lastStatus?.used
    const av = sumMetric(a, pick)
    const bv = sumMetric(b, pick)
    if (av === undefined && bv === undefined) return byName(a, b)
    if (av === undefined) return 1
    if (bv === undefined) return -1
    if (av === bv) return byName(a, b)
    return sign * (av - bv)
  })
}
