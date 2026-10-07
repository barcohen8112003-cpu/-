import english from './data/songs.en.json'
import hebrew from './data/songs.he.json'
import type { Lang } from './i18n'

export type Song = {
  id: string // YouTube video id
  title: string
  artist: string
  era: string | null
  genres: string[]
  views: number
  dur: number // seconds
  diff: number // 1 (easy) .. 5 (impossible)
}

const FINALS: Record<string, string> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' }

// Folds niqqud, final letters, punctuation and spaces so typed guesses match catalog names.
export const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[֑-ׇ]/g, '')
    .replace(/[ךםןףץ]/g, (c) => FINALS[c])
    .replace(/[^א-תa-z0-9]/g, '')

// Also ignores vav/yod, so both full and defective spellings match.
const loose = (key: string) => key.replace(/[וי]/g, '')

const indexOf = (songs: Song[]) =>
  songs.map((song) => {
    const title = normalize(song.title)
    return { song, title, key: title + normalize(song.artist) }
  })

export const catalogs: Record<Lang, Song[]> = { he: hebrew as Song[], en: english as Song[] }
const indexes = { he: indexOf(catalogs.he), en: indexOf(catalogs.en) }

export function searchSongs(lang: Lang, query: string, limit = 7): Song[] {
  const tokens = query.split(/\s+/).map(normalize).filter(Boolean)
  if (!tokens.length) return []
  const first = tokens[0]
  const hits: { song: Song; rank: number }[] = []
  for (const entry of indexes[lang]) {
    const exact = tokens.every((token) => entry.key.includes(token))
    if (!exact && !tokens.every((token) => loose(entry.key).includes(loose(token)))) continue
    const rank = (exact ? 0 : 2) + (entry.title.startsWith(first) ? 0 : 1)
    hits.push({ song: entry.song, rank })
  }
  // Catalog order is by popularity, and sort is stable, so ties keep the best-known song first.
  return hits.sort((a, b) => a.rank - b.rank).slice(0, limit).map((hit) => hit.song)
}

// Credits such as "A & B" or "A feat. B" are split, so each performer can be guessed alone.
// A leading vav is not split on: it is part of names like "נס וסטילה".
const CREDIT_SPLIT = /\s*[&,+]\s*|\s+(?:x|feat\.?|ft\.?|featuring|with|עם|מארח|מארחת|מארחים)\s+/i

const artistsOf = (songs: Song[]) => {
  const count = new Map<string, { name: string; key: string; songs: number }>()
  for (const song of songs) {
    for (const name of song.artist.split(CREDIT_SPLIT)) {
      const key = normalize(name)
      if (key.length < 2) continue
      const entry = count.get(key) ?? { name: name.trim(), key, songs: 0 }
      entry.songs++
      count.set(key, entry)
    }
  }
  return [...count.values()].sort((a, b) => b.songs - a.songs)
}
const artists = { he: artistsOf(catalogs.he), en: artistsOf(catalogs.en) }

export function searchArtists(lang: Lang, query: string, limit = 7): string[] {
  const key = normalize(query)
  if (!key) return []
  const hits = artists[lang].filter((artist) => artist.key.includes(key) || loose(artist.key).includes(loose(key)))
  // The list is ordered by number of songs, so the best-known names come first.
  return [...hits.filter((a) => a.key.startsWith(key)), ...hits.filter((a) => !a.key.startsWith(key))]
    .slice(0, limit)
    .map((artist) => artist.name)
}

// Any one of the credited performers counts.
export const isArtistOf = (name: string, song: Song) => normalize(song.artist).includes(normalize(name))

// Artists that should come up less often than their share of the catalog: each of their
// songs is drawn with this weight instead of 1.
const RARER: Record<string, number> = { 'אושר כהן': 1 / 3 }
const rarer = Object.entries(RARER).map(([name, weight]) => ({ key: normalize(name), weight }))
const weightOf = (song: Song) => rarer.find((r) => normalize(song.artist).includes(r.key))?.weight ?? 1

export function pickSong(pool: Song[]): Song | null {
  const weights = pool.map(weightOf)
  let roll = Math.random() * weights.reduce((sum, weight) => sum + weight, 0)
  return pool.find((_, i) => (roll -= weights[i]) < 0) ?? pool[pool.length - 1] ?? null
}

// The same song may exist as several uploads, so a matching title counts.
export const isSameSong = (a: Song, b: Song) => a.id === b.id || normalize(a.title) === normalize(b.title)
