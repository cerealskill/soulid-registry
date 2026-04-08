import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createClient } from '@libsql/client/web'
import { handle } from 'hono/vercel'

export const config = { runtime: 'edge' }

const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}))

function getDB() {
  let url = process.env.TURSO_URL
  const authToken = process.env.TURSO_TOKEN
  if (!url || !authToken) {
    throw new Error(`Missing env vars: TURSO_URL=${!!url} TURSO_TOKEN=${!!authToken}`)
  }
  url = url.replace(/^libsql:\/\//, 'https://')
  return createClient({ url, authToken })
}

async function ensureTable(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS souls (
      soul_id    TEXT PRIMARY KEY,
      name       TEXT,
      archetype  TEXT,
      document   TEXT NOT NULL,
      owner_id   TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  // migrate: add archetype column if missing (idempotent)
  try {
    await db.execute('ALTER TABLE souls ADD COLUMN archetype TEXT')
  } catch (_) { /* already exists */ }
}

function authCheck(c) {
  const auth = c.req.header('Authorization')
  return auth === `Bearer ${process.env.REGISTRY_API_KEY}`
}

// ── GET /health ──
app.get('/health', (c) => {
  return c.json({ status: 'ok', service: 'soulid-registry', version: '0.1.0' })
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

  return c.json(JSON.parse(result.rows[0].document))
})

// ── GET /souls ──
// Query params: archetype, owner, limit (max 100), offset, q (name search)
app.get('/souls', async (c) => {
  const db = getDB()
  await ensureTable(db)

  const limit  = Math.min(parseInt(c.req.query('limit')  || '20'), 100)
  const offset = parseInt(c.req.query('offset') || '0')
  const archetype = c.req.query('archetype') || null
  const owner     = c.req.query('owner')     || null
  const q         = c.req.query('q')         || null

  let sql  = 'SELECT soul_id, name, archetype, owner_id, created_at FROM souls WHERE 1=1'
  const args = []

  if (archetype) { sql += ' AND archetype = ?';          args.push(archetype) }
  if (owner)     { sql += ' AND owner_id = ?';           args.push(owner) }
  if (q)         { sql += ' AND name LIKE ?';            args.push(`%${q}%`) }

  // total count
  const countResult = await db.execute({ sql: sql.replace('SELECT soul_id, name, archetype, owner_id, created_at', 'SELECT COUNT(*) as total'), args })
  const total = Number(countResult.rows[0].total)

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  args.push(limit, offset)

  const result = await db.execute({ sql, args })

  return c.json({
    total,
    limit,
    offset,
    items: result.rows.map(r => ({
      soul_id:    r.soul_id,
      name:       r.name,
      archetype:  r.archetype,
      owner_id:   r.owner_id,
      created_at: r.created_at,
    })),
  })
})

// ── POST /publish ──
app.post('/publish', async (c) => {
  if (!authCheck(c)) return c.json({ error: 'unauthorized' }, 401)

  let body
  try { body = await c.req.json() }
  catch { return c.json({ error: 'invalid_json' }, 400) }

  const { soul_id, name, owner, archetype } = body
  if (!soul_id || !name) {
    return c.json({ error: 'missing_fields', required: ['soul_id', 'name'] }, 400)
  }

  if (!/^[a-z0-9_-]+:[a-z0-9_-]+:v\d+:[a-z0-9_-]+$/.test(soul_id)) {
    return c.json({
      error: 'invalid_soul_id',
      format: 'namespace:archetype:version:instance (e.g. soulid:custodian:v1:001)',
    }, 400)
  }

  const now = Date.now()
  const db = getDB()
  await ensureTable(db)

  await db.execute({
    sql: `INSERT INTO souls (soul_id, name, archetype, document, owner_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(soul_id) DO UPDATE SET
            name       = excluded.name,
            archetype  = excluded.archetype,
            document   = excluded.document,
            owner_id   = excluded.owner_id,
            updated_at = excluded.updated_at`,
    args: [soul_id, name, archetype || null, JSON.stringify(body), owner?.id || null, now, now],
  })

  return c.json({ ok: true, soul_id }, 201)
})

// ── GET /download/:soul_id ──
// Query: runtime = openclaw | codex | claude-code | gemini-cli | aider | continue | cursor
// Returns the correct file content + filename for the requested runtime
app.get('/download/:soul_id', async (c) => {
  const soulId  = c.req.param('soul_id')
  const runtime = c.req.query('runtime') || 'openclaw'

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

  const RUNTIME_MAP = {
    openclaw:    { file: 'SOUL.md',          type: 'text/markdown' },
    codex:       { file: 'AGENTS.md',        type: 'text/markdown' },
    'claude-code':{ file: 'CLAUDE.md',       type: 'text/markdown' },
    'gemini-cli':{ file: 'GEMINI.md',        type: 'text/markdown' },
    aider:       { file: 'CONVENTIONS.md',   type: 'text/markdown' },
    continue:    { file: '.continuerules',   type: 'text/markdown' },
    cursor:      { file: '.cursorrules',     type: 'text/plain' },
    raw:         { file: 'soul.json',        type: 'application/json' },
  }

  const target = RUNTIME_MAP[runtime] || RUNTIME_MAP['openclaw']

  // soul.json → raw download
  if (runtime === 'raw') {
    c.header('Content-Disposition', `attachment; filename="soul.json"`)
    c.header('Content-Type', 'application/json')
    return c.text(JSON.stringify(doc, null, 2))
  }

  // Generate runtime-specific file from soul doc
  const content = generateRuntimeFile(doc, runtime)

  c.header('Content-Disposition', `attachment; filename="${target.file}"`)
  c.header('Content-Type', target.type)
  return c.text(content)
})

function generateRuntimeFile(doc, runtime) {
  const {
    soul_id, name, archetype, purpose, values = [],
    capabilities = [], runtime_hints = {}
  } = doc

  const valList  = values.map(v => `- ${v}`).join('\n')
  const capList  = capabilities.map(c => `- ${c}`).join('\n')
  const model    = runtime_hints.model || 'claude-sonnet'
  const tags     = (runtime_hints.tags || []).join(', ')
  const slug     = runtime_hints.slug || soul_id.split(':')[1]

  const soulBlock = `<!-- soul:start -->
<!-- soul_id: ${soul_id} -->
<!-- adapter: ${runtime} | soulid.io -->
<!-- soul:end -->`

  switch (runtime) {
    case 'openclaw':
      return `# SOUL.md — ${name}

${soulBlock}

_You are ${name}. ${purpose}_

## Identity

- **Soul ID:** \`${soul_id}\`
- **Archetype:** ${archetype}
- **Model:** ${model}

## Core Values

${valList}

## Capabilities

${capList}

## Instructions

${purpose}

---
_Generated by [SOUL ID](https://soulid.io) · ${new Date().toISOString().split('T')[0]}_
`

    case 'codex':
      return `# AGENTS.md — ${name}

${soulBlock}

## Identity
- **Name:** ${name}
- **Soul ID:** \`${soul_id}\`
- **Purpose:** ${purpose}

## Guidelines

${valList}

## Capabilities available
${capList}

## Instructions

${purpose}

---
_Generated by [SOUL ID](https://soulid.io) for Codex CLI · ${new Date().toISOString().split('T')[0]}_
`

    case 'claude-code':
      return `# CLAUDE.md — ${name}

${soulBlock}

## Soul Identity
- **Name:** ${name}
- **Soul ID:** \`${soul_id}\`
- **Archetype:** ${archetype}
- **Purpose:** ${purpose}
- **Values:** ${values.join(', ')}

## Instructions

${purpose}

## Capabilities
${capList}

## Memory

Use \`.memory/<topic>.md\` for persistent context. Load topic files on demand.
Never reload full history — grep transcripts for identifiers.

---
_Generated by [SOUL ID](https://soulid.io) for Claude Code · ${new Date().toISOString().split('T')[0]}_
`

    case 'gemini-cli':
      return `# GEMINI.md — ${name}

${soulBlock}

## Identity
- **Name:** ${name}
- **Soul ID:** \`${soul_id}\`
- **Purpose:** ${purpose}

## Values
${valList}

## Capabilities
${capList}

## Instructions

${purpose}

---
_Generated by [SOUL ID](https://soulid.io) for Gemini CLI · ${new Date().toISOString().split('T')[0]}_
`

    case 'aider':
      return `# CONVENTIONS.md — ${name}

${soulBlock}

## Identity
- **Name:** ${name}
- **Soul ID:** \`${soul_id}\`
- **Purpose:** ${purpose}

## Principles
${valList}

## Capabilities
${capList}

## Coding conventions

${purpose}

---
_Generated by [SOUL ID](https://soulid.io) for Aider · ${new Date().toISOString().split('T')[0]}_
`

    case 'continue':
      return `<!-- soul_id: ${soul_id} | adapter: continue | soulid.io -->

# ${name} — Rules

## Identity
- **Name:** ${name}
- **Soul ID:** \`${soul_id}\`
- **Purpose:** ${purpose}

## Principles
${valList}

## Instructions

${purpose}

---
_Generated by [SOUL ID](https://soulid.io) for Continue.dev · ${new Date().toISOString().split('T')[0]}_
`

    case 'cursor':
      return `<!-- soul_id: ${soul_id} | adapter: cursor | soulid.io -->
# ${name}

${purpose}

## Values
${valList}

## Capabilities
${capList}

---
Generated by SOUL ID (https://soulid.io) for Cursor · ${new Date().toISOString().split('T')[0]}
`

    default:
      return JSON.stringify(doc, null, 2)
  }
}

// ── DELETE /souls (bulk) ──
app.delete('/souls', async (c) => {
  if (!authCheck(c)) return c.json({ error: 'unauthorized' }, 401)
  const db = getDB()
  await ensureTable(db)
  const result = await db.execute('DELETE FROM souls')
  return c.json({ ok: true, deleted: result.rowsAffected })
})

// ── DELETE /souls/:soul_id ──
app.delete('/souls/:soul_id', async (c) => {
  if (!authCheck(c)) return c.json({ error: 'unauthorized' }, 401)

  const soulId = c.req.param('soul_id')
  const db = getDB()
  await ensureTable(db)

  const result = await db.execute({
    sql: 'DELETE FROM souls WHERE soul_id = ?',
    args: [soulId],
  })

  if (result.rowsAffected === 0) {
    return c.json({ error: 'not_found', soul_id: soulId }, 404)
  }

  return c.json({ ok: true, soul_id: soulId })
})

export default handle(app)
