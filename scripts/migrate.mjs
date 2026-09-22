// Applies database migrations during the production build, using the
// SUPABASE_DB_URL shared variable (Session pooler string). Preview and local
// builds never touch the database. A failed migration fails the build, so new
// code never ships against a half-migrated schema.
//
// After migrating it prints two read-only checks to the build log:
//   - whether the `todo` schema is exposed to the Supabase API
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
url.searchParams.delete('sslmode')
if (url.port === '6543') {
  console.error('[migrate] SUPABASE_DB_URL is the Transaction pooler (6543). Use the Session pooler string (port 5432).')
  process.exit(1)
}
const client = new pg.Client({
  connectionString: url.toString(),
  ssl: { ca: await readFile(join(root, 'certs/supabase-prod-ca-2021.crt'), 'utf8'), rejectUnauthorized: true },
  connectionTimeoutMillis: 15000,
})

try {
  await client.connect()
  console.log(`[migrate] connected to ${url.hostname}`)
  await applyMigrations(client, join(root, 'supabase/migrations'))

  const { rows: cfg } = await client.query(
    "select unnest(rolconfig) as setting from pg_roles where rolname = 'authenticator'")
  const schemas = cfg.map((r) => r.setting).find((s) => s.startsWith('pgrst.db_schemas='))
  if (schemas && schemas.split('=')[1].split(',').map((s) => s.trim()).includes('todo')) {
    console.log('[migrate] todo schema is exposed to the API')
  } else {
    console.log('[migrate] WARNING todo schema is not exposed to the API. Add it under Settings > API > Exposed schemas.')
  }

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
