import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_SHARES, fetchShares, loadPlayer, savePlayer, trackRound, trackVisit } from './api'
import { TEXT, type Lang } from './i18n'
import { SnippetPlayer } from './player'
import { catalogs, isArtistOf, isSameSong, pickSong, searchArtists, searchSongs, type Song } from './songs'

const STAGES = [0.1, 0.5, 2, 8, 15] // seconds heard before each guess
const TOTAL = STAGES[STAGES.length - 1]
const SETTINGS_KEY = 'song-game-settings-v2'
const STATS_KEY = 'song-game-stats'
const HISTORY_LIMIT = 50
// Points by the stage a correct answer came at: the less you heard, the more it is worth.
const ARTIST_POINTS = [100, 80, 60, 40, 20]
const SONG_BONUS = [50, 40, 30, 20, 10]

type Outcome = 'both' | 'artist' | 'lost'
type Played = { id: string; title: string; artist: string; outcome: Outcome; points: number }
// history is newest first; the two timestamps (ms) decide when the score expires
type Stats = { score: number; history: Played[]; startedAt: number; activeAt: number }

// The score and history start over 24 hours after they began, or after an hour away.
const SCORE_LIFETIME_MS = 24 * 60 * 60 * 1000
const IDLE_LIMIT_MS = 60 * 60 * 1000
const newStats = (): Stats => ({ score: 0, history: [], startedAt: Date.now(), activeAt: Date.now() })
// Returns the stats as they stand now: unchanged, or started over when they have expired.
function current(stats: Stats): Stats {
  const now = Date.now()
  const expired = now - stats.startedAt > SCORE_LIFETIME_MS || now - stats.activeAt > IDLE_LIMIT_MS
  return expired ? newStats() : stats
}

function loadStats(): Stats {
  try {
    return current({ ...newStats(), ...JSON.parse(localStorage.getItem(STATS_KEY) ?? '{}') })
  } catch {
    return newStats()
  }
}

const SEEN_KEY = 'song-game-seen'
function loadSeen(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

type Settings = { lang: Lang; genre: string; era: string; diff: number; mode: 'start' | 'middle'; volume: number }
const DEFAULTS: Settings = { lang: 'he', genre: 'all', era: 'all', diff: 1, mode: 'start', volume: 60 }

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }
  } catch {
    return DEFAULTS
  }
}

// Clips often open with silence or a spoken intro, so "middle" starts a third of the way in.
const startOf = (song: Song, mode: Settings['mode']) => (mode === 'start' ? 0 : Math.floor(song.dur * 0.35))

export default function App() {
  const [settings, setSettings] = useState(loadSettings)
  const [song, setSong] = useState<Song | null>(null)
  const [stage, setStage] = useState(0)
  const [misses, setMisses] = useState<string[]>([])
  // The round is about the artist; naming the song as well is a bonus.
  const [artistClip, setArtistClip] = useState<number | null>(null) // seconds heard when the artist was named
  const [result, setResult] = useState<Outcome | null>(null)
  const [stats, setStats] = useState(loadStats)
  useEffect(() => {
    try {
      localStorage.setItem(STATS_KEY, JSON.stringify(stats))
    } catch {}
  }, [stats])
  // Coming back to the tab counts as a visit: an expired score is cleared, a live one stays alive.
  useEffect(() => {
    const touch = () => document.hidden || setStats((prev) => ({ ...current(prev), activeAt: Date.now() }))
    touch()
    document.addEventListener('visibilitychange', touch)
    return () => document.removeEventListener('visibilitychange', touch)
  }, [])
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)

  // Who is playing: a nickname and a random id, kept in this browser.
  const [who, setWho] = useState(loadPlayer)
  const [askName, setAskName] = useState(!who)
  const visited = useRef(false)
  // Admin-controlled artist shares; a ref, so their arrival does not re-roll the current song.
  const shares = useRef(DEFAULT_SHARES)
  useEffect(() => {
    fetchShares().then((loaded) => loaded && (shares.current = loaded))
  }, [])

  const playerHost = useRef<HTMLDivElement>(null)
  const player = useRef<SnippetPlayer | null>(null)
  // Songs already played in this browser. Kept across visits, so a song does not come
  // back until everything else in the chosen filter has been played.
  const seen = useRef(loadSeen())

  const update = (patch: Partial<Settings>) => setSettings((prev) => ({ ...prev, ...patch }))
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {}
  }, [settings])

  const { lang, genre, era, diff, mode, volume } = settings
  useEffect(() => {
    if (!who || visited.current) return
    visited.current = true
    trackVisit(who, lang)
  }, [who, lang])
  const rename = (nickname: string) => {
    const next = savePlayer(nickname, who)
    if (visited.current) trackVisit(next, lang, true)
    setWho(next)
    setAskName(false)
  }
  const t = TEXT[lang]
  useEffect(() => {
    document.documentElement.lang = lang
    document.documentElement.dir = t.dir
    document.title = t.name
  }, [lang, t])

  const pool = useMemo(
    () =>
      catalogs[lang].filter(
        (s) => s.diff === diff && (era === 'all' || s.era === era) && (genre === 'all' || s.genres.includes(genre)),
      ),
    [lang, genre, era, diff],
  )

  const nextSong = useCallback(() => {
    let fresh = pool.filter((s) => !seen.current.has(s.id))
    if (!fresh.length) {
      pool.forEach((s) => seen.current.delete(s.id))
      fresh = pool
    }
    const pick = pickSong(fresh, shares.current[lang])
    if (pick) seen.current.add(pick.id)
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify([...seen.current]))
    } catch {}
    setSong(pick)
    setStage(0)
    setMisses([])
    setResult(null)
    setArtistClip(null)
  }, [pool, lang])
  useEffect(nextSong, [nextSong])

  const nextSongRef = useRef(nextSong)
  nextSongRef.current = nextSong
  useEffect(() => {
    const host = document.createElement('div')
    playerHost.current!.append(host)
    player.current = new SnippetPlayer(host, {
      onReady: () => setReady(true),
      onPlaying: setPlaying,
      onError: () => nextSongRef.current(),
    })
  }, [])

  useEffect(() => {
    setReady(false)
    setPlaying(false)
    if (song) player.current!.load(song.id, startOf(song, mode))
    else player.current!.stop()
  }, [song, mode])
  useEffect(() => player.current!.setVolume(volume), [volume])

  const reveal = (outcome: Outcome) => {
    // Naming the song straight away also names the artist, at the current stage.
    const artistStage = artistClip !== null ? STAGES.indexOf(artistClip) : outcome === 'both' ? stage : -1
    const points = (ARTIST_POINTS[artistStage] ?? 0) + (outcome === 'both' ? SONG_BONUS[stage] : 0)
    const played = { id: song!.id, title: song!.title, artist: song!.artist, outcome, points }
    setStats((stale) => {
      const prev = current(stale)
      return { ...prev, score: prev.score + points, history: [played, ...prev.history].slice(0, HISTORY_LIMIT), activeAt: Date.now() }
    })
    if (who) trackRound(who, song!, lang, diff, outcome, points)
    setResult(outcome)
    player.current!.play(Infinity)
  }
  const miss = (label: string) => {
    player.current!.stop()
    setMisses((prev) => [...prev, label])
    if (stage === STAGES.length - 1) reveal(artistClip === null ? 'lost' : 'artist')
    else setStage(stage + 1)
  }
  const guessArtist = (name: string) => {
    if (isArtistOf(name, song!)) setArtistClip(STAGES[stage])
    else miss(name)
  }
  const guessSong = (picked: Song) => {
    if (isSameSong(picked, song!)) reveal('both')
    else miss(`${picked.title} · ${picked.artist}`)
  }
  const togglePlay = () => {
    if (playing) player.current!.stop()
    else player.current!.play(result ? Infinity : STAGES[stage])
  }

  const findArtists = useCallback((query: string) => searchArtists(lang, query), [lang])
  const findSongs = useCallback((query: string) => searchSongs(lang, query), [lang])

  const clip = STAGES[stage]
  return (
    <div className="app">
      <div className="hidden-player" ref={playerHost} aria-hidden="true" />
      {/* Genres differ between the two catalogs, so the genre filter resets with the language. */}
      {askName && <NicknameDialog text={t} current={who?.nickname ?? ''} onSave={rename} />}
      {who && <button className="who" onClick={() => setAskName(true)}>👤 {who.nickname}</button>}
      <button className="lang" onClick={() => update({ lang: lang === 'he' ? 'en' : 'he', genre: 'all' })}>
        🌐 {t.switchTo}
      </button>

      <aside className="panel">
        <label className="heading" htmlFor="genre">{t.genre}</label>
        <select id="genre" value={genre} onChange={(e) => update({ genre: e.target.value })}>
          {t.genres.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
        </select>

        <label className="heading" htmlFor="era">{t.era}</label>
        <select id="era" value={era} onChange={(e) => update({ era: e.target.value })}>
          {t.eras.map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
        </select>

        <hr />
        <div className="heading">{t.difficulty}</div>
        {t.difficulties.map((d) => (
          <button key={d.id} className={`option ${diff === d.id ? 'on' : ''}`} onClick={() => update({ diff: +d.id })}>
            {d.label}
          </button>
        ))}

        <hr />
        <button className="link" onClick={nextSong} disabled={!song}>{t.reroll}</button>
        <div className="count">{pool.length.toLocaleString(lang)} {t.inFilter}</div>
      </aside>

      <main className="stage">
        <h1 className="logo">{t.name}</h1>
        <div className="score">{t.score} <b>{stats.score.toLocaleString(lang)}</b></div>

        <div className="pills">
          {t.difficulties.map((d) => (
            <button key={d.id} className={`pill d${d.id} ${diff === d.id ? 'on' : ''}`} onClick={() => update({ diff: +d.id })}>
              {d.label}
            </button>
          ))}
        </div>

        {!song ? (
          <p className="empty">{t.empty}</p>
        ) : (
          <>
            <div className="bar" dir="ltr">
              <div className="unlocked" style={{ width: `${(clip / TOTAL) * 100}%` }} />
              {playing && !result && (
                <div className="fill" style={{ width: `${(clip / TOTAL) * 100}%`, animationDuration: `${clip}s` }} />
              )}
              {STAGES.slice(0, -1).map((s) => <i key={s} style={{ left: `${(s / TOTAL) * 100}%` }} />)}
            </div>

            <div className="play-row">
              <button className="play" onClick={togglePlay} disabled={!ready} aria-label={playing ? t.stop : t.play}>
                {!ready ? <span className="spinner" /> : playing ? <StopIcon /> : <PlayIcon />}
              </button>
              {!result && <span className="clip">{clip} {t.sec}</span>}
            </div>

            {result ? (
              <div className={`result ${result === 'lost' ? 'lost' : 'won'}`}>
                <img src={`https://i.ytimg.com/vi/${song.id}/mqdefault.jpg`} alt="" />
                <div>
                  <div className="verdict">{result === 'both' ? t.wonBoth(clip) : result === 'artist' ? t.wonArtist(artistClip!) : t.lost}
                    {stats.history[0]?.points > 0 && <span className="gain"> +{t.points(stats.history[0].points)}</span>}</div>
                  <div className="title">{song.title}</div>
                  <div className="artist">{song.artist}</div>
                  <a href={`https://www.youtube.com/watch?v=${song.id}`} target="_blank" rel="noreferrer">{t.openYouTube}</a>
                </div>
                <button className="next" onClick={nextSong} autoFocus>{t.next}</button>
              </div>
            ) : (
              <>
                <div className="guess-row" key={song.id}>
                  <GuessBox
                    placeholder={t.artistPlaceholder}
                    search={findArtists}
                    onPick={guessArtist}
                    solved={artistClip === null ? null : song.artist}
                    render={(name) => <b>{name}</b>}
                  />
                  <GuessBox
                    placeholder={t.songPlaceholder}
                    search={findSongs}
                    onPick={guessSong}
                    render={(m) => <><b>{m.title}</b><span>{m.artist}</span></>}
                  />
                  {artistClip !== null ? (
                    <>
                      {/* Hearing a longer clip to go for the song bonus; nothing longer is left at the last stage. */}
                      {stage < STAGES.length - 1 && (
                        <button className="skip" onClick={() => miss(t.skipped)}>{t.keepGoing}</button>
                      )}
                      <button className="skip" onClick={() => reveal('artist')}>{t.finish}</button>
                    </>
                  ) : (
                    <button className="skip" onClick={() => miss(t.skipped)}>
                      {stage === STAGES.length - 1 ? t.revealSong : t.skip}
                    </button>
                  )}
                </div>
                <ul className="misses">
                  {misses.map((m, i) => <li key={i}>✕ {m}</li>)}
                </ul>
              </>
            )}
          </>
        )}
      </main>

      <aside className="panel">
        <div className="heading">{t.playback}</div>
        <button className={`option ${mode === 'start' ? 'on' : ''}`} onClick={() => update({ mode: 'start' })}>{t.fromStart}</button>
        <button className={`option ${mode === 'middle' ? 'on' : ''}`} onClick={() => update({ mode: 'middle' })}>{t.fromMiddle}</button>

        <hr />
        <div className="heading">{t.guessAfter}</div>
        <div className="chips">
          {STAGES.map((s, i) => (
            // Display only: a stage opens by skipping or guessing wrong, never by clicking it.
            <span key={s} className={`chip ${i === stage ? 'on' : i < stage ? 'done' : ''}`} aria-current={i === stage || undefined}>
              {s} {t.sec}
            </span>
          ))}
        </div>

        <hr />
        <label className="heading" htmlFor="volume">{t.volume}</label>
        <input id="volume" type="range" min="0" max="100" value={volume} onChange={(e) => update({ volume: +e.target.value })} />

        <hr />
        <div className="heading history-head">
          {t.history}
          {stats.history.length > 0 && (
            <button className="link" onClick={() => setStats(newStats())}>{t.reset}</button>
          )}
        </div>
        {stats.history.length === 0 ? (
          <div className="count">{t.noHistory}</div>
        ) : (
          <ul className="history">
            {stats.history.map((h, i) => (
              <li key={stats.history.length - i} className={h.outcome}>
                <span className="mark">{h.outcome === 'both' ? '✓✓' : h.outcome === 'artist' ? '✓' : '✕'}</span>
                <a href={`https://www.youtube.com/watch?v=${h.id}`} target="_blank" rel="noreferrer">
                  <b>{h.title}</b>
                  <span>{h.artist}</span>
                </a>
                <span className="pts">{h.points > 0 ? `+${h.points}` : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  )
}

function NicknameDialog(props: { text: (typeof TEXT)[Lang]; current: string; onSave: (nickname: string) => void }) {
  const [name, setName] = useState(props.current)
  const { text } = props
  return (
    <div className="overlay">
      <form className="dialog" onSubmit={(e) => (e.preventDefault(), name.trim() && props.onSave(name.trim()))}>
        <h2>{text.nicknameTitle}</h2>
        <p>{text.nicknameHint}</p>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={text.nicknamePlaceholder} maxLength={24} autoFocus />
        <button className="next" disabled={!name.trim()}>{text.start}</button>
      </form>
    </div>
  )
}

// A text field with an autocomplete list; picking an entry submits it as the guess.
function GuessBox<T>(props: {
  placeholder: string
  search: (query: string) => T[]
  onPick: (item: T) => void
  render: (item: T) => React.ReactNode
  solved?: string | null
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const matches = useMemo(() => props.search(query), [props.search, query])
  useEffect(() => setActive(0), [query])

  if (props.solved) return <div className="search solved">✓ {props.solved}</div>

  const pick = (item: T) => {
    setQuery('')
    props.onPick(item)
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!matches.length) return
    if (event.key === 'ArrowDown') setActive((active + 1) % matches.length)
    else if (event.key === 'ArrowUp') setActive((active - 1 + matches.length) % matches.length)
    else if (event.key === 'Enter') pick(matches[active])
    else return
    event.preventDefault()
  }
  return (
    <div className="search">
      <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder={props.placeholder} autoComplete="off" />
      {matches.length > 0 && (
        <ul>
          {matches.map((m, i) => (
            <li key={i} className={i === active ? 'on' : ''} onMouseEnter={() => setActive(i)} onMouseDown={(e) => (e.preventDefault(), pick(m))}>
              {props.render(m)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="44" height="44"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
)
const StopIcon = () => (
  <svg viewBox="0 0 24 24" width="40" height="40"><rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" /></svg>
)
