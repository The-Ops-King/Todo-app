// Database guardrails. Runs every migration against a throwaway local
// Postgres database and exercises the recurrence rules and every permission
// boundary as real users would hit them: role `authenticated`, identity from
// request.jwt.claims, exactly as PostgREST does it on Supabase.
//
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:db
//
// The URL must point at a server where this script may create and drop the
// `todo_test` database. Never point it at Supabase.

import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { applyMigrations } from './lib/migrations.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const adminUrl = process.env.TEST_DATABASE_URL
if (!adminUrl) {
  console.error('TEST_DATABASE_URL is not set')
  process.exit(1)
}
if (/supabase\.(co|com)/.test(adminUrl)) {
  console.error('TEST_DATABASE_URL points at Supabase. This script drops databases. Refusing.')
  process.exit(1)
}

// --- setup ------------------------------------------------------------------

const admin = new pg.Client({ connectionString: adminUrl })
await admin.connect()
await admin.query('drop database if exists todo_test')
await admin.query('create database todo_test')
await admin.end()

const testUrl = new URL(adminUrl)
testUrl.pathname = '/todo_test'
const db = new pg.Client({ connectionString: testUrl.toString() })
await db.connect()
await db.query(await readFile(join(root, 'supabase/test/supabase-stub.sql'), 'utf8'))
await applyMigrations(db, join(root, 'supabase/migrations'), () => {})

// --- tiny harness -----------------------------------------------------------

let passed = 0
const failures = []
let reported = false
// A rule broken badly enough can make a later step throw instead of failing a
// check. Say so plainly rather than leaving only a stack trace.
process.on('exit', (code) => {
  if (!reported) console.error(`test-db: crashed after ${passed} passed, ${failures.length} failed (exit ${code})`)
})
let today = '2026-09-22'

function check(name, cond, detail = '') {
  if (cond) passed++
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

// Run fn inside one transaction as `uid`, the way a browser request runs.
// Kid devices hold anonymous sessions; their claims say so, as Supabase's do.
const anonymous = new Set()

async function as(uid, fn) {
  await db.query('begin')
  try {
    await db.query('set local role authenticated')
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      uid ? JSON.stringify({ sub: uid, role: 'authenticated', is_anonymous: anonymous.has(uid) }) : '',
    ])
    await db.query("select set_config('todo.today_override', $1, true)", [today])
    const out = await fn({
      q: (sql, params) => db.query(sql, params),
      one: async (sql, params) => (await db.query(sql, params)).rows[0],
      rows: async (sql, params) => (await db.query(sql, params)).rows,
    })
    await db.query('commit')
    return out
  } catch (err) {
    await db.query('rollback')
    throw err
  }
}

async function fails(name, uid, fn, pattern) {
  try {
    await as(uid, fn)
    failures.push(`${name}: expected an error, got success`)
  } catch (err) {
    if (pattern && !pattern.test(err.message)) failures.push(`${name}: wrong error "${err.message}"`)
    else passed++
  }
}

async function superuser(sql, params) {
  await db.query('reset role')
  return (await db.query(sql, params)).rows
}

async function newUser(email) {
  const id = randomUUID()
  await superuser('insert into auth.users (id, email) values ($1, $2)', [id, email])
  return id
}

async function newDevice() {
  const id = randomUUID()
  await superuser('insert into auth.users (id) values ($1)', [id])
  anonymous.add(id)
  return id
}

// Open occurrences of a task, oldest first, as the given user sees them.
const openOf = (uid, task) =>
  as(uid, ({ rows }) =>
    rows(
      `select id, due_on::text, responsible_id from todo.occurrences
       where task_id = $1 and status = 'open' order by due_on`,
      [task],
    ),
  )

const createTask = (uid, spec) =>
  as(uid, ({ one }) => one('select todo.create_task($1) as id', [JSON.stringify(spec)])).then((r) => r.id)

const complete = (uid, occ) =>
  as(uid, ({ one }) => one('select todo.complete_occurrence($1) as id', [occ])).then((r) => r.id)

// --- pure date math ---------------------------------------------------------

{
  const r = await superuser(`select
    todo.add_interval('2026-01-31', 'month', 1)::text as jan31,
    todo.add_interval('2028-01-31', 'month', 1)::text as leap,
    todo.add_interval('2028-02-29', 'year', 1)::text as leap_year,
    todo.add_interval('2026-03-10', 'month', 6)::text as six,
    todo.calendar_match(null, '{31}', null, '2026-04-30') as apr30,
    todo.calendar_match(null, '{31}', null, '2026-04-29') as apr29,
    todo.calendar_match('{2}', null, null, '2026-09-22') as tuesday,
    todo.calendar_match('{2}', null, null, '2026-09-23') as wednesday,
    todo.calendar_match(null, '{1}', '{1,7}', '2026-07-01') as jul1,
    todo.calendar_match(null, '{1}', '{1,7}', '2026-08-01') as aug1`)
  const x = r[0]
  check('month end clamps', x.jan31 === '2026-02-28', x.jan31)
  check('leap month end', x.leap === '2028-02-29', x.leap)
  check('leap day plus a year', x.leap_year === '2029-02-28', x.leap_year)
  check('six months', x.six === '2026-09-10', x.six)
  check('day 31 matches last day of April', x.apr30 === true)
  check('day 31 does not match Apr 29', x.apr29 === false)
  check('weekday match', x.tuesday === true && x.wednesday === false)
  check('month + day match', x.jul1 === true && x.aug1 === false)
}

// --- families and invites ---------------------------------------------------

const dad = await newUser('dad@example.com')
const mom = await newUser('mom@example.com')
const kid1 = await newUser('kid1@example.com')
const kid2 = await newUser('kid2@example.com')
const stranger = await newUser('stranger@example.com')
const nobody = await newUser('nobody@example.com')

const family = (await as(dad, ({ one }) =>
  one("select todo.create_family('Ray', 'Dad', 'America/Chicago') as id"))).id
check('family created', !!family)

await fails('second family for same person', dad,
  ({ q }) => q("select todo.create_family('Again', 'Dad', 'America/Chicago')"), /already in a family/)
await fails('bogus time zone', nobody,
  ({ q }) => q("select todo.create_family('X', 'X', 'Mars/Olympus')"), /unknown time zone/)
await fails('signed out cannot create a family', null,
  ({ q }) => q("select todo.create_family('X', 'X', 'America/Chicago')"), /not signed in/)

const inviteFor = (uid, role = 'member') =>
  as(uid, ({ one }) => one('select todo.create_invite($1) as t', [role])).then((r) => r.t)

const momToken = await inviteFor(dad, 'admin')
check('invite token is 64 hex chars', /^[0-9a-f]{64}$/.test(momToken))
await as(mom, ({ q }) => q("select todo.accept_invite($1, 'Mom')", [momToken]))
await fails('invite is single use', kid1,
  ({ q }) => q("select todo.accept_invite($1, 'Kid')", [momToken]), /invalid or expired/)
await fails('garbage token', kid1,
  ({ q }) => q("select todo.accept_invite('zz', 'Kid')"), /invalid or expired/)

for (const [uid, name] of [[kid1, 'Kid One'], [kid2, 'Kid Two']]) {
  const t = await inviteFor(mom)
  await as(uid, ({ q }) => q('select todo.accept_invite($1, $2)', [t, name]))
}
await fails('members cannot invite', kid1, ({ q }) => q('select todo.create_invite()'), /only admins/)

{
  const expired = await inviteFor(dad)
  await superuser("update todo.invites set expires_at = now() - interval '1 minute' where used_at is null")
  await fails('expired invite', nobody,
    ({ q }) => q("select todo.accept_invite($1, 'Late')", [expired]), /invalid or expired/)
}

const strangerFamily = (await as(stranger, ({ one }) =>
  one("select todo.create_family('Other', 'Stranger', 'America/New_York') as id"))).id

// Profile ids are separate from auth user ids. P maps a login to its profile,
// U maps back. Tests pass profile ids wherever the app would.
const P = {}
for (const u of [dad, mom, kid1, kid2, stranger]) {
  P[u] = (await superuser('select id from todo.profiles where user_id = $1', [u]))[0].id
}
const U = Object.fromEntries(Object.entries(P).map(([u, p]) => [p, u]))
check('profile ids are not login ids', Object.entries(P).every(([u, p]) => u !== p))

{
  const members = await as(kid1, ({ rows }) => rows('select display_name, role from todo.profiles order by display_name'))
  check('family sees its four members', members.length === 4, JSON.stringify(members))
  check('mom is admin', members.find((m) => m.display_name === 'Mom')?.role === 'admin')
  const fams = await as(kid1, ({ rows }) => rows('select id from todo.families'))
  check('only own family visible', fams.length === 1 && fams[0].id === family)
  const strangerSees = await as(stranger, ({ rows }) => rows('select id from todo.profiles'))
  check('stranger sees only themself', strangerSees.length === 1)
  const unsignedFam = await as(nobody, ({ rows }) => rows('select id from todo.families'))
  check('person with no family sees no families', unsignedFam.length === 0)
}

await fails('token hashes are not readable', dad,
  ({ q }) => q('select token_hash from todo.invites'), /permission denied/)
{
  const inv = await as(dad, ({ rows }) => rows('select id, role from todo.invites'))
  check('admin lists invites', inv.length >= 3)
  const invKid = await as(kid1, ({ rows }) => rows('select id from todo.invites'))
  check('members do not see invites', invKid.length === 0)
}

// --- direct writes are closed -------------------------------------------------

await fails('no direct task insert', dad, ({ q }) =>
  q(`insert into todo.tasks (family_id, scope, title, schedule_kind, interval_unit, interval_count)
     values ($1, 'family', 'x', 'countdown', 'day', 1)`, [family]), /permission denied/)
await fails('no direct occurrence update', dad,
  ({ q }) => q("update todo.occurrences set status = 'done'"), /permission denied/)
await fails('cannot promote yourself', kid1,
  ({ q }) => q("update todo.profiles set role = 'admin' where id = $1", [P[kid1]]), /permission denied/)
await fails('internal functions are not callable', kid1,
  ({ q }) => q('select todo.rollover_all()'), /permission denied/)
await fails('cannot call rollover for another family', kid1,
  ({ q }) => q('select todo.rollover_family($1)', [strangerFamily]), /permission denied/)
{
  await as(kid1, ({ q }) => q("update todo.profiles set display_name = 'Kiddo' where id = $1", [P[kid1]]))
  const r = await as(kid1, ({ one }) => one('select display_name from todo.profiles where id = $1', [P[kid1]]))
  check('can rename yourself', r.display_name === 'Kiddo')
  await as(kid1, ({ q }) => q("update todo.profiles set display_name = 'Hacked' where id = $1", [P[dad]]))
  const d = await as(dad, ({ one }) => one('select display_name from todo.profiles where id = $1', [P[dad]]))
  check('cannot rename someone else', d.display_name === 'Dad')
}

// --- task creation and visibility --------------------------------------------

const oil = await createTask(dad, {
  scope: 'family', title: 'Oil change', schedule_kind: 'countdown',
  interval_unit: 'month', interval_count: 6, assignees: [P[dad]], last_done_on: '2026-03-10',
})
check('last done Mar 10 + 6 months = Sep 10',
  (await openOf(dad, oil))[0]?.due_on === '2026-09-10')

await fails('members cannot create family tasks', kid1, ({ q }) =>
  q('select todo.create_task($1)', [JSON.stringify({
    scope: 'family', title: 'x', schedule_kind: 'countdown', interval_unit: 'day',
    interval_count: 1, assignees: [P[kid1]], unsure: true })]), /only admins/)
await fails('assignee from another family', dad, ({ q }) =>
  q('select todo.create_task($1)', [JSON.stringify({
    scope: 'family', title: 'x', schedule_kind: 'countdown', interval_unit: 'day',
    interval_count: 1, assignees: [P[stranger]], unsure: true })]), /not in this family/)
await fails('pool needs two people', dad, ({ q }) =>
  q('select todo.create_task($1)', [JSON.stringify({
    scope: 'family', title: 'x', schedule_kind: 'countdown', interval_unit: 'day',
    interval_count: 1, assign_mode: 'pool', assignees: [P[kid1]], unsure: true })]), /two or more/)
await fails('must say how to start', dad, ({ q }) =>
  q('select todo.create_task($1)', [JSON.stringify({
    scope: 'family', title: 'x', schedule_kind: 'countdown', interval_unit: 'day',
    interval_count: 1, assignees: [P[kid1]] })]), /exactly one of/)

const diary = await createTask(kid1, {
  scope: 'personal', title: 'Diary', schedule_kind: 'countdown',
  interval_unit: 'day', interval_count: 1, unsure: true,
})
check('unsure lands a week out', (await openOf(kid1, diary))[0]?.due_on === '2026-09-29')
{
  const seenByDad = await as(dad, ({ rows }) => rows('select id from todo.tasks where id = $1', [diary]))
  check('admin cannot see a personal task', seenByDad.length === 0)
  const occByDad = await as(dad, ({ rows }) =>
    rows('select o.id from todo.occurrences o where o.task_id = $1', [diary]))
  check('admin cannot see personal occurrences', occByDad.length === 0)
  const seenByStranger = await as(stranger, ({ rows }) => rows('select id from todo.tasks'))
  check('stranger sees no tasks', seenByStranger.length === 0)
  const [diaryOcc] = await openOf(kid1, diary)
  await fails('admin cannot complete a personal task', dad,
    ({ q }) => q('select todo.complete_occurrence($1)', [diaryOcc.id]), /not found/)
}

// --- countdown and calendar completion ---------------------------------------

today = '2026-10-01'
{
  const [o] = await openOf(dad, oil)
  await complete(dad, o.id)
  const next = await openOf(dad, oil)
  check('late countdown counts from completion', next[0]?.due_on === '2027-04-01', next[0]?.due_on)
}

const filter = await createTask(dad, {
  scope: 'family', title: 'Furnace filter', schedule_kind: 'calendar',
  cal_months: [1, 7], cal_month_days: [1], assignees: [P[mom]], first_due_on: '2026-01-01',
})
{
  today = '2026-08-05'
  const [o] = await openOf(mom, filter)
  check('calendar first due', o.due_on === '2026-01-01')
  await complete(mom, o.id)
  const next = await openOf(mom, filter)
  check('January filter done in August skips July', next[0]?.due_on === '2027-01-01', next[0]?.due_on)
}

const homework = await createTask(dad, {
  scope: 'family', title: 'Homework', schedule_kind: 'calendar',
  cal_weekdays: [1, 2, 3, 4, 5], assignees: [P[kid1]], first_due_on: '2026-09-18',
})
{
  today = '2026-09-19' // Saturday; Friday's homework is overdue
  const [fri] = await openOf(kid1, homework)
  check('homework due Friday', fri.due_on === '2026-09-18')
  await complete(kid1, fri.id)
  const next = await openOf(kid1, homework)
  check('weekday calendar skips the weekend', next[0]?.due_on === '2026-09-21', next[0]?.due_on)
  today = '2026-09-21'
  await complete(kid1, next[0].id)
  const tue = await openOf(kid1, homework)
  check('next weekday', tue[0]?.due_on === '2026-09-22')
}

const bins = await createTask(dad, {
  scope: 'family', title: 'Wipe counters', schedule_kind: 'calendar',
  cal_weekdays: [0, 1, 2, 3, 4, 5, 6], assignees: [P[mom]], first_due_on: '2026-09-18',
})
{
  today = '2026-09-19'
  const [fri] = await openOf(mom, bins)
  await complete(mom, fri.id)
  const next = await openOf(mom, bins)
  check('daily calendar done a day late still leaves today due', next[0]?.due_on === '2026-09-19', next[0]?.due_on)
}

const vitamins = await createTask(mom, {
  scope: 'personal', title: 'Vitamins', schedule_kind: 'countdown',
  interval_unit: 'day', interval_count: 1, first_due_on: '2026-09-23',
})
{
  today = '2026-09-22'
  const [o] = await openOf(mom, vitamins)
  await complete(mom, o.id)
  const next = await openOf(mom, vitamins)
  check('early daily completion moves past the one it closed', next[0]?.due_on === '2026-09-24', next[0]?.due_on)
}

// --- active window ------------------------------------------------------------

const mow = await createTask(dad, {
  scope: 'family', title: 'Mow', schedule_kind: 'countdown', interval_unit: 'week',
  interval_count: 1, active_months: [4, 5, 6, 7, 8, 9, 10], assignees: [P[dad]], first_due_on: '2026-10-28',
})
{
  today = '2026-10-28'
  const [o] = await openOf(dad, mow)
  await complete(dad, o.id)
  const next = await openOf(dad, mow)
  check('mowing sleeps until April', next[0]?.due_on === '2027-04-01', next[0]?.due_on)
  const outOfSeason = await createTask(dad, {
    scope: 'family', title: 'Rake', schedule_kind: 'countdown', interval_unit: 'week',
    interval_count: 1, active_months: [10, 11], assignees: [P[dad]], first_due_on: '2026-05-01',
  })
  check('first due date is pulled into the window', (await openOf(dad, outOfSeason))[0]?.due_on === '2026-10-01')
}

// --- permissions on completion -----------------------------------------------

const pool = await createTask(dad, {
  scope: 'family', title: 'Empty dishwasher', schedule_kind: 'countdown', interval_unit: 'day',
  interval_count: 1, assign_mode: 'pool', assignees: [P[kid1], P[kid2]], first_due_on: '2026-09-22',
})
{
  today = '2026-09-22'
  const [o] = await openOf(kid1, pool)
  check('pool occurrence has no single owner', o.responsible_id === null)
  const cousinToken = await inviteFor(dad)
  const cousin = await newUser('cousin@example.com')
  await as(cousin, ({ q }) => q("select todo.accept_invite($1, 'Cousin')", [cousinToken]))
  await fails('someone outside the pool cannot complete it', cousin,
    ({ q }) => q('select todo.complete_occurrence($1)', [o.id]), /not allowed/)
  await complete(kid2, o.id)
  const done = await as(dad, ({ one }) => one('select completed_by from todo.occurrences where id = $1', [o.id]))
  check('pool records who did it', done.completed_by === P[kid2])
}

{
  const [o] = await openOf(kid1, homework)
  await fails('another member cannot complete your task', kid2,
    ({ q }) => q('select todo.complete_occurrence($1)', [o.id]), /not allowed/)
  await fails('a stranger cannot even find it', stranger,
    ({ q }) => q('select todo.complete_occurrence($1)', [o.id]), /not found/)
  await complete(mom, o.id)
  check('admin can complete anyone\'s task', true)
  await fails('closed occurrences stay closed', mom,
    ({ q }) => q('select todo.complete_occurrence($1)', [o.id]), /already closed/)
}

// --- undo ----------------------------------------------------------------------

{
  const [o] = await openOf(dad, oil)
  today = '2027-04-01'
  await complete(dad, o.id)
  const afterDone = await openOf(dad, oil)
  await as(dad, ({ q }) => q('select todo.undo_completion($1)', [o.id]))
  const afterUndo = await openOf(dad, oil)
  check('undo reopens and removes the next one',
    afterUndo.length === 1 && afterUndo[0].id === o.id && afterDone[0].id !== o.id)

  await complete(dad, o.id)
  const older = await as(dad, ({ one }) =>
    one("select id from todo.occurrences where task_id = $1 and status = 'done' order by completed_at limit 1", [oil]))
  await fails('only the latest completion can be undone', dad,
    ({ q }) => q('select todo.undo_completion($1)', [older.id]), /only the latest/)
}

// --- subtasks ------------------------------------------------------------------

const pool2 = await createTask(dad, {
  scope: 'family', title: 'Pool care', schedule_kind: 'countdown', interval_unit: 'week',
  interval_count: 1, assignees: [P[kid2]], first_due_on: '2026-09-22', subtasks: ['Skim', 'Brush', 'Test'],
})
{
  today = '2026-09-22'
  const [o] = await openOf(kid2, pool2)
  const subs = await as(kid2, ({ rows }) => rows('select id from todo.subtasks where task_id = $1 order by position', [pool2]))
  check('three subtasks', subs.length === 3)
  const set = (sid, on) => as(kid2, ({ one }) => one('select todo.set_subtask($1, $2, $3) as done', [o.id, sid, on]))
  check('first check does not complete', (await set(subs[0].id, true)).done === false)
  await set(subs[1].id, true)
  await set(subs[1].id, false)
  check('unchecked subtask is gone',
    (await as(kid2, ({ rows }) => rows('select 1 from todo.subtask_checks where occurrence_id = $1', [o.id]))).length === 1)
  await set(subs[1].id, true)
  check('last check completes the task', (await set(subs[2].id, true)).done === true)
  const next = await openOf(kid2, pool2)
  const checksOnNext = await as(kid2, ({ rows }) =>
    rows('select 1 from todo.subtask_checks where occurrence_id = $1', [next[0].id]))
  check('checks reset on the next occurrence', checksOnNext.length === 0 && next[0].due_on === '2026-09-29')

  await as(kid2, ({ q }) => q('select todo.set_subtask($1, $2, true)', [next[0].id, subs[0].id]))
  await fails('undo blocked once the next one is started', kid2,
    ({ q }) => q('select todo.undo_completion($1)', [o.id]), /already been started/)
}

// --- rotations -----------------------------------------------------------------

const trash = await createTask(dad, {
  scope: 'family', title: 'Trash', schedule_kind: 'calendar', cal_weekdays: [2],
  assign_mode: 'rotate_completion', assignees: [P[kid1], P[kid2]], first_due_on: '2026-09-22',
})
{
  today = '2026-09-22'
  const seq = []
  for (let i = 0; i < 3; i++) {
    const [o] = await openOf(dad, trash)
    seq.push(o.responsible_id)
    await complete(dad, o.id)
  }
  check('rotation per completion alternates', seq[0] === P[kid1] && seq[1] === P[kid2] && seq[2] === P[kid1],
    JSON.stringify(seq))
  const doneLast = await as(dad, ({ one }) =>
    one("select id from todo.occurrences where task_id = $1 and status = 'done' order by completed_at desc limit 1", [trash]))
  await as(dad, ({ q }) => q('select todo.undo_completion($1)', [doneLast.id]))
  const [reopened] = await openOf(dad, trash)
  check('undo puts the rotation back', reopened.responsible_id === P[kid1])
}

const dishes = await createTask(dad, {
  scope: 'family', title: 'Unload dishwasher', schedule_kind: 'countdown', interval_unit: 'day',
  interval_count: 1, assign_mode: 'rotate_period', rotate_unit: 'week', rotate_count: 1,
  rotate_anchor: '2026-09-14', assignees: [P[kid1], P[kid2]], first_due_on: '2026-09-18',
})
{
  today = '2026-09-18' // Friday, week of Sep 14 belongs to kid1
  const [fri] = await openOf(kid1, dishes)
  check('week one belongs to kid one', fri.responsible_id === P[kid1])

  today = '2026-09-21' // Monday, week of Sep 21 belongs to kid2; Friday still open
  await as(kid1, ({ q }) => q('select todo.rollover()'))
  const open = await openOf(kid1, dishes)
  check('overdue stays with the kid who missed it',
    open.length === 2 && open[0].responsible_id === P[kid1] && open[0].due_on === '2026-09-18')
  check('new holder gets a fresh one today', open[1]?.responsible_id === P[kid2] && open[1]?.due_on === '2026-09-21')
  await as(kid1, ({ q }) => q('select todo.rollover()'))
  check('rollover is idempotent', (await openOf(kid1, dishes)).length === 2)

  await complete(kid1, open[0].id)
  check('finishing the old one does not spawn a duplicate', (await openOf(kid1, dishes)).length === 1)
  await complete(kid2, open[1].id)
  const [tue] = await openOf(kid2, dishes)
  check('rotation continues on the right person', tue.responsible_id === P[kid2] && tue.due_on === '2026-09-22')
}

// --- skip policy ---------------------------------------------------------------

const read = await createTask(kid1, {
  scope: 'personal', title: 'Read 20 minutes', schedule_kind: 'countdown', interval_unit: 'day',
  interval_count: 1, miss_policy: 'skip', first_due_on: '2026-09-22',
})
{
  today = '2026-09-25'
  const changed = await as(kid1, ({ one }) => one('select todo.rollover() as n'))
  const open = await openOf(kid1, read)
  check('missed daily skips forward to today', open.length === 1 && open[0].due_on === '2026-09-25', JSON.stringify(open))
  const skipped = await as(kid1, ({ rows }) =>
    rows("select due_on::text from todo.occurrences where task_id = $1 and status = 'skipped'", [read]))
  check('the miss is recorded once', skipped.length === 1 && skipped[0].due_on === '2026-09-22')
  check('rollover reported changes', changed.n >= 1)
  const again = await as(kid1, ({ one }) => one('select todo.rollover() as n'))
  check('second rollover changes nothing', again.n === 0)
}

// --- hand back ----------------------------------------------------------------

{
  const chore = await createTask(mom, {
    scope: 'family', title: 'Clean room', schedule_kind: 'calendar', cal_weekdays: [6],
    assignees: [P[kid1]], first_due_on: '2026-09-26',
  })
  const [o] = await openOf(kid1, chore)
  await fails('someone else cannot hand it off', kid2,
    ({ q }) => q('select todo.hand_back($1, $2)', [o.id, P[kid2]]), /not allowed/)
  await fails('cannot hand to an outsider', kid1,
    ({ q }) => q('select todo.hand_back($1, $2)', [o.id, P[stranger]]), /not in this family/)
  await as(kid1, ({ q }) => q('select todo.hand_back($1, $2)', [o.id, P[dad]]))
  const [after] = await openOf(dad, chore)
  const assignee = await as(dad, ({ one }) => one('select profile_id from todo.task_assignees where task_id = $1', [chore]))
  check('single mode hand back moves the task', after.responsible_id === P[dad] && assignee.profile_id === P[dad])
  const feed = await as(mom, ({ rows }) =>
    rows("select payload from todo.activity where kind = 'handed_back' and task_id = $1", [chore]))
  check('hand back shows in the activity feed', feed.length === 1 && feed[0].payload.to === P[dad])
  const strangerFeed = await as(stranger, ({ rows }) => rows('select 1 from todo.activity'))
  check('activity stays inside the family', strangerFeed.length === 0)

  const [t] = await openOf(dad, trash)
  const holder = t.responsible_id
  await as(U[holder], ({ q }) => q('select todo.hand_back($1, $2)', [t.id, P[mom]]))
  const order = await as(dad, ({ rows }) =>
    rows('select profile_id from todo.task_assignees where task_id = $1 order by position', [trash]))
  const [moved] = await openOf(dad, trash)
  check('rotation hand back moves only this one',
    moved.responsible_id === P[mom] && order.map((r) => r.profile_id).join() === [P[kid1], P[kid2]].join())

  const [p] = await openOf(kid1, pool)
  await fails('pool tasks cannot be handed off', kid1,
    ({ q }) => q('select todo.hand_back($1, $2)', [p.id, P[dad]]), /cannot be handed/)
}

// --- members and admins ----------------------------------------------------------

await fails('removing someone with tasks is blocked', dad,
  ({ q }) => q('select todo.remove_member($1)', [P[kid2]]), /reassign or delete/)
await fails('members cannot remove people', kid1,
  ({ q }) => q('select todo.remove_member($1)', [P[kid2]]), /only admins/)
await fails('last admin cannot step down', stranger,
  ({ q }) => q("select todo.set_role($1, 'member')", [P[stranger]]), /at least one admin/)
await as(dad, ({ q }) => q("select todo.set_role($1, 'member')", [P[dad]]))
check('an admin can step down while another remains', true)
await as(mom, ({ q }) => q("select todo.set_role($1, 'admin')", [P[dad]]))

{
  await fails('members cannot delete family tasks', kid1,
    ({ q }) => q('select todo.delete_task($1)', [mow]), /only admins/)
  await as(dad, ({ q }) => q('select todo.delete_task($1)', [mow]))
  const gone = await as(dad, ({ rows }) => rows('select id from todo.tasks where id = $1', [mow]))
  check('deleted tasks disappear', gone.length === 0)
  await as(kid1, ({ q }) => q('select todo.delete_task($1)', [diary]))
  check('you can delete your own personal task', true)
}

// --- kid accounts ------------------------------------------------------------------

{
  today = '2026-09-22'
  const sally = (await as(dad, ({ one }) => one("select todo.add_kid('Sally') as id"))).id
  await fails('members cannot add kids', kid1, ({ q }) => q("select todo.add_kid('Nope')"), /only admins/)
  const row = (await superuser('select role, is_kid, user_id from todo.profiles where id = $1', [sally]))[0]
  check('kid is a member with no login yet', row.role === 'member' && row.is_kid && row.user_id === null)

  await fails('kids cannot be made admins', dad,
    ({ q }) => q("select todo.set_role($1, 'admin')", [sally]), /cannot be admins/)
  await fails('members cannot make setup codes', kid1,
    ({ q }) => q('select todo.kid_setup_code($1)', [sally]), /only admins/)
  await fails('setup codes are only for kid profiles', dad,
    ({ q }) => q('select todo.kid_setup_code($1)', [P[kid1]]), /kid not found/)
  await fails('another family cannot make codes for your kid', stranger,
    ({ q }) => q('select todo.kid_setup_code($1)', [sally]), /kid not found/)

  const codeFor = () => as(dad, ({ one }) => one('select todo.kid_setup_code($1) as c', [sally])).then((r) => r.c)
  const code = await codeFor()
  check('setup code is 8 unambiguous characters', /^[A-HJ-NP-Z2-9]{8}$/.test(code), code)

  const phone = await newDevice()
  await fails('an email account cannot claim a kid', nobody,
    ({ q }) => q('select todo.claim_kid_setup($1)', [code]), /for kid devices/)
  await fails('a wrong code is refused', phone,
    ({ q }) => q("select todo.claim_kid_setup('ZZZZ-ZZZZ')"), /wrong or has expired/)
  await fails('a device session cannot create a family', phone,
    ({ q }) => q("select todo.create_family('X', 'X', 'America/Chicago')"), /sign in with your email/)
  const kidInvite = await inviteFor(dad)
  await fails('a device session cannot take an adult invite', phone,
    ({ q }) => q("select todo.accept_invite($1, 'X')", [kidInvite]), /sign in with your email/)

  const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`
  const fam = await as(phone, ({ one }) => one('select todo.claim_kid_setup($1) as f', [typed])).then((r) => r.f)
  check('claim is case and dash insensitive and joins the family', fam === family)
  await fails('a code works once', await newDevice(),
    ({ q }) => q('select todo.claim_kid_setup($1)', [code]), /wrong or has expired/)
  await fails('a set up device cannot claim again', phone,
    ({ q }) => q('select todo.claim_kid_setup($1)', [code]), /already set up/)

  const me = await as(phone, ({ one }) => one('select id, display_name, is_kid from todo.profiles where user_id = auth.uid()'))
  check('the device is Sally', me.id === sally && me.display_name === 'Sally' && me.is_kid)

  // Dad assigns, Sally sees it and checks it off, Dad sees who did it.
  const unload = await createTask(dad, {
    scope: 'family', title: 'Unload dishwasher', schedule_kind: 'countdown', interval_unit: 'day',
    interval_count: 1, assignees: [sally], first_due_on: '2026-09-22',
  })
  const [mine] = await openOf(phone, unload)
  check('Sally sees her chore', mine?.responsible_id === sally)
  await complete(phone, mine.id)
  const seen = await as(dad, ({ one }) =>
    one("select p.display_name from todo.occurrences o join todo.profiles p on p.id = o.completed_by where o.id = $1", [mine.id]))
  check('Dad sees Sally did it', seen?.display_name === 'Sally')
  await fails('Sally cannot delete family tasks', phone,
    ({ q }) => q('select todo.delete_task($1)', [unload]), /only admins/)
  await fails('Sally cannot invite people', phone, ({ q }) => q('select todo.create_invite()'), /only admins/)

  // New phone: a new code moves Sally, and the old phone loses her.
  await superuser("update todo.kid_setup_codes set expires_at = now() - interval '1 second' where used_at is null")
  const stale = await codeFor()
  await superuser("update todo.kid_setup_codes set expires_at = now() - interval '1 second' where used_at is null")
  await fails('expired codes are refused', await newDevice(),
    ({ q }) => q('select todo.claim_kid_setup($1)', [stale]), /wrong or has expired/)
  const first = await codeFor()
  const second = await codeFor()
  await fails('a newer code cancels the older one', await newDevice(),
    ({ q }) => q('select todo.claim_kid_setup($1)', [first]), /wrong or has expired/)
  const newPhone = await newDevice()
  await as(newPhone, ({ q }) => q('select todo.claim_kid_setup($1)', [second]))
  const oldView = await as(phone, ({ rows }) => rows('select id from todo.tasks'))
  const newView = await openOf(newPhone, unload)
  check('the old phone sees nothing', oldView.length === 0)
  check('the new phone has Sally\'s chores', newView.length === 1 && newView[0].responsible_id === sally)

  // Buy links: kids never, adults unless an admin hides them.
  await fails('members cannot hide buy links', kid1,
    ({ q }) => q('select todo.set_buy_links_hidden($1, true)', [P[kid2]]), /only admins/)
  await as(dad, ({ q }) => q('select todo.set_buy_links_hidden($1, true)', [P[kid2]]))
  const flags = await as(kid2, ({ one }) => one('select hide_buy_links from todo.profiles where id = $1', [P[kid2]]))
  check('admin can hide buy links for a person', flags.hide_buy_links === true)
  await fails('nobody can flip their own flag directly', kid2,
    ({ q }) => q('update todo.profiles set hide_buy_links = false where id = $1', [P[kid2]]), /permission denied/)
  await fails('setup codes are not readable', dad,
    ({ q }) => q('select * from todo.kid_setup_codes'), /permission denied/)
}

// --- presets --------------------------------------------------------------------

{
  today = '2026-09-22'
  const car = await superuser(`select pt.id, pt.slug, pt.schedule_kind from todo.preset_tasks pt
    join todo.presets p on p.id = pt.preset_id where p.slug = 'car' order by pt.position`)
  check('car preset is seeded', car.length > 20, String(car.length))
  const oil = car.find((t) => t.slug === 'car/oil-and-filter-change')
  const wipers = car.find((t) => t.slug === 'car/replace-wiper-blades')
  const items = car.map((t) => (t.id === oil.id ? { preset_task_id: t.id, last_done_on: '2026-03-10' } : { preset_task_id: t.id }))
  const add = (uid, assignee) => as(uid, ({ one }) =>
    one('select todo.add_presets($1) as n', [JSON.stringify({ assignee, items })])).then((r) => r.n)

  await fails('members cannot add presets', kid1, ({ q }) =>
    q('select todo.add_presets($1)', [JSON.stringify({ assignee: P[kid1], items })]), /only admins/)
  await fails('preset assignee must be in the family', dad, ({ q }) =>
    q('select todo.add_presets($1)', [JSON.stringify({ assignee: P[stranger], items })]), /not in this family/)

  const n = await add(dad, P[mom])
  check('every car task was added', n === car.length, `${n} of ${car.length}`)
  const rows = await as(mom, ({ rows }) => rows(`select t.preset_task_id, t.schedule_kind, o.due_on::text, o.responsible_id
    from todo.tasks t join todo.occurrences o on o.task_id = t.id and o.status = 'open'
    where t.preset_task_id is not null`))
  check('preset tasks go to the chosen person', rows.every((r) => r.responsible_id === P[mom]))
  check('last done date is used', rows.find((r) => r.preset_task_id === oil.id)?.due_on === '2026-09-10')
  check('calendar presets start on their next date', rows.find((r) => r.preset_task_id === wipers.id)?.due_on === '2026-10-01')
  const unsure = rows.filter((r) => r.schedule_kind === 'countdown' && r.preset_task_id !== oil.id)
  const perDay = {}
  for (const r of unsure) perDay[r.due_on] = (perDay[r.due_on] || 0) + 1
  check('not-sure tasks are spread out', Math.max(...Object.values(perDay)) <= 3, JSON.stringify(perDay))
  check('spreading starts tomorrow', Object.keys(perDay).sort()[0] >= '2026-09-23', Object.keys(perDay).sort()[0])
  check('adding the same preset again adds nothing', (await add(dad, P[mom])) === 0)
}

// --- assigning in bulk -----------------------------------------------------------

{
  today = '2026-09-22'
  const flags = await as(dad, ({ rows }) => rows('select id, needs_welcome from todo.profiles'))
  const flag = (pid) => flags.find((r) => r.id === pid)?.needs_welcome
  check('adults who joined by invite need a welcome', flag(P[mom]) === true && flag(P[kid1]) === true)
  check('the family creator does not', flag(P[dad]) === false)
  await fails('members cannot dismiss a welcome', kid1,
    ({ q }) => q('select todo.dismiss_welcome($1)', [P[mom]]), /only admins/)
  await as(dad, ({ q }) => q('select todo.dismiss_welcome($1)', [P[mom]]))
  const momFlag = await as(dad, ({ one }) => one('select needs_welcome from todo.profiles where id = $1', [P[mom]]))
  check('dismissing clears the welcome', momFlag.needs_welcome === false)

  const mine = []
  for (const title of ['Sweep porch', 'Water ferns']) {
    mine.push(await createTask(dad, { scope: 'family', title, schedule_kind: 'countdown', interval_unit: 'week',
      interval_count: 1, assignees: [P[dad]], first_due_on: '2026-09-25' }))
  }
  await fails('members cannot reassign', kid2, ({ q }) =>
    q('select todo.reassign_tasks($1, $2)', [mine, P[kid2]]), /only admins/)
  await fails('cannot reassign to an outsider', dad, ({ q }) =>
    q('select todo.reassign_tasks($1, $2)', [mine, P[stranger]]), /not in this family/)
  const moved = await as(dad, ({ one }) => one('select todo.reassign_tasks($1, $2) as n', [[...mine, pool], P[kid2]])).then((r) => r.n)
  check('only single-owner tasks move', moved === 2, String(moved))
  const after = await openOf(kid2, mine[0])
  const owner = await as(dad, ({ one }) => one('select profile_id from todo.task_assignees where task_id = $1', [mine[1]]))
  check('open occurrence and owner both move', after[0]?.responsible_id === P[kid2] && owner.profile_id === P[kid2])
  const poolPeople = await as(dad, ({ rows }) => rows('select profile_id from todo.task_assignees where task_id = $1 order by position', [pool]))
  check('pooled task is left alone', poolPeople.map((r) => r.profile_id).join() === [P[kid1], P[kid2]].join())
  const kid2Flag = await as(dad, ({ one }) => one('select needs_welcome from todo.profiles where id = $1', [P[kid2]]))
  check('giving someone tasks clears their welcome', kid2Flag.needs_welcome === false)
  check('reassigning again moves nothing', (await as(dad, ({ one }) =>
    one('select todo.reassign_tasks($1, $2) as n', [mine, P[kid2]]))).n === 0)

  const dog = await superuser(`select pt.id from todo.preset_tasks pt join todo.presets p on p.id = pt.preset_id
    where p.slug = 'dog' order by pt.position limit 3`)
  const items = [{ preset_task_id: dog[0].id, assignee: P[kid1] }, { preset_task_id: dog[1].id }, { preset_task_id: dog[2].id }]
  await fails('per-task assignee must be in the family', dad, ({ q }) =>
    q('select todo.add_presets($1)', [JSON.stringify({ assignee: P[dad], items: [{ preset_task_id: dog[0].id, assignee: P[stranger] }] })]),
    /not in this family/)
  await as(dad, ({ q }) => q('select todo.add_presets($1)', [JSON.stringify({ assignee: P[dad], items })]))
  const owners = await as(dad, ({ rows }) => rows(`select t.preset_task_id, a.profile_id from todo.tasks t
    join todo.task_assignees a on a.task_id = t.id where t.preset_task_id = any($1)`, [dog.map((d) => d.id)]))
  const ownerOf = (id) => owners.find((o) => o.preset_task_id === id)?.profile_id
  check('per-task assignee wins', ownerOf(dog[0].id) === P[kid1])
  check('others fall back to the batch assignee', ownerOf(dog[1].id) === P[dad] && ownerOf(dog[2].id) === P[dad])
}

// --- invariant: every live task has an open occurrence ------------------------

{
  const orphans = await superuser(`
    select t.title from todo.tasks t
    where t.deleted_at is null
      and not exists (select 1 from todo.occurrences o where o.task_id = t.id and o.status = 'open')`)
  check('every live task has something open', orphans.length === 0, orphans.map((o) => o.title).join(', '))
}

// --- report ------------------------------------------------------------------------

await db.end()
reported = true
if (failures.length) {
  console.error(`test-db: ${failures.length} failed, ${passed} passed`)
  for (const f of failures) console.error(`  x ${f}`)
  process.exit(1)
}
console.log(`test-db: ${passed} assertions passed`)
