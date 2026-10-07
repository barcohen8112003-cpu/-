// The admin panel at /admin: traffic, recent activity, and how often each artist comes up.
import { useEffect, useMemo, useState } from 'react'
import { fetchAdminStats, saveShares, type AdminStats, type Shares } from './api'
import { TEXT, type Lang } from './i18n'
import { artistCounts, catalogs, normalize } from './songs'

const PASSWORD_KEY = 'song-game-admin'
const VISIBLE_ARTISTS = 40
const OUTCOMES: Record<string, string> = { both: '✓✓ זמר ושיר', artist: '✓ זמר', lost: '✕ לא זוהה' }
const LANG_NAMES: Record<Lang, string> = { he: 'עברית', en: 'אנגלית' }

const percent = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0)
const show = (value: number) => `${value.toFixed(1)}%`
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date())

export default function Admin() {
  const [password, setPassword] = useState(() => sessionStorage.getItem(PASSWORD_KEY) ?? '')
  const [typed, setTyped] = useState('')
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    document.documentElement.lang = 'he'
    document.documentElement.dir = 'rtl'
    document.title = 'ניהול'
  }, [])

  const load = (candidate: string) =>
    fetchAdminStats(candidate).then(
      (loaded) => {
        sessionStorage.setItem(PASSWORD_KEY, candidate)
        setPassword(candidate)
        setStats(loaded)
        setError('')
      },
      (failure) => {
        sessionStorage.removeItem(PASSWORD_KEY)
        setPassword('')
        setError(failure.status === 401 ? 'סיסמה שגויה' : `לא ניתן לטעון נתונים: ${failure.message}`)
      },
    )
  useEffect(() => {
    if (password) load(password)
  }, [])

  if (!stats) {
    return (
      <div className="admin">
        <form className="dialog" onSubmit={(e) => (e.preventDefault(), load(typed))}>
          <h2>כניסת מנהל</h2>
          <input type="password" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="סיסמה" autoFocus />
          <button className="next" disabled={!typed}>כניסה</button>
          {error && <p className="bad">{error}</p>}
        </form>
      </div>
    )
  }

  const todayRow = stats.days.find((d) => d.day === today())
  return (
    <div className="admin">
      <header>
        <h1>ניהול</h1>
        <div>
          <button className="link" onClick={() => load(password)}>↻ רענון</button>
          <a className="link" href="/">למשחק ←</a>
        </div>
      </header>

      <section className="tiles">
        <Tile label="כניסות היום" value={todayRow?.visits ?? 0} />
        <Tile label="שחקנים היום" value={todayRow?.players ?? 0} />
        <Tile label="סיבובים היום" value={todayRow?.rounds ?? 0} />
        <Tile label="שחקנים סך הכול" value={stats.totals.players} />
        <Tile label="כניסות סך הכול" value={stats.totals.visits} />
        <Tile label="סיבובים סך הכול" value={stats.totals.rounds} />
      </section>

      <section>
        <h2>14 הימים האחרונים</h2>
        <table>
          <thead><tr><th>יום</th><th>כניסות</th><th>שחקנים</th><th>סיבובים</th></tr></thead>
          <tbody>
            {stats.days.map((d) => (
              <tr key={d.day}><td dir="ltr">{d.day}</td><td>{d.visits}</td><td>{d.players}</td><td>{d.rounds}</td></tr>
            ))}
            {!stats.days.length && <tr><td colSpan={4} className="none">עדיין אין נתונים</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h2>סיבובים לפי שפה ורמת קושי</h2>
        <table>
          <thead><tr><th>שפה</th><th>רמה</th><th>סיבובים</th></tr></thead>
          <tbody>
            {stats.breakdown.map((b) => (
              <tr key={b.lang + b.diff}>
                <td>{LANG_NAMES[b.lang]}</td><td>{TEXT.he.difficulties[b.diff - 1]?.label}</td><td>{b.rounds}</td>
              </tr>
            ))}
            {!stats.breakdown.length && <tr><td colSpan={3} className="none">עדיין אין נתונים</td></tr>}
          </tbody>
        </table>
      </section>

      <ShareEditor stats={stats} password={password} onSaved={(shares) => setStats({ ...stats, shares })} />

      <section>
        <h2>פעילות אחרונה</h2>
        <table>
          <thead><tr><th>מתי</th><th>שחקן</th><th>שיר</th><th>זמר</th><th>רמה</th><th>תוצאה</th><th>נקודות</th></tr></thead>
          <tbody>
            {stats.recent.map((r, i) => (
              <tr key={i}>
                <td>{new Date(r.at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{r.nickname ?? '—'}</td>
                <td>{r.title}</td>
                <td>{r.artist}</td>
                <td>{TEXT.he.difficulties[r.diff - 1]?.label}</td>
                <td className={r.outcome === 'lost' ? 'bad' : 'good'}>{OUTCOMES[r.outcome]}</td>
                <td>{r.points}</td>
              </tr>
            ))}
            {!stats.recent.length && <tr><td colSpan={7} className="none">עדיין לא שוחקו סיבובים</td></tr>}
          </tbody>
        </table>
      </section>
    </div>
  )
}

const Tile = (props: { label: string; value: number }) => (
  <div className="tile"><b>{props.value.toLocaleString('he')}</b><span>{props.label}</span></div>
)

// Sets the share of rounds each artist should get. An empty target leaves the artist at
// their natural share, which is simply their part of the song catalog.
function ShareEditor(props: { stats: AdminStats; password: string; onSaved: (shares: Shares) => void }) {
  const [lang, setLang] = useState<Lang>('he')
  const [draft, setDraft] = useState<Record<Lang, Record<string, string>>>(() => ({
    he: Object.fromEntries(Object.entries(props.stats.shares.he ?? {}).map(([name, pct]) => [name, String(pct)])),
    en: Object.fromEntries(Object.entries(props.stats.shares.en ?? {}).map(([name, pct]) => [name, String(pct)])),
  }))
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState('')

  const rows = useMemo(() => {
    const all = artistCounts(lang)
    const key = normalize(filter)
    if (key) return all.filter((artist) => normalize(artist.name).includes(key)).slice(0, VISIBLE_ARTISTS)
    // Artists with a target always stay visible, even when they are not among the biggest.
    const targeted = all.filter((artist, i) => i >= VISIBLE_ARTISTS && artist.name in draft[lang])
    return [...all.slice(0, VISIBLE_ARTISTS), ...targeted]
  }, [lang, filter, draft])

  const played = props.stats.artistRounds.filter((row) => row.lang === lang)
  const playedTotal = played.reduce((sum, row) => sum + row.rounds, 0)
  const playedBy = (name: string) =>
    played.filter((row) => normalize(row.artist).includes(normalize(name))).reduce((sum, row) => sum + row.rounds, 0)

  const targets = Object.values(draft[lang]).map(Number).filter((n) => n > 0)
  const sum = targets.reduce((a, b) => a + b, 0)

  const setTarget = (name: string, value: string) => {
    const next = { ...draft[lang] }
    if (value === '') delete next[name]
    else next[name] = value
    setDraft({ ...draft, [lang]: next })
    setStatus('')
  }
  const save = async () => {
    const clean = (entries: Record<string, string>) =>
      Object.fromEntries(Object.entries(entries).map(([name, pct]) => [name, Number(pct)]).filter(([, pct]) => Number.isFinite(pct)))
    try {
      const saved = await saveShares(props.password, { he: clean(draft.he), en: clean(draft.en) })
      props.onSaved(saved.shares)
      setStatus('נשמר. שחקנים יקבלו את השינוי בכניסה הבאה לאתר.')
    } catch (failure) {
      setStatus(`השמירה נכשלה: ${(failure as Error).message}`)
    }
  }

  return (
    <section>
      <h2>תדירות זמרים</h2>
      <p className="hint">
        "יעד" הוא אחוז הסיבובים שבהם יעלה שיר של הזמר. שדה ריק משאיר את הזמר בחלק הטבעי שלו. היעד חל בתוך הסינון
        שהשחקן בחר, ומוגבל לעד פי 5 מהחלק הטבעי של הזמר באותו סינון, כדי ששירים לא יחזרו על עצמם.
      </p>
      <div className="toolbar">
        {(['he', 'en'] as Lang[]).map((l) => (
          <button key={l} className={`pill d1 ${lang === l ? 'on' : ''}`} onClick={() => setLang(l)}>{LANG_NAMES[l]}</button>
        ))}
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="חיפוש זמר" />
      </div>
      <table>
        <thead><tr><th>זמר</th><th>שירים במאגר</th><th>חלק טבעי</th><th>בפועל (30 יום)</th><th>יעד %</th></tr></thead>
        <tbody>
          {rows.map((artist) => (
            <tr key={artist.name}>
              <td>{artist.name}</td>
              <td>{artist.songs}</td>
              <td>{show(percent(artist.songs, catalogs[lang].length))}</td>
              <td>{playedTotal ? show(percent(playedBy(artist.name), playedTotal)) : '—'}</td>
              <td>
                <input
                  type="number" min="0" max="100" step="0.5" placeholder="טבעי"
                  value={draft[lang][artist.name] ?? ''}
                  onChange={(e) => setTarget(artist.name, e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="toolbar">
        <button className="next" onClick={save} disabled={sum > 100}>שמירה</button>
        <span className={sum > 100 ? 'bad' : 'hint'}>סך היעדים ב{LANG_NAMES[lang]}: {show(sum)}{sum > 100 ? ' (מעל 100%)' : ''}</span>
        {status && <span className="hint">{status}</span>}
      </div>
    </section>
  )
}
