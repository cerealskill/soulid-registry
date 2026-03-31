import { Hono } from 'hono'
import { createClient } from '@libsql/client/web'
import { handle } from 'hono/vercel'

export const config = { runtime: 'edge' }

const app = new Hono()

function getDB() {
  let url = process.env.TURSO_URL
  const authToken = process.env.TURSO_TOKEN
  if (!url || !authToken) {
    throw new Error(`Missing env vars: TURSO_URL=${!!url} TURSO_TOKEN=${!!authToken}`)
  }
  // Edge runtime requires https:// not libsql://
  url = url.replace(/^libsql:\/\//, 'https://')
  return createClient({ url, authToken })
}

async function ensureTable(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS souls (
      soul_id    TEXT PRIMARY KEY,
      name       TEXT,
      document   TEXT NOT NULL,
      owner_id   TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
}

// ── GET /health ──
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    service: 'soulid-registry',
    version: '0.1.0',
    env: {
      turso_url: !!process.env.TURSO_URL,
      turso_token: !!process.env.TURSO_TOKEN,
      api_key: !!process.env.REGISTRY_API_KEY,
    }
  })
})

// ── GET /ping-db ── (debug)
app.get('/ping-db', async (c) => {
  try {
    const db = getDB()
    await db.execute('SELECT 1')
    return c.json({ ok: true })
  } catch (e) {
    return c.json({ ok: false, error: e.message, stack: e.stack?.slice(0, 300) }, 500)
  }
})

// ── GET /resolve/:soul_id ──
app.get('/resolve/:soul_id', async (c) => {
  const soulId = c.req.param('soul_id')
  const db = getDB()
  await ensureTable(db)

  const result = await db.execute({
    sql: 'SELECT document FROM souls WHERE soul_id = ?',
    args: [soulId],
  })

  if (result.rows.length === 0) {
    return c.json({ error: 'not_found', soul_id: soulId }, 404)
  }

  const doc = JSON.parse(result.rows[0].document)
  return c.json(doc)
})

// ── GET /list ──
app.get('/list', async (c) => {
  const db = getDB()
  await ensureTable(db)

  const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100)
  const offset = parseInt(c.req.query('offset') || '0')

  const result = await db.execute({
    sql: 'SELECT soul_id, name, owner_id, created_at FROM souls ORDER BY created_at DESC LIMIT ? OFFSET ?',
    args: [limit, offset],
  })

  return c.json({
    items: result.rows.map(r => ({
      soul_id: r.soul_id,
      name: r.name,
      owner_id: r.owner_id,
      created_at: r.created_at,
    })),
    limit,
    offset,
  })
})

// ── POST /publish ──
app.post('/publish', async (c) => {
  // Auth
  const auth = c.req.header('Authorization')
  if (!auth || auth !== `Bearer ${process.env.REGISTRY_API_KEY}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  let body
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const { soul_id, name, owner } = body
  if (!soul_id || !name) {
    return c.json({ error: 'missing_fields', required: ['soul_id', 'name'] }, 400)
  }

  // Validate soul_id format: namespace:archetype:version:instance
  if (!/^[a-z0-9_-]+:[a-z0-9_-]+:v\d+:[a-z0-9_-]+$/.test(soul_id)) {
    return c.json({
      error: 'invalid_soul_id',
      format: 'namespace:archetype:version:instance (e.g. soulid:custodian:v1:001)',
    }, 400)
  }

  const now = Date.now()
  const db = getDB()
  await ensureTable(db)

  // Upsert
  await db.execute({
    sql: `INSERT INTO souls (soul_id, name, document, owner_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(soul_id) DO UPDATE SET
            name = excluded.name,
            document = excluded.document,
            owner_id = excluded.owner_id,
            updated_at = excluded.updated_at`,
    args: [
      soul_id,
      name,
      JSON.stringify(body),
      owner?.id || null,
      now,
      now,
    ],
  })

  return c.json({ ok: true, soul_id }, 201)
})

// ── DELETE /soul/:soul_id ──
app.delete('/soul/:soul_id', async (c) => {
  const auth = c.req.header('Authorization')
  if (!auth || auth !== `Bearer ${process.env.REGISTRY_API_KEY}`) {
    return c.json({ error: 'unauthorized' }, 401)
  }

  const soulId = c.req.param('soul_id')
  const db = getDB()
  await ensureTable(db)

  await db.execute({
    sql: 'DELETE FROM souls WHERE soul_id = ?',
    args: [soulId],
  })

  return c.json({ ok: true, soul_id: soulId })
})

export default handle(app)
