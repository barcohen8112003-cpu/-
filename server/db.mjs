// Opens the database: Postgres when DATABASE_URL is set (production), otherwise an
// embedded Postgres stored on disk, so the same SQL runs on a developer machine.

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS players (
    id text PRIMARY KEY,
    nickname text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS visits (
    id bigserial PRIMARY KEY,
    player_id text NOT NULL,
    lang text NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS rounds (
    id bigserial PRIMARY KEY,
    player_id text NOT NULL,
    song_id text NOT NULL,
    title text NOT NULL,
    artist text NOT NULL,
    lang text NOT NULL,
    diff int NOT NULL,
    outcome text NOT NULL,
    points int NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS visits_at ON visits (at);
  CREATE INDEX IF NOT EXISTS rounds_at ON rounds (at);
  CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL);
`

export async function openDatabase() {
  const url = process.env.DATABASE_URL
  let db
  if (url) {
    const { default: pg } = await import('pg')
    // Render's external address needs TLS; its internal one (a bare host name) does not.
    const external = new URL(url).hostname.includes('.')
    const pool = new pg.Pool({ connectionString: url, ssl: external ? { rejectUnauthorized: false } : false, max: 5 })
    db = { query: (sql, params) => pool.query(sql, params), exec: (sql) => pool.query(sql) }
  } else {
    console.warn('DATABASE_URL is not set: using a local embedded database (data stays on this machine only).')
    const { PGlite } = await import('@electric-sql/pglite')
    const { mkdir } = await import('node:fs/promises')
    // The cache folder is not in git, so it does not exist on a fresh checkout.
    await mkdir('scripts/.cache', { recursive: true })
    const lite = new PGlite('scripts/.cache/pglite')
    db = { query: (sql, params) => lite.query(sql, params), exec: (sql) => lite.exec(sql) }
  }
  await db.exec(SCHEMA)
  return db
}
