# Working in this repo

To Do Dash: a household PWA for recurring tasks. `SPEC.md` is the contract for
what it does. This file is what you need to know to change it without breaking
production.

## Read this before touching the database or deploys

**The Supabase project is shared with other apps.** Everything this app owns
lives in the `todo` schema. Never create or alter anything outside it. The auth
user list is shared too, so every read path is gated on having a row in
`todo.profiles`, and the migration step prints any policy in other schemas that
lets every signed-in user through.

**Migrations run during the production build.** `scripts/migrate.mjs` applies
`supabase/migrations/*.sql` in order, each in a transaction, and records a
checksum. Editing an applied migration fails the build on purpose. Add a new
file instead. Preview builds never touch the database.

**`SUPABASE_DB_URL` must be the Session pooler string.** Host ends in
`pooler.supabase.com`, port 5432, user `postgres.<project-ref>`. The Direct
connection (`db.<ref>.supabase.co`) is IPv6 only and Vercel builds cannot reach
it. The Transaction pooler (6543) cannot hold the migration lock. The migrate
script rejects all of these with a message naming the problem.

**The database password is not the Supabase account login.** Signing in with
GitHub does not give you one. Reset it under Database > Settings. Special
characters in it must be percent-encoded in the URL; letters and digits only
avoids the problem.

**Credentials are team-shared Vercel variables, linked to this project.**
Vercel's project env API does not list linked shared variables, so
`scripts/check-env.mjs` prints the names the build can see (never values) and
fails a production build if a required one is missing. `SUPABASE_PRIVATE_KEY`
must stay unlinked: it bypasses every policy in the shared project.

**Redeploying through the API can reuse the old deployment's variables.** After
changing a variable, deploy from a new commit so the build reads current values.

**Supabase's certificate is pinned.** `certs/supabase-prod-ca-2021.crt` is the
root CA; the migration connection verifies against it rather than turning
verification off.

## Layout

```
SPEC.md                         product decisions, data model, build order
presets/DRAFT.md                preset task content awaiting approval
supabase/migrations/            schema, RLS and every state-changing function
supabase/test/supabase-stub.sql the slice of Supabase the tests emulate
scripts/check-env.mjs           build-time variable check
scripts/migrate.mjs             build-time migrations + audit report
scripts/lib/migrations.mjs      migration runner shared by deploy and tests
scripts/test-db.mjs             database guardrails against local Postgres
src/                            the app
```

## Conventions

State changes happen in Postgres functions, never in React. The browser reads
through row level security and calls `todo.*` functions for every write. A
permission rule that exists only in the UI does not exist.

Dates that mean a day are `date` in the family's time zone. Tests pin "today"
with `todo.today_override`, which is ignored for API connections.

Every rule gets a test that fails when the rule is broken. Before trusting a
new test, break the rule it covers and watch it fail.

## Verifying

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
npm run build
```

`npm test` needs a local Postgres it may create and drop `todo_test` on. It
refuses to run against a Supabase host.
