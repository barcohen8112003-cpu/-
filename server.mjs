// Serves the built site (dist/) and the small API behind the admin panel:
// visit and round tracking, and the per-artist share settings.
import { createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { openDatabase } from './server/db.mjs'
import defaultShares from './src/data/default-shares.json' with { type: 'json' }

const ROOT = join(import.meta.dirname, 'dist')
const PORT = process.env.PORT || 3001
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD
const TIMEZONE = 'Asia/Jerusalem' // days in the admin panel are local days
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const db = await openDatabase()

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}
const check = (ok, message) => {
  if (!ok) throw new HttpError(400, message)
}
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max
const LANGS = ['he', 'en']

async function readJson(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 20_000) throw new HttpError(413, 'Body too large')
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

// The tracking endpoints are open to anyone, so each address gets a per-minute budget.
const budget = new Map()
function rateLimit(req) {
  const ip = (req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || req.socket.remoteAddress
  const now = Date.now()
  const entry = budget.get(ip)
  if (!entry || entry.reset < now) budget.set(ip, { count: 1, reset: now + 60_000 })
  else if (++entry.count > 120) throw new HttpError(429, 'Too many requests')
  if (budget.size > 10_000) for (const [key, value] of budget) if (value.reset < now) budget.delete(key)
}

const digest = (value) => createHash('sha256').update(value).digest()
function requireAdmin(req) {
  if (!ADMIN_PASSWORD) throw new HttpError(503, 'ADMIN_PASSWORD is not configured on the server')
  const given = (req.headers.authorization ?? '').replace(/^Bearer /, '')
  if (!timingSafeEqual(digest(given), digest(ADMIN_PASSWORD))) throw new HttpError(401, 'Wrong password')
}

async function upsertPlayer(body) {
  check(typeof body.playerId === 'string' && /^[a-z0-9-]{8,40}$/i.test(body.playerId), 'Bad playerId')
  check(text(body.nickname, 24), 'Bad nickname')
  await db.query(
    'INSERT INTO players (id, nickname) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET nickname = EXCLUDED.nickname',
    [body.playerId, body.nickname.trim()],
  )
}

async function getShares() {
  const { rows } = await db.query("SELECT value FROM settings WHERE key = 'shares'")
  return rows.length ? JSON.parse(rows[0].value) : defaultShares
}

const day = (column) => `to_char(${column} AT TIME ZONE '${TIMEZONE}', 'YYYY-MM-DD')`

const routes = {
  'GET /api/config': async () => ({ shares: await getShares() }),

  // A page load. `rename` only updates the nickname, without counting a visit.
  'POST /api/visit': async (req) => {
    rateLimit(req)
    const body = await readJson(req)
    check(LANGS.includes(body.lang), 'Bad lang')
    await upsertPlayer(body)
    if (!body.rename) await db.query('INSERT INTO visits (player_id, lang) VALUES ($1, $2)', [body.playerId, body.lang])
    return {}
  },

  'POST /api/round': async (req) => {
    rateLimit(req)
    const body = await readJson(req)
    const { song = {} } = body
    check(LANGS.includes(body.lang), 'Bad lang')
    check(Number.isInteger(body.diff) && body.diff >= 1 && body.diff <= 5, 'Bad diff')
    check(['both', 'artist', 'lost'].includes(body.outcome), 'Bad outcome')
    check(Number.isInteger(body.points) && body.points >= 0 && body.points <= 150, 'Bad points')
    check(text(song.id, 20) && text(song.title, 80) && text(song.artist, 80), 'Bad song')
    await upsertPlayer(body)
    await db.query(
      'INSERT INTO rounds (player_id, song_id, title, artist, lang, diff, outcome, points) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [body.playerId, song.id, song.title, song.artist, body.lang, body.diff, body.outcome, body.points],
    )
    return {}
  },

  'GET /api/admin/stats': async (req) => {
    requireAdmin(req)
    const [totals, visitDays, roundDays, breakdown, recent, artists, shares] = await Promise.all([
      db.query(`SELECT (SELECT count(*)::int FROM players) AS players,
                       (SELECT count(*)::int FROM visits) AS visits,
                       (SELECT count(*)::int FROM rounds) AS rounds`),
      db.query(`SELECT ${day('at')} AS day, count(*)::int AS visits, count(DISTINCT player_id)::int AS players
                FROM visits WHERE at > now() - interval '14 days' GROUP BY 1`),
      db.query(`SELECT ${day('at')} AS day, count(*)::int AS rounds
                FROM rounds WHERE at > now() - interval '14 days' GROUP BY 1`),
      db.query('SELECT lang, diff, count(*)::int AS rounds FROM rounds GROUP BY 1, 2 ORDER BY 1, 2'),
      db.query(`SELECT r.at, p.nickname, r.title, r.artist, r.lang, r.diff, r.outcome, r.points
                FROM rounds r LEFT JOIN players p ON p.id = r.player_id ORDER BY r.at DESC LIMIT 50`),
      db.query(`SELECT lang, artist, count(*)::int AS rounds FROM rounds
                WHERE at > now() - interval '30 days' GROUP BY 1, 2`),
      getShares(),
    ])
    const days = new Map()
    for (const row of [...visitDays.rows, ...roundDays.rows]) {
      days.set(row.day, { visits: 0, players: 0, rounds: 0, ...days.get(row.day), ...row })
    }
    return {
      totals: totals.rows[0],
      days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
      breakdown: breakdown.rows,
      recent: recent.rows,
      artistRounds: artists.rows,
      shares,
    }
  },

  // Replaces the target share (percent of rounds) per artist, for both languages.
  'PUT /api/admin/shares': async (req) => {
    requireAdmin(req)
    const body = await readJson(req)
    const shares = {}
    for (const lang of LANGS) {
      const entries = Object.entries(body[lang] ?? {})
      check(entries.length <= 300, 'Too many artists')
      check(entries.every(([name, pct]) => text(name, 80) && typeof pct === 'number' && pct >= 0 && pct <= 100), 'Bad share')
      check(entries.reduce((sum, [, pct]) => sum + pct, 0) <= 100, 'Shares add up to more than 100%')
      shares[lang] = Object.fromEntries(entries)
    }
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('shares', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [JSON.stringify(shares)],
    )
    return { shares }
  },
}

function serveFile(pathname, res) {
  let file = join(ROOT, normalize(decodeURIComponent(pathname)))
  // Anything that is not a real file inside dist/ gets the app page (this also serves /admin).
  if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, 'index.html')
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    // Built assets carry a content hash in their name, so they can be cached for good.
    'Cache-Control': file.includes(join(ROOT, 'assets')) ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x')
  if (!pathname.startsWith('/api/')) return serveFile(pathname, res)

  let status = 200
  let body
  try {
    const route = routes[`${req.method} ${pathname}`]
    if (!route) throw new HttpError(404, 'Not found')
    body = await route(req)
  } catch (error) {
    status = error.status ?? 500
    body = { error: error.status ? error.message : 'Server error' }
    if (!error.status) console.error(error)
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}).listen(PORT, () => console.log(`Listening on port ${PORT}`))
