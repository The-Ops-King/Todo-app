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
let today = '2026-09-22'

function check(name, cond, detail = '') {
  if (cond) passed++
  else failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

// Run fn inside one transaction as `uid`, the way a browser request runs.
async function as(uid, fn) {
  await db.query('begin')
  try {
    await db.query('set local role authenticated')
    await db.query("select set_config('request.jwt.claims', $1, true)", [
      uid ? JSON.stringify({ sub: uid, role: 'authenticated' }) : '',
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
  ({ q }) => q("update todo.profiles set role = 'admin' where id = $1", [kid1]), /permission denied/)
await fails('internal functions are not callable', kid1,
  ({ q }) => q('select todo.rollover_all()'), /permission denied/)
await fails('cannot call rollover for another family', kid1,
  ({ q }) => q('select todo.rollover_family($1)', [strangerFamily]), /permission denied/)
{
  await as(kid1, ({ q }) => q("update todo.profiles set display_name = 'Kiddo' where id = $1", [kid1]))
  const r = await as(kid1, ({ one }) => one('select display_name from todo.profiles where id = $1', [kid1]))
  check('can rename yourself', r.display_name === 'Kiddo')
  await as(kid1, ({ q }) => q("update todo.profiles set display_name = 'Hacked' where id = $1", [dad]))
  const d = await as(dad, ({ one }) => one('select display_name from todo.profiles where id = $1', [dad]))
  check('cannot rename someone else', d.display_name === 'Dad')
}

// --- task creation and visibility --------------------------------------------

const oil = await createTask(dad, {
  scope: 'family', title: 'Oil change', schedule_kind: 'countdown',
  interval_unit: 'month', interval_count: 6, assignees: [dad], last_done_on: '2026-03-10',
})
check('last done Mar 10 + 6 months = Sep 10',
  (await openOf(dad, oil))[0]?.due_on === '2026-09-10')

await fails('members cannot create family tasks', kid1, ({ q }) =>
  q('select todo.create_task($1)', [JSON.stringify({
    scope: 'family', title: 'x', schedule_kind: 'countdown', interval_unit: 'day',
    interval_count: 1, assignees: [kid1], unsure: true })]), /only admins/)
await fails('assignee from another family', dad, ({ q }) =>
  q('select todo.create_task($1)', [JSON.stringify({
    scope: 'family', title: 'x', schedule_kind: 'countdown', interval_unit: 'day',
    interval_count: 1, assignees: [stranger], unsure: true })]), /not in this family/)
await fails('pool needs two people', dad, ({ q }) =>
  q('select todo.create_task($1)', [JSON.stringify({
    scope: 'family', title: 'x', schedule_kind: 'countdown', interval_unit: 'day',
    interval_count: 1, assign_mode: 'pool', assignees: [kid1], unsure: true })]), /two or more/)
await fails('must say how to start', dad, ({ q }) =>
  q('select todo.create_task($1)', [JSON.stringify({
    scope: 'family', title: 'x', schedule_kind: 'countdown', interval_unit: 'day',
    interval_count: 1, assignees: [kid1] })]), /exactly one of/)

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
  cal_months: [1, 7], cal_month_days: [1], assignees: [mom], first_due_on: '2026-01-01',
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
  cal_weekdays: [1, 2, 3, 4, 5], assignees: [kid1], first_due_on: '2026-09-18',
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
  cal_weekdays: [0, 1, 2, 3, 4, 5, 6], assignees: [mom], first_due_on: '2026-09-18',
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
  interval_count: 1, active_months: [4, 5, 6, 7, 8, 9, 10], assignees: [dad], first_due_on: '2026-10-28',
})
{
  today = '2026-10-28'
  const [o] = await openOf(dad, mow)
  await complete(dad, o.id)
  const next = await openOf(dad, mow)
  check('mowing sleeps until April', next[0]?.due_on === '2027-04-01', next[0]?.due_on)
  const outOfSeason = await createTask(dad, {
    scope: 'family', title: 'Rake', schedule_kind: 'countdown', interval_unit: 'week',
    interval_count: 1, active_months: [10, 11], assignees: [dad], first_due_on: '2026-05-01',
  })
  check('first due date is pulled into the window', (await openOf(dad, outOfSeason))[0]?.due_on === '2026-10-01')
}

// --- permissions on completion -----------------------------------------------

const pool = await createTask(dad, {
  scope: 'family', title: 'Empty dishwasher', schedule_kind: 'countdown', interval_unit: 'day',
  interval_count: 1, assign_mode: 'pool', assignees: [kid1, kid2], first_due_on: '2026-09-22',
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
  check('pool records who did it', done.completed_by === kid2)
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
  interval_count: 1, assignees: [kid2], first_due_on: '2026-09-22', subtasks: ['Skim', 'Brush', 'Test'],
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
  assign_mode: 'rotate_completion', assignees: [kid1, kid2], first_due_on: '2026-09-22',
})
{
  today = '2026-09-22'
  const seq = []
  for (let i = 0; i < 3; i++) {
    const [o] = await openOf(dad, trash)
    seq.push(o.responsible_id)
    await complete(dad, o.id)
  }
  check('rotation per completion alternates', seq[0] === kid1 && seq[1] === kid2 && seq[2] === kid1,
    JSON.stringify(seq))
  const doneLast = await as(dad, ({ one }) =>
    one("select id from todo.occurrences where task_id = $1 and status = 'done' order by completed_at desc limit 1", [trash]))
  await as(dad, ({ q }) => q('select todo.undo_completion($1)', [doneLast.id]))
  const [reopened] = await openOf(dad, trash)
  check('undo puts the rotation back', reopened.responsible_id === kid1)
}

const dishes = await createTask(dad, {
  scope: 'family', title: 'Unload dishwasher', schedule_kind: 'countdown', interval_unit: 'day',
  interval_count: 1, assign_mode: 'rotate_period', rotate_unit: 'week', rotate_count: 1,
  rotate_anchor: '2026-09-14', assignees: [kid1, kid2], first_due_on: '2026-09-18',
})
{
  today = '2026-09-18' // Friday, week of Sep 14 belongs to kid1
  const [fri] = await openOf(kid1, dishes)
  check('week one belongs to kid one', fri.responsible_id === kid1)

  today = '2026-09-21' // Monday, week of Sep 21 belongs to kid2; Friday still open
  await as(kid1, ({ q }) => q('select todo.rollover()'))
  const open = await openOf(kid1, dishes)
  check('overdue stays with the kid who missed it',
    open.length === 2 && open[0].responsible_id === kid1 && open[0].due_on === '2026-09-18')
  check('new holder gets a fresh one today', open[1]?.responsible_id === kid2 && open[1]?.due_on === '2026-09-21')
  await as(kid1, ({ q }) => q('select todo.rollover()'))
  check('rollover is idempotent', (await openOf(kid1, dishes)).length === 2)

  await complete(kid1, open[0].id)
  check('finishing the old one does not spawn a duplicate', (await openOf(kid1, dishes)).length === 1)
  await complete(kid2, open[1].id)
  const [tue] = await openOf(kid2, dishes)
  check('rotation continues on the right person', tue.responsible_id === kid2 && tue.due_on === '2026-09-22')
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
    assignees: [kid1], first_due_on: '2026-09-26',
  })
  const [o] = await openOf(kid1, chore)
  await fails('someone else cannot hand it off', kid2,
    ({ q }) => q('select todo.hand_back($1, $2)', [o.id, kid2]), /not allowed/)
  await fails('cannot hand to an outsider', kid1,
    ({ q }) => q('select todo.hand_back($1, $2)', [o.id, stranger]), /not in this family/)
  await as(kid1, ({ q }) => q('select todo.hand_back($1, $2)', [o.id, dad]))
  const [after] = await openOf(dad, chore)
  const assignee = await as(dad, ({ one }) => one('select profile_id from todo.task_assignees where task_id = $1', [chore]))
  check('single mode hand back moves the task', after.responsible_id === dad && assignee.profile_id === dad)
  const feed = await as(mom, ({ rows }) =>
    rows("select payload from todo.activity where kind = 'handed_back' and task_id = $1", [chore]))
  check('hand back shows in the activity feed', feed.length === 1 && feed[0].payload.to === dad)
  const strangerFeed = await as(stranger, ({ rows }) => rows('select 1 from todo.activity'))
  check('activity stays inside the family', strangerFeed.length === 0)

  const [t] = await openOf(dad, trash)
  const holder = t.responsible_id
  await as(holder, ({ q }) => q('select todo.hand_back($1, $2)', [t.id, mom]))
  const order = await as(dad, ({ rows }) =>
    rows('select profile_id from todo.task_assignees where task_id = $1 order by position', [trash]))
  const [moved] = await openOf(dad, trash)
  check('rotation hand back moves only this one',
    moved.responsible_id === mom && order.map((r) => r.profile_id).join() === [kid1, kid2].join())

  const [p] = await openOf(kid1, pool)
  await fails('pool tasks cannot be handed off', kid1,
    ({ q }) => q('select todo.hand_back($1, $2)', [p.id, dad]), /cannot be handed/)
}

// --- members and admins ----------------------------------------------------------

await fails('removing someone with tasks is blocked', dad,
  ({ q }) => q('select todo.remove_member($1)', [kid2]), /reassign or delete/)
await fails('members cannot remove people', kid1,
  ({ q }) => q('select todo.remove_member($1)', [kid2]), /only admins/)
await fails('last admin cannot step down', stranger,
  ({ q }) => q("select todo.set_role($1, 'member')", [stranger]), /at least one admin/)
await as(dad, ({ q }) => q("select todo.set_role($1, 'member')", [dad]))
check('an admin can step down while another remains', true)
await as(mom, ({ q }) => q("select todo.set_role($1, 'admin')", [dad]))

{
  await fails('members cannot delete family tasks', kid1,
    ({ q }) => q('select todo.delete_task($1)', [mow]), /only admins/)
  await as(dad, ({ q }) => q('select todo.delete_task($1)', [mow]))
  const gone = await as(dad, ({ rows }) => rows('select id from todo.tasks where id = $1', [mow]))
  check('deleted tasks disappear', gone.length === 0)
  await as(kid1, ({ q }) => q('select todo.delete_task($1)', [diary]))
  check('you can delete your own personal task', true)
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
if (failures.length) {
  console.error(`test-db: ${failures.length} failed, ${passed} passed`)
  for (const f of failures) console.error(`  x ${f}`)
  process.exit(1)
}
console.log(`test-db: ${passed} assertions passed`)
