// Talks to the tracking API in server.mjs. Every call is best effort: when the site is
// hosted without the server, the game simply runs untracked with the built-in settings.
import defaultShares from './data/default-shares.json'
import type { Lang } from './i18n'
import type { Song } from './songs'

export type Player = { id: string; nickname: string }
// Target share of rounds per artist, in percent, per language.
export type Shares = Record<Lang, Record<string, number>>
export const DEFAULT_SHARES = defaultShares as Shares

const PLAYER_KEY = 'song-game-player'

export function loadPlayer(): Player | null {
  try {
    const player = JSON.parse(localStorage.getItem(PLAYER_KEY) ?? 'null')
    return player?.id && player?.nickname ? player : null
  } catch {
    return null
  }
}

export function savePlayer(nickname: string, previous: Player | null): Player {
  const player = { id: previous?.id ?? crypto.randomUUID(), nickname }
  try {
    localStorage.setItem(PLAYER_KEY, JSON.stringify(player))
  } catch {}
  return player
}

const post = (path: string, body: object) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    keepalive: true,
  }).catch(() => {})

export const trackVisit = (player: Player, lang: Lang, rename = false) =>
  post('/api/visit', { playerId: player.id, nickname: player.nickname, lang, rename })

export const trackRound = (player: Player, song: Song, lang: Lang, diff: number, outcome: string, points: number) =>
  post('/api/round', {
    playerId: player.id,
    nickname: player.nickname,
    song: { id: song.id, title: song.title, artist: song.artist },
    lang,
    diff,
    outcome,
    points,
  })

export async function fetchShares(): Promise<Shares | null> {
  try {
    const res = await fetch('/api/config')
    return res.ok ? (await res.json()).shares : null
  } catch {
    return null
  }
}

export type AdminStats = {
  totals: { players: number; visits: number; rounds: number }
  days: { day: string; visits: number; players: number; rounds: number }[]
  breakdown: { lang: Lang; diff: number; rounds: number }[]
  recent: { at: string; nickname: string | null; title: string; artist: string; lang: Lang; diff: number; outcome: string; points: number }[]
  artistRounds: { lang: Lang; artist: string; rounds: number }[]
  shares: Shares
}

async function admin<T>(password: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${password}`, 'Content-Type': 'application/json' },
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status })
  return body
}

export const fetchAdminStats = (password: string) => admin<AdminStats>(password, '/api/admin/stats')
export const saveShares = (password: string, shares: Shares) =>
  admin<{ shares: Shares }>(password, '/api/admin/shares', { method: 'PUT', body: JSON.stringify(shares) })
