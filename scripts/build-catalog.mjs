// Builds src/data/songs.<lang>.json from YouTube playlists.
// Usage: node --env-file=.env scripts/build-catalog.mjs [he|en]
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const KEY = process.env.YOUTUBE_API_KEY
if (!KEY) throw new Error('YOUTUBE_API_KEY is missing (put it in .env)')

const API = 'https://www.googleapis.com/youtube/v3'
const LANG = process.argv[2] ?? 'he'
const CACHE = `scripts/.cache/playlists.${LANG}.json`
const OUT = `src/data/songs.${LANG}.json`
// How many official artist channels get their other uploads added (0 = off).
const ARTIST_CHANNELS = 150
const UPLOADS_PER_CHANNEL = 150
// Uploads with fewer views than this are mostly not songs anyone could recognise.
const MIN_CHANNEL_VIEWS = 5000
// Keeps one prolific artist from crowding the catalog; their most-viewed songs stay.
const MAX_SONGS_PER_ARTIST = 60
const PLAYLISTS_PER_QUERY = 6
const MAX_ITEMS_PER_PLAYLIST = 500

// Each query tags the songs it finds with an era and/or a genre; untagged queries only add songs.
const QUERIES = LANG === 'en' ? [
  { era: '70s', q: 'greatest hits of the 60s and 70s' },
  { era: '80s', q: '80s greatest hits' },
  { era: '90s', q: '90s greatest hits' },
  { era: '00s', q: '2000s greatest hits' },
  { era: '10s', q: '2010s biggest hits of the decade' },
  { era: '20s', q: 'top hits 2024 2025' },
  { genre: 'pop', q: 'best pop songs of all time' },
  { genre: 'rock', q: 'classic rock greatest hits' },
  { genre: 'hiphop', q: 'hip hop rap greatest hits' },
  { genre: 'dance', q: 'best dance EDM hits of all time' },
  { genre: 'rnb', q: 'r&b soul greatest hits' },
  { q: 'greatest songs of all time' },
  { era: '70s', genre: 'dance', q: '70s disco hits' },
  { era: '90s', genre: 'pop', q: '90s pop hits' },
  { era: '00s', genre: 'pop', q: '2000s pop hits throwback' },
  { era: '10s', q: 'top hits 2015 2016 2017' },
  { era: '20s', q: 'top hits 2020 2021 2022' },
  { genre: 'rnb', q: '90s r&b hits' },
  { genre: 'rnb', q: 'r&b hits 2010s 2020s' },
  { genre: 'dance', q: '2000s dance club hits' },
  { genre: 'dance', q: 'house music classics hits' },
  { genre: 'rock', q: 'rock hits 2000s 2010s' },
  { genre: 'rock', era: '80s', q: '80s rock anthems' },
  { genre: 'hiphop', q: '2010s hip hop hits' },
  { genre: 'hiphop', q: 'rap hits 2020s' },
] : [
  { era: '70s', q: 'להיטים ישראלים שנות ה-60 וה-70' },
  { era: '80s', q: 'להיטים ישראלים שנות ה-80' },
  { era: '90s', q: 'להיטים ישראלים שנות ה-90' },
  { era: '00s', q: 'להיטים ישראלים שנות ה-2000' },
  { era: '10s', q: 'להיטים ישראלים 2010-2019 העשור' },
  { era: '20s', q: 'להיטים ישראלים חדשים 2024 2025' },
  { genre: 'mizrahi', q: 'מזרחית ים תיכונית להיטים' },
  { genre: 'rock', q: 'רוק ישראלי הלהיטים הגדולים' },
  { genre: 'pop', q: 'פופ ישראלי להיטים' },
  { genre: 'hiphop', q: 'היפ הופ ראפ ישראלי' },
  { genre: 'classic', q: 'שירי ארץ ישראל הישנה והטובה' },
  { q: 'השירים הישראלים הגדולים בכל הזמנים' },
  { q: 'שירים ישראלים שקטים ויפים' },
  { era: '90s', q: 'מוזיקה ישראלית שנות התשעים' },
  { era: '00s', q: 'מצעד הפזמונים השנתי 2005 2008' },
  { genre: 'mizrahi', q: 'זמר מזרחי נוסטלגיה קלאסיקות' },
  { genre: 'classic', q: 'להקות צבאיות השירים הגדולים' },
  { genre: 'pop', q: 'פופ ישראלי 2020 2021 2022 2023' },
  { genre: 'pop', q: 'פופ ישראלי שנות ה-2000 וה-2010' },
  { genre: 'hiphop', q: 'ראפ ישראלי השירים הכי טובים' },
  { genre: 'hiphop', q: 'היפ הופ ישראלי קלאסיקות' },
  { genre: 'classic', q: 'שירי ארץ ישראל נוסטלגיה' },
  { genre: 'classic', q: 'שירים עבריים ישנים שנות ה-50 וה-60' },
]
const ERA_ORDER = ['70s', '80s', '90s', '00s', '10s', '20s']

// Every answer is kept on disk, so a rebuild, or a run cut short by the daily quota,
// never pays for the same request twice. Delete scripts/.cache/api to refresh.
const API_CACHE = 'scripts/.cache/api'
await mkdir(API_CACHE, { recursive: true })
async function yt(path, params) {
  const query = String(new URLSearchParams(params))
  const cached = `${API_CACHE}/${createHash('sha1').update(`${path}?${query}`).digest('hex')}.json`
  try {
    return JSON.parse(await readFile(cached, 'utf8'))
  } catch {}
  const res = await fetch(`${API}/${path}?${query}&key=${KEY}`)
  const body = await res.json()
  if (!res.ok) throw new Error(`${path}: ${body.error?.message ?? res.status}`)
  await writeFile(cached, JSON.stringify(body))
  return body
}

// Playlist search costs 100 quota units per call, so each query's result is cached on disk.
async function findPlaylists() {
  const cache = await readFile(CACHE, 'utf8').then(JSON.parse, () => ({}))
  await mkdir('scripts/.cache', { recursive: true })
  for (const query of QUERIES) {
    if (cache[query.q]) continue
    const body = await yt('search', {
      part: 'snippet', type: 'playlist', maxResults: 15, q: query.q,
      ...(LANG === 'en' ? { regionCode: 'US', relevanceLanguage: 'en' } : { regionCode: 'IL', relevanceLanguage: 'he' }),
    })
    cache[query.q] = body.items.slice(0, PLAYLISTS_PER_QUERY).map((item) => ({
      id: item.id.playlistId, name: item.snippet.title, era: query.era, genre: query.genre,
    }))
    console.log(`${query.q}:`, cache[query.q].map((p) => p.name).join(' | '))
    await writeFile(CACHE, JSON.stringify(cache, null, 2))
  }
  return QUERIES.flatMap((query) => cache[query.q])
}

async function playlistVideoIds(playlistId, limit = MAX_ITEMS_PER_PLAYLIST) {
  const ids = []
  let pageToken
  do {
    const body = await yt('playlistItems', {
      part: 'contentDetails', playlistId, maxResults: 50, ...(pageToken && { pageToken }),
    }).catch((err) => {
      if (/quota/i.test(err.message)) throw err
      console.warn(`  skipped ${playlistId}: ${err.message}`)
      return { items: [] }
    })
    ids.push(...body.items.map((item) => item.contentDetails.videoId))
    pageToken = body.nextPageToken
  } while (pageToken && ids.length < limit)
  return ids
}

async function videoDetails(ids) {
  const videos = []
  for (let i = 0; i < ids.length; i += 50) {
    const body = await yt('videos', {
      part: 'snippet,contentDetails,statistics,status', id: ids.slice(i, i + 50).join(','), maxResults: 50,
    })
    videos.push(...body.items)
  }
  return videos
}

const seconds = (iso) => {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso) ?? []
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)
}

const HEBREW = /[א-ת]/
// A title belongs to the catalog's language: Hebrew letters, or Latin script only.
const inLanguage = (text) =>
  LANG === 'en' ? /[a-z]/i.test(text) && !/[^\u0000-ɏ‐-‧]/.test(text) : HEBREW.test(text)
const REJECT = /\blive\b|לייב|חי באולפן|הופעה|בהופעה|קריוקי|karaoke|פלייבק|playback|רמיקס|remix|מחרוזת|cover|קאבר|מאש-?אפ|mashup|full album|האלבום המלא|אוסף|שעה של|פרק \d|טריילר|ראיון|כתבת|חדשות|טיזר|פרומו|מאחורי הקלעים|הצצה/i
const NOISE = /הקליפ הרשמי|קליפ רשמי|וידאו רשמי|אודיו רשמי|official (music )?video|official audio|lyrics?( video)?|עם מילים|קליפ|אודיו|\bhd\b|\bhq\b|\b4k\b|prod\.? by.*$|להורדה.*$/gi

const tidy = (s) => s.replace(/[“”״"]/g, '"').replace(/\s+/g, ' ').replace(/^[\s\-–—|:.,"']+|[\s\-–—|:.,"']+$/g, '').trim()
const norm = (s) => s.toLowerCase().replace(/[֑-ׇ]/g, '').replace(/[^א-תa-z0-9]/g, '')

// `channelArtist` is set for videos taken from an artist's own channel, where the title
// is often just the song name.
function parseSong(video, channelArtist) {
  const channel = video.snippet.channelTitle
  const isTopic = / - Topic$/.test(channel)
  const raw = tidy(video.snippet.title.replace(/[([{][^)\]}]*[)\]}]/g, ' ').replace(NOISE, ' '))
  if (isTopic) return { artist: tidy(channel.replace(/ - Topic$/, '')), title: raw }
  if (LANG === 'en') return parseEnglish(raw, video)

  // Titles often repeat the names in English ("Artist - Song | אמן - שיר"): keep the Hebrew
  // parts only, and drop English words glued onto them.
  const parts = raw.split(/\s+[-–—|]\s+|\s*[–—|]\s*|\s*\/\/\s*|\s*\\\\\s*/)
    .filter((part) => HEBREW.test(part))
    .map((part) => tidy(part.replace(/[a-z][a-z'.]*/gi, ' ').replace(/[\])}]/g, ' ').replace(/\b(19|20)\d\d$/, '')))
    .filter(Boolean)
  if (parts.length < 2) return channelArtist && parts.length === 1 ? { artist: channelArtist, title: parts[0] } : null
  // "Song - Artist" uploads: trust the channel name when it matches one side.
  const channelKey = norm(channel)
  const artistFirst = !(channelKey && norm(parts[1]) === channelKey)
  const [artist, title] = artistFirst ? [parts[0], parts[1]] : [parts[1], parts[0]]
  return { artist, title }
}

function parseEnglish(raw, video) {
  const parts = raw.split(/\s+[-–—|]\s+|\s*[–—|]\s*/).map(tidy).filter(Boolean)
  // An artist's VEVO channel often titles a video with the song name alone. Other channels
  // are not trusted for this: a record label's channel would be credited as the artist.
  if (parts.length < 2 && !/VEVO$/i.test(video.snippet.channelTitle)) return null
  const [artist, title] =
    parts.length < 2 ? [video.snippet.channelTitle.replace(/\s*(VEVO|Official)$/i, ''), parts[0]] : parts
  if (!artist || !title) return null
  return { artist: tidy(artist), title: tidy(title.replace(/\s+(ft|feat|featuring)\b\.?\s.*$/i, '')) }
}

const playlists = await findPlaylists()
const tags = new Map() // videoId -> { eras: {era: votes}, genres: Set }
for (const playlist of playlists) {
  const ids = await playlistVideoIds(playlist.id)
  console.log(`${ids.length.toString().padStart(4)}  ${playlist.name}`)
  for (const id of ids) {
    const tag = tags.get(id) ?? { eras: {}, genres: new Set() }
    if (playlist.era) tag.eras[playlist.era] = (tag.eras[playlist.era] ?? 0) + 1
    if (playlist.genre) tag.genres.add(playlist.genre)
    tags.set(id, tag)
  }
}

// Playlists under-represent today's biggest names, so their most-viewed videos are added
// directly. A video search costs 100 quota units, so each artist's result is cached.
// Artists searched for a thin genre; everything credited to them is tagged with it.
const GENRE_ARTISTS = LANG === 'en' ? {} : {
  hiphop: [
    'סאבלימינל', 'הצל', 'נצ\'י נצ\'', 'שב"ק ס', 'כהן@מושון', 'פלד', 'איזי', 'ג\'ימבו ג\'יי', 'שקל', 'מיכאל סוויסה',
    'דודו פארוק', 'אורטגה', 'טדי נגוסה', 'לוקץ\'', 'איתי גלו', 'מוקי', 'זי קיי', 'סטטיק',
  ],
  rock: [
    'כנסיית השכל', 'אביב גפן', 'מוניקה סקס', 'היהודים', 'טיפקס', 'רוקפור', 'ברי סחרוף', 'אהוד בנאי', 'אביתר בנאי',
    'בית הבובות', 'סינרגיה', 'התקווה 6', 'נקמת הטרקטור', 'החברים של נטאשה', 'תיסלם', 'בנזין', 'ג\'ירפות',
    'רמי פורטיס', 'כוורת', 'היי פייב',
  ],
}
const genreOf = (artist) => Object.keys(GENRE_ARTISTS).find((genre) => GENRE_ARTISTS[genre].includes(artist))
const BASE_ARTISTS = LANG === 'en' ? [] : [
  'אודיה', 'אופק אדנק', 'נועה קירל', 'עומר אדם', 'עדן בן זקן', 'עדן חסון', 'אושר כהן', 'ששון איפרם שאולוב',
  'אגם בוחבוט', 'אנה זק', 'סטטיק ובן אל תבורי', 'אייל גולן', 'שרית חדד', 'עידן רייכל', 'חנן בן ארי', 'ישי ריבו',
  'נתן גושן', 'טונה', 'רביד פלוטניק', 'מרגי', 'איתי לוי', 'פאר טסי', 'משה פרץ', 'דודו אהרון', 'ליאור נרקיס',
  'עידן עמדי', 'נס וסטילה', 'יסמין מועלם', 'בניה ברבי', 'עדן גולן', 'יובל רפאל', 'שחר סאול', 'אליעד',
  'נרקיס', 'קרן פלס', 'שלמה ארצי',
]
const ARTISTS = [...BASE_ARTISTS, ...Object.values(GENRE_ARTISTS).flat()]
const artistNames = (artist) => artist.split(' ').map((name, i) => norm(i ? name.replace(/^ו/, '') : name))
const ARTIST_CACHE =`scripts/.cache/artists.${LANG}.json`
const artistVideos = await readFile(ARTIST_CACHE, 'utf8').then(JSON.parse, () => ({}))
for (const artist of ARTISTS) {
  if (!artistVideos[artist]) {
    // Running out of quota here only postpones the remaining artists to the next run.
    const body = await yt('search', {
      part: 'id', type: 'video', q: artist, maxResults: 50, order: 'viewCount', regionCode: 'IL', videoCategoryId: '10',
    }).catch((err) => console.warn(`  not searched yet (${artist}): ${err.message.slice(0, 60)}`))
    if (!body) continue
    artistVideos[artist] = body.items.map((item) => item.id.videoId)
    await writeFile(ARTIST_CACHE, JSON.stringify(artistVideos))
  }
  for (const id of artistVideos[artist]) {
    const tag = tags.get(id) ?? { eras: {}, genres: new Set(), artistQuery: artist }
    // The genre applies only once the video turns out to be credited to this artist.
    if (genreOf(artist)) (tag.hints ??= []).push({ artist, genre: genreOf(artist) })
    tags.set(id, tag)
  }
  console.log(`${artistVideos[artist].length.toString().padStart(4)}  ${artist}`)
}

const videos = await videoDetails([...tags.keys()])

// Channels that belong to one artist: at least 3 of the songs found so far, nearly all
// credited to the same name. Their remaining uploads are the artist's other songs.
if (ARTIST_CHANNELS) {
  const channels = new Map() // channelId -> { artist: songs }
  for (const video of videos) {
    if (/ - Topic$/.test(video.snippet.channelTitle) || !inLanguage(video.snippet.title)) continue
    const artist = parseSong(video)?.artist
    if (!artist) continue
    const credits = channels.get(video.snippet.channelId) ?? {}
    credits[artist] = (credits[artist] ?? 0) + 1
    channels.set(video.snippet.channelId, credits)
  }
  const artistChannels = [...channels]
    .map(([id, credits]) => {
      const [artist, songs] = Object.entries(credits).sort((a, b) => b[1] - a[1])[0]
      const total = Object.values(credits).reduce((sum, n) => sum + n, 0)
      return { id, artist, songs, share: songs / total }
    })
    .filter((channel) => channel.songs >= 3 && channel.share >= 0.8)
    .sort((a, b) => b.songs - a.songs)
    .slice(0, ARTIST_CHANNELS)

  const added = []
  for (const channel of artistChannels) {
    // A channel's uploads playlist has the channel id with "UU" in place of "UC".
    const ids = await playlistVideoIds('UU' + channel.id.slice(2), UPLOADS_PER_CHANNEL)
    for (const id of ids) {
      if (tags.has(id)) continue
      tags.set(id, { eras: {}, genres: new Set(), channelArtist: channel.artist })
      added.push(id)
    }
  }
  console.log(`${added.length} more videos from ${artistChannels.length} artist channels`)
  videos.push(...(await videoDetails(added)))
}
const candidates = []
for (const video of videos) {
  const dur = seconds(video.contentDetails.duration)
  const blocked = video.contentDetails.regionRestriction?.blocked?.includes('IL')
  const allowed = video.contentDetails.regionRestriction?.allowed
  if (!video.status.embeddable || video.status.privacyStatus !== 'public') continue
  if (blocked || (allowed && !allowed.includes('IL'))) continue
  if (dur < 90 || dur > 420) continue
  if (!inLanguage(video.snippet.title) || REJECT.test(video.snippet.title)) continue

  const tag = tags.get(video.id)
  // An artist's channel also carries interviews and vlogs; only its music videos count.
  if (tag.channelArtist && video.snippet.categoryId !== '10') continue
  const parsed = parseSong(video, tag.channelArtist)
  if (!parsed || !inLanguage(parsed.title) || parsed.title.length > 40 || parsed.artist.length > 40) continue

  // A search for an artist also returns other people's videos that merely mention the name.
  // Duos are credited in several ways ("נס וסטילה", "נס X סטילה", "נס & סטילה"), so each
  // name is matched on its own and the credit is unified to the searched spelling.
  const credit = norm(parsed.artist)
  const known = ARTISTS.find((artist) => credit === artistNames(artist).join(''))
  if (known) parsed.artist = known
  if (tag.artistQuery && !artistNames(tag.artistQuery).every((name) => credit.includes(name))) continue
  for (const hint of tag.hints ?? []) {
    if (artistNames(hint.artist).every((name) => credit.includes(name))) tag.genres.add(hint.genre)
  }
  const year = +video.snippet.publishedAt.slice(0, 4)
  const voted = Object.entries(tag.eras).sort((a, b) => b[1] - a[1])[0]?.[0]
  // Upload date only tells the release decade for songs that came out in the YouTube era.
  // International labels re-upload old hits all the time, so it is not used for English.
  const era = voted ?? (LANG === 'en' ? null : year >= 2020 ? '20s' : year >= 2012 ? '10s' : null)

  const song = {
    id: video.id, title: parsed.title, artist: parsed.artist, era,
    genres: [...tag.genres], views: +video.statistics.viewCount || 0, dur,
  }
  if (tag.channelArtist && song.views < MIN_CHANNEL_VIEWS) continue
  candidates.push(song)
}

// Some uploads are titled "Song - Artist". A name that shows up as the artist of other
// songs more often than its partner does is taken to be the artist.
const artistCount = new Map()
for (const song of candidates) artistCount.set(norm(song.artist), (artistCount.get(norm(song.artist)) ?? 0) + 1)
for (const song of candidates) {
  const asTitle = artistCount.get(norm(song.title)) ?? 0
  if (asTitle >= 2 && asTitle > artistCount.get(norm(song.artist))) [song.artist, song.title] = [song.title, song.artist]
}

const byKey = new Map()
for (const song of candidates) {
  const key = norm(song.title) + '|' + norm(song.artist)
  const prev = byKey.get(key)
  if (prev) {
    song.genres = [...new Set([...prev.genres, ...song.genres])]
    song.era ??= prev.era
  }
  if (!prev || song.views > prev.views) byKey.set(key, song)
}

// Auto-generated "Topic" channels name the artist in English ("Omer Adam"), which duplicates
// songs already found under the Hebrew name. Merge those, and reuse the pairs to translate
// the English artist name on the songs that remain.
const hebrewName = new Map()
const byTitle = Map.groupBy(byKey.values(), (song) => norm(song.title))
const merged = []
for (const group of byTitle.values()) {
  const hebrew = group.filter((song) => HEBREW.test(song.artist))
  const english = group.filter((song) => !HEBREW.test(song.artist))
  if (!hebrew.length || !english.length) {
    merged.push(...group)
    continue
  }
  const keep = hebrew.sort((a, b) => b.views - a.views)[0]
  for (const dup of english) {
    if (hebrew.length === 1) hebrewName.set(dup.artist, keep.artist)
    keep.genres = [...new Set([...keep.genres, ...dup.genres])]
    keep.era ??= dup.era
  }
  merged.push(...hebrew)
}
for (const song of merged) song.artist = hebrewName.get(song.artist) ?? song.artist

// Difficulty 1 (easy) .. 5 (impossible): view-count rank inside the song's own era,
// so old songs are not all "hard" just because YouTube came later.
const perArtist = Map.groupBy(merged, (song) => norm(song.artist))

// Genre is decided per artist. Playlists found by search are loose about genre, and most
// songs come from sources that say nothing about it, so an artist's songs all take the
// genres that at least 40% of their tagged songs carry (two at most). A song by an artist
// with a single tagged song keeps whatever its playlist said.
for (const group of perArtist.values()) {
  const tagged = group.filter((song) => song.genres.length)
  if (tagged.length < 2) continue
  const votes = Object.entries(Object.groupBy(tagged.flatMap((song) => song.genres), (genre) => genre))
  const genres = votes
    .filter(([, list]) => list.length >= tagged.length * 0.4)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 2)
    .map(([genre]) => genre)
  for (const song of group) song.genres = genres
}
const songs = [...perArtist.values()].flatMap((group) =>
  group.sort((a, b) => b.views - a.views).slice(0, MAX_SONGS_PER_ARTIST),
)
const groups = Map.groupBy(songs, (song) => song.era ?? 'none')
for (const group of groups.values()) {
  group.sort((a, b) => b.views - a.views)
  group.forEach((song, i) => (song.diff = Math.min(5, Math.floor((i / group.length) * 5) + 1)))
}
songs.sort((a, b) => b.views - a.views)

await mkdir('src/data', { recursive: true })
await writeFile(OUT, JSON.stringify(songs))
console.log(`\n${songs.length} songs -> ${OUT}`)
for (const era of [...ERA_ORDER, 'none']) console.log(`  ${era}: ${groups.get(era)?.length ?? 0}`)
