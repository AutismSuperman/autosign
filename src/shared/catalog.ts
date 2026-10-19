import type { CatalogEntry } from './types'

/**
 * 内置站点目录。
 *
 * 数据来源：上游 AutoSign Catalog.java（AGPL-3.0-or-later）与各站点 /api/status 实测。
 * 站点接口、奖励与可用性由各站点运营方决定，本项目不作保证。
 */
export const CATALOG: CatalogEntry[] = [
  {
    id: 'agentrouter',
    name: 'AgentRouter',
    baseUrl: 'https://agentrouter.org',
    affUrl: 'https://agentrouter.org/register?aff=nc7C',
    mode: 'RELOGIN',
    reward: '注册 $175 + 每日签到 $25',
    note: 'GPT5.6SoL / Claude Opus 4.8 / Claude Opus 5；登录动作发放当日额度',
    provider: 'github',
    providers: ['github', 'linuxdo']
  },
  {
    id: 'justdowork',
    name: 'JustDoWork',
    baseUrl: 'https://api.justwoker.icu',
    affUrl: 'https://api.justwoker.icu/sign-up?aff=wFQu',
    mode: 'BUTTON',
    reward: '注册 $90 + 每日签到 $20',
    note: 'Claude Opus 4.8 / Claude Opus 5；有签到按钮，需 Turnstile',
    provider: 'github',
    providers: ['github']
  },
  {
    id: 'gorouter',
    name: 'GoRouter',
    baseUrl: 'https://gorouter.app',
    affUrl: 'https://gorouter.app/sign-up?aff=Dr35',
    mode: 'LOGIN_GRANT',
    reward: '注册 $70 + 每日签到 $10',
    note: 'Claude Opus 4.8 / Claude Opus 5；登录即得',
    provider: 'github',
    providers: ['github']
  },
  {
    id: 'seekai',
    name: 'SeekAI',
    baseUrl: 'https://seekai.cc',
    affUrl: 'https://seekai.cc/sign-up?aff=sxto',
    mode: 'BUTTON',
    reward: '每日签到奖励',
    note: 'New API 系，签到需 Turnstile',
    provider: 'github',
    providers: ['github']
  },
  {
    id: 'kktoken',
    name: 'KKtoken AI',
    baseUrl: 'https://kktoken.cc',
    affUrl: 'https://kktoken.cc/sign-up?aff=BpDr',
    mode: 'BUTTON',
    reward: '注册 $75 + 每日签到 $25',
    note: 'Claude Opus 4.8 / Claude Opus 5；有签到按钮',
    provider: 'github',
    providers: ['github']
  },
  {
    id: 'anyrouter',
    name: 'AnyRouter',
    baseUrl: 'https://anyrouter.top',
    affUrl: 'https://anyrouter.top/register?aff=GWxP',
    mode: 'RELOGIN',
    reward: '每日签到 $25',
    note: 'Linux DO 登录（首次需人工答题），Claude / GPT 系列',
    provider: 'linuxdo',
    providers: ['linuxdo', 'github']
  }
]

export function catalogById(id: string): CatalogEntry | undefined {
  return CATALOG.find((c) => c.id === id)
}

/** 把目录条目转成可持久化的站点初始数据（不含账号）。 */
export function siteFromCatalog(entry: CatalogEntry): {
  id: string
  name: string
  baseUrl: string
  mode: CatalogEntry['mode']
  kind: 'NEWAPI'
  provider: CatalogEntry['provider']
  affUrl: string
  note: string
} {
  return {
    id: entry.id,
    name: entry.name,
    baseUrl: entry.baseUrl,
    mode: entry.mode,
    kind: 'NEWAPI',
    provider: entry.provider,
    affUrl: entry.affUrl,
    note: entry.note
  }
}
