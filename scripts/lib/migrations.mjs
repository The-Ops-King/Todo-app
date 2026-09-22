// Applies supabase/migrations/*.sql in filename order, each in its own
// transaction, and records them in todo.schema_migrations with a checksum.
// A file that changes after it was applied is an error, not a silent skip:
// the database and the repo would otherwise disagree about the schema.

import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const LOCK_KEY = 7163422 // arbitrary, constant: one migrator at a time

export async function applyMigrations(client, dir, log = console.log) {
  await client.query('select pg_advisory_lock($1)', [LOCK_KEY])
  try {
    await client.query('create schema if not exists todo')
    await client.query(`
      create table if not exists todo.schema_migrations (
        name        text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default now()
      )`)
    await client.query('revoke all on todo.schema_migrations from public')

    const { rows } = await client.query('select name, checksum from todo.schema_migrations')
    const applied = new Map(rows.map((r) => [r.name, r.checksum]))

    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()
    let ran = 0
    for (const name of files) {
      const sql = await readFile(join(dir, name), 'utf8')
      const checksum = createHash('sha256').update(sql).digest('hex')
      if (applied.has(name)) {
        if (applied.get(name) !== checksum) {
          throw new Error(`${name} changed after it was applied. Add a new migration instead of editing it.`)
        }
        continue
      }
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into todo.schema_migrations (name, checksum) values ($1, $2)', [name, checksum])
        await client.query('commit')
      } catch (err) {
        await client.query('rollback')
        throw new Error(`${name} failed: ${err.message}`)
      }
      log(`[migrate] applied ${name}`)
      ran++
    }
    log(`[migrate] ${ran} applied, ${files.length - ran} already in place`)
    return ran
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY])
  }
}
