// Applies database migrations during the production build, using the
// SUPABASE_DB_URL shared variable (Session pooler string). Preview and local
// builds never touch the database. A failed migration fails the build, so new
// code never ships against a half-migrated schema.
//
// After migrating it prints two read-only checks to the build log:
//   - whether the live Supabase API accepts the `todo` schema
//   - policies in other schemas that let any signed-in user read everything.
//     This project shares one user list with other apps, so a To Do Dash user
//     would pass those policies.

import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { applyMigrations } from './lib/migrations.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.env.VERCEL_ENV !== 'production') {
  console.log(`[migrate] skipped: VERCEL_ENV=${process.env.VERCEL_ENV ?? 'local'}`)
  process.exit(0)
}

const raw = process.env.SUPABASE_DB_URL
if (!raw) {
  console.error('[migrate] SUPABASE_DB_URL is not set. Refusing to deploy without a database.')
  process.exit(1)
}

// sslmode in the URL would override the ssl object below and turn off
// certificate checks, so strip it and verify against Supabase's root CA.
const url = new URL(raw)
if (!/^postgres(ql)?:$/.test(url.protocol)) {
  console.error(`[migrate] SUPABASE_DB_URL is a ${url.protocol}// address, not a database connection string.`)
  console.error('[migrate] Use Supabase > Connect > Session pooler. It starts with postgresql://')
  process.exit(1)
}
url.searchParams.delete('sslmode')
// Shape checks on the password. They report which mistake it is, never the value.
const pw = decodeURIComponent(url.password)
if (!pw) {
  console.error('[migrate] SUPABASE_DB_URL has no password in it.')
  process.exit(1)
}
if (/YOUR-PASSWORD/i.test(pw) || /^\[.*\]$/.test(pw)) {
  console.error('[migrate] SUPABASE_DB_URL still has the [YOUR-PASSWORD] placeholder or its brackets.')
  process.exit(1)
}
if (/%[0-9a-f]{2}/i.test(pw)) {
  console.error('[migrate] The password is encoded twice (it still contains %xx after decoding). Encode it once.')
  process.exit(1)
}
if (url.port === '6543') {
  console.error('[migrate] SUPABASE_DB_URL is the Transaction pooler (6543). Use the Session pooler string (port 5432).')
  process.exit(1)
}
console.log(`[migrate] target ${url.hostname}:${url.port || '5432'} as ${decodeURIComponent(url.username)}`)
if (/^db\.[a-z0-9]+\.supabase\.co$/.test(url.hostname)) {
  console.error('[migrate] SUPABASE_DB_URL is the Direct connection, which is IPv6 only and unreachable from Vercel builds.')
  console.error('[migrate] Use Supabase > Connect > Session pooler instead (host ends in pooler.supabase.com, port 5432).')
  process.exit(1)
}

const client = new pg.Client({
  connectionString: url.toString(),
  ssl: { ca: await readFile(join(root, 'certs/supabase-prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
})

try {
  await client.connect()
  console.log('[migrate] connected')
  await applyMigrations(client, join(root, 'supabase/migrations'))

  await checkApiExposure()

  const { rows: open } = await client.query(`
    select schemaname, tablename, policyname, cmd
    from pg_policies
    where schemaname not in ('todo', 'auth', 'storage', 'realtime', 'supabase_functions', 'vault', 'graphql', 'extensions')
      and (roles && array['authenticated', 'public']::name[])
      and coalesce(qual, 'true') = 'true'
    order by 1, 2, 3`)
  if (open.length === 0) {
    console.log('[migrate] audit: no other-app policy lets every signed-in user through')
  } else {
    console.log(`[migrate] audit: ${open.length} policies in other apps allow any signed-in user:`)
    for (const p of open) console.log(`[migrate]   ${p.schemaname}.${p.tablename} ${p.cmd} "${p.policyname}"`)
  }
} catch (err) {
  console.error(`[migrate] failed: ${err.message}`)
  process.exit(1)
} finally {
  await client.end().catch(() => {})
}

// Asks the live API for a todo table. PGRST106 means the schema is not in the
// exposed list. Any other answer, including a permission error for the
// anonymous key, means the API accepted the schema.
async function checkApiExposure() {
  const base = process.env.SUPABASE_LOCATION
  const key = process.env.SUPABASE_PUBLISHABLE_KEY
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/rest/v1/presets?select=id&limit=1`, {
      headers: { apikey: key, 'Accept-Profile': 'todo' },
      signal: AbortSignal.timeout(10000),
    })
    const body = await res.json().catch(() => ({}))
    if (body?.code === 'PGRST106') {
      console.log('[migrate] WARNING the API does not expose the todo schema. Add it under Settings > Data API > Exposed schemas.')
    } else {
      console.log(`[migrate] API accepts the todo schema (HTTP ${res.status}${body?.code ? `, ${body.code}` : ''})`)
    }
  } catch (err) {
    console.log(`[migrate] WARNING could not reach the Supabase API to check the schema: ${err.message}`)
  }
}
