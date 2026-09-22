# To Do Dash: spec

A household to-do list built around recurring tasks. A task comes back on its
schedule and stays on your list until someone checks it off. Families share
tasks, assign them to specific people, and rotate chores between people.

Status: draft for approval. Nothing below is built yet.

## Decisions already made

| Area | Decision |
|---|---|
| Audience | Built for one household first. Data model is multi-family from day one so going public later is not a rewrite. |
| Platform | PWA (installable web app). Native later only if usage justifies it. |
| Frontend | Vite + React, deployed on Vercel at `todo.jtylerray.com` for now. |
| Backend | Supabase: Postgres, auth, row level security, `pg_cron`, one Edge Function for push. The browser talks to Supabase directly. There is no separate API server. |
| Supabase project | Your existing project, shared with your other apps. Everything lives in its own `todo` schema, not `public`. |
| Migrations | SQL files in `supabase/migrations`, applied in order by every production deploy using `SUPABASE_DB_URL`. A failed migration fails the deploy. Preview deploys never touch the database. |
| Adult sign in | 6 digit code by email, sent through Resend as Supabase's SMTP. |
| Notifications | Web push only. One daily summary per person at a time they pick. No email reminders, no SMS. |
| Invites | Invite links, shared however you like (text, AirDrop). The app never sends email. |
| Kids | Created by an admin with a first name only. A one-time setup code links the kid's phone, which then stays signed in with no PIN or password. |
| Buy links | Never shown to kid accounts. Shown to adults unless an admin hides them for that person. |
| Families | One family per person. |
| Roles | Admin and Member. |
| Affiliate links | Amazon, in the app only. Tag is a placeholder until you have one. |

## Concepts

**Task.** The definition: title, notes, schedule, subtasks, who is assigned,
optional buy link. A task is either **personal** (visible only to its owner) or
**family** (visible to everyone in the family).

**Occurrence.** One instance of a task being due. "Change the oil, due
2026-10-01" is an occurrence. Checking something off completes an occurrence,
and completing it creates the next one. History, undo, subtask checks, the
chore chart and "who was responsible" all hang off occurrences.

Why occurrences instead of a single "next due date" column on the task: the
rotation rule you chose (Child A keeps her overdue dishwasher after the week
passes to Child B) needs two open instances of the same task at once. A single
due date column cannot represent that.

## Schedules

Every task has exactly one schedule.

**Countdown.** Every N days, weeks, months or years, counted from the day it
was completed.
- Oil every 6 months, done 2026-03-10, next due 2026-09-10.
- Done late on 2026-04-01, next due moves to 2026-10-01.
- Month math clamps to the end of the month: due Jan 31 + 1 month = Feb 28 (or 29).

**Calendar.** Due on fixed dates regardless of when the last one was done.
- Weekdays: "every Tuesday", "Mon and Thu", "Mon to Fri".
- Day of month: "the 1st", "the 15th". A day past the month's end (31st) lands on the last day.
- Months + day: "Jan 1 and Jul 1", "Apr 15, Jun 15, Sep 15, Jan 15".
- Next due is the first matching date after the later of (the occurrence's due date, the completion date). So January's filter done in August skips July and lands on next January, instead of instantly being overdue again.

**Active months (optional, either schedule type).** Mowing weekly only
April to October. Outside the window the task sleeps: no occurrence is created,
and the first occurrence of the next season lands on the first matching date
inside the window.

**Miss policy.**
- `carry` (default): an unfinished occurrence stays on Today, marked with days overdue.
- `skip`: at local midnight after the due date, it is recorded as skipped and the next occurrence is created. For daily habits where yesterday no longer matters.

**Lead time.** How many days before the due date the occurrence shows in
Upcoming. Default by interval: daily 0, weekly 1, monthly 3, quarterly and
longer 7. Editable per task.

**Time zone.** Each family has one time zone, set from the creator's device when
the family is created. "Today", "midnight" and summary times all use it. One
zone per household is correct for a household. Per-person zones only matter
once people in one family live in different places, which is out of scope.

## Assignment

A family task always has at least one assignee. No task is ever unassigned.

| Mode | Who sees it on Today | Who is responsible |
|---|---|---|
| Single (default) | The assignee | The assignee |
| Pool | Every person in the pool | Whoever completes it, recorded |
| Rotate per completion | The current person | Moves to the next person each time it is completed |
| Rotate per period | The person whose period it is | Changes every N days/weeks/months from an anchor date, e.g. weekly on Mondays |

Rules:
- Each occurrence records who was responsible when it was created. For rotate per period, that is the person whose period contains the due date. So an overdue occurrence stays with the person who missed it, and the new holder gets a fresh one.
- **Hand back.** Whoever is responsible for an occurrence can pass it to another family member. In single mode that changes the task's assignee. In rotation modes it swaps only that occurrence and the order stays the same. The person who assigned it sees the change in the activity feed.
- **Who can check off:** the person responsible (anyone in the pool, for pool mode) plus admins.
- Removing a member is blocked until an admin has reassigned or deleted every family task that person is on.

Known weak spot (you flagged it): overdue items staying with the person who
missed them means a rotation can pile up on one kid. Revisit once it is in use.

## Subtasks

A checklist inside a task. Pool: skim, brush, test chemicals. Subtasks have no
assignee or schedule of their own. Checks belong to the occurrence, so they
reset automatically with the next one. The occurrence completes when every
subtask is checked, or when the responsible person checks the whole task off.

## Roles and permissions

| Action | Admin | Member |
|---|---|---|
| Invite, remove members, change roles | Yes | No |
| Add kids, make kid setup codes | Yes | No |
| Hide buy links for a person | Yes | No |
| Create, edit, delete family tasks | Yes | No |
| Complete a family occurrence | Any | Only if responsible |
| Hand back an occurrence | Yes | Only if responsible |
| See all family tasks | Yes | Yes |
| Create, edit, delete own personal tasks | Yes | Yes |
| See someone else's personal tasks | No | No |

The family creator is the first admin. A family must always have at least one
admin, so the database refuses a change that would leave none. Kid accounts
are always members and can never be made admins.

These rules are enforced in Postgres through row level security and
`security definer` functions, never only in the React code. The browser can
read what it is allowed to read. Every state change (complete, undo, skip,
hand back, create/edit task, add preset) goes through a database function that
checks permission and applies the change in one transaction. The browser never
writes occurrence rows directly.

## Undo and history

Every occurrence keeps due date, responsible person, status (open, done,
skipped), completed by, completed at.

Undo reopens the most recent completed occurrence and deletes the one its
completion created, as long as that next one has not been touched (no subtask
checks, not completed). Only the latest completion of a task can be undone.
One accidental tap should never push the oil change out 6 months.

## Accounts and onboarding

**Adults** sign in with a 6 digit code emailed through Resend, not a clickable magic link. On iOS a link in an email opens in Safari, and Safari and the installed Home Screen app do not share a login, so a magic link would log you into the wrong one. Typing a code into the app avoids that.

**Kids.** An admin adds a kid by first name. That is all the app stores about a kid: no email, phone, birthday, last name or photo. The admin gets an 8 character setup code (15 minutes, single use). On the kid's phone, "Setting up a kid's phone?" starts an anonymous Supabase session and the code links it to the kid. The phone then opens straight to the kid's list and never signs out. A new phone gets a new code, and the kid's chores and history move with them; the old phone loses access. Anonymous sessions can never create a family or accept an adult invite. Profiles have their own id and point at whichever login currently holds them, which is what lets a kid move between devices.

**Invite links.** Admin creates one, chooses the role, and it is single use and expires in 7 days. Only a hash of the token is stored.

**Onboarding flow:**
1. Sign in.
2. Your name.
3. Create your family (name; time zone detected).
4. Add people: invite adults by link, add kids and set up their phones with a code.
5. Pick presets. Each preset shows all its tasks checked. Uncheck what does not apply. For each remaining task: "When did you last do this?" with a date or "Not sure". "Not sure" puts it in Upcoming, due in 7 days.
6. Assign family tasks (defaults to you).
7. Install to Home Screen, then allow notifications, then pick summary time. iOS only allows web push after install, so the order matters.

## Screens

- **Today.** Overdue, Today, Upcoming. Toggle between Mine and Whole family.
- **Task detail.** Schedule, subtasks, buy link, history, hand back, undo.
- **Task editor.** Owner for personal tasks, admins for family tasks.
- **Chore chart.** Week grid, people by days, showing who is on what. Built from occurrences and rotation data.
- **Family.** Members, roles, invites, kid logins. Admin only for changes.
- **Activity.** Hand backs, completions by others, reassignments.
- **Settings.** Summary time (15 minute steps), notifications on/off, install help.

## Daily summary push

- `pg_cron` runs every 15 minutes and calls one Edge Function through `pg_net`.
- The function finds people whose summary time has passed in their family's time zone and who have not had today's summary yet.
- It sends one push per device: "4 things today, 1 overdue."
- A `summary_log (profile_id, local_date)` unique row makes it idempotent. A retry or overlapping run cannot double send.
- The same run handles midnight rollover: skip-policy occurrences past due get recorded as skipped, and rotate-per-period tasks get their new period's occurrence.
- A push endpoint that returns 404 or 410 is deleted. That is the browser telling us the subscription is gone.
- Works on any Vercel plan because Vercel cron is not involved.

## Affiliate links

- Presets carry an Amazon search query, not a fixed product. Air filters, fridge filters and wiper blades come in sizes, and a search link lets the family set their size once on the task ("20x25x1 air filter").
- The link is `https://www.amazon.com/s?k=<query>&tag=<AMAZON_TAG>`. `AMAZON_TAG` is one build variable, set to a placeholder for now.
- Custom tasks can hold any plain link. No tag is added to those.
- Amazon requires the disclosure "As an Amazon Associate I earn from qualifying purchases." It goes on any screen that shows a tagged link.
- Links never go in push notifications.

## Data model

```
families        id, name, time_zone, created_by, created_at
profiles        id, family_id, display_name, role (admin|member),
                user_id (current login, null for a kid between phones),
                is_kid, hide_buy_links, summary_time,
                summary_enabled, created_at
invites         id, family_id, token_hash, role, created_by, expires_at,
                used_by, used_at, revoked_at
tasks           id, family_id, scope (personal|family), owner_id (personal only),
                title, notes, buy_query, custom_link,
                schedule_kind (countdown|calendar),
                interval_unit (day|week|month|year), interval_count,
                cal_weekdays int[], cal_month_days int[], cal_months int[],
                active_months int[], miss_policy (carry|skip), lead_days,
                assign_mode (single|pool|rotate_completion|rotate_period),
                rotate_unit, rotate_count, rotate_anchor date,
                rotate_cursor int, preset_task_id, created_by,
                created_at, updated_at, deleted_at
task_assignees  task_id, profile_id, position
subtasks        id, task_id, title, position
occurrences     id, task_id, due_on date, responsible_id (null only in pool mode),
                status (open|done|skipped), completed_by, completed_at,
                created_from (occurrence id that spawned it)
subtask_checks  occurrence_id, subtask_id, checked_by, checked_at
activity        id, family_id, actor_id, kind, task_id, occurrence_id,
                payload jsonb, created_at
presets         id, slug, name, group_name, position
preset_tasks    id, preset_id, title, notes, schedule fields as on tasks,
                subtasks jsonb, buy_query, position
push_subs       id, profile_id, endpoint, p256dh, auth, created_at,
                last_ok_at, fail_count
summary_log     profile_id, local_date (unique together)
```

Dates that mean "a day" (`due_on`, `rotate_anchor`) are `date`, not
timestamps. A due date is a calendar day in the family's time zone. Storing it
as a timestamp is how "due today" turns into "due yesterday" at 7pm.

## Where the recurrence logic lives

One place: Postgres functions (`next_due_on`, `responsible_for`,
`complete_occurrence`, `undo_completion`, `rollover`). The UI shows "next due"
previews by calling the same function rather than reimplementing the math in
JavaScript, so the two can never disagree.

These functions get a SQL test suite that runs against a local Postgres
(installed in this environment) with no network: month-end clamping, leap
years, calendar skipping when very late, active-month windows, each rotation
mode, overdue staying with the person who missed it, undo, and every permission
rule attempted as the wrong user.

## Build order

Each step ends working and tested before the next starts.

0. **Setup (you).** Vercel project for this repo, Supabase via the Vercel Marketplace, domain.
1. **Database.** Schema, RLS, recurrence and completion functions, SQL tests.
2. **Accounts.** Adult sign in, onboarding, families, invite links, kid logins.
3. **Tasks.** Create/edit, Today, complete, undo, skip, subtasks, history.
4. **Assignment.** Pool and both rotations, hand back, activity, chore chart.
5. **Presets.** Seed approved content, preset picker with uncheck and "last done".
6. **PWA and push.** Manifest, service worker, install flow, VAPID keys, summary function, cron.
7. **Affiliate links.** Buy queries, tag, disclosure.
8. **Repo docs.** `CLAUDE.md` with the same "learned the expensive way" notes Leak-calc has.

## Later, not v1

- **Mileage.** v1 is time based only, and presets use the time half of "6 months or 5,000 miles". Later: a monthly prompt to enter the odometer, and tasks that can be due on miles, engine hours or time, whichever comes first.
- **Rotation pile-up.** Revisit overdue items staying with the person who missed them once the family is using it.

## Open decisions

1. **Preset content.** See `presets/DRAFT.md`. Nothing is seeded until you approve it.
