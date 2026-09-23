// Turns presets/DRAFT.md into a migration that upserts every preset and task.
//
//   node scripts/build-presets.mjs 0004_presets_content.sql
//
// Every row must parse. An unrecognised "Repeats" phrase stops the build with
// the line number, so nothing is ever seeded half-read. Slugs are stable, so
// a later run into a new migration updates content in place, removes tasks
// that were deleted from the file, and keeps families' links to presets.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defaultLeadDays } from '../src/lib/schedule.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 }
const UNITS = { day: 'day', days: 'day', week: 'week', weeks: 'week', month: 'month', months: 'month', year: 'year', years: 'year' }

const month = (s) => {
  const i = MONTHS.indexOf(s.toLowerCase().slice(0, 3))
  if (i < 0) throw new Error(`not a month: ${s}`)
  return i + 1
}

function monthRange(a, b) {
  const out = []
  let m = month(a)
  const end = month(b)
  for (;;) {
    out.push(m)
    if (m === end) return out
    m = m === 12 ? 1 : m + 1
  }
}

function splitList(s) {
  return s.split(/,\s*|\s+and\s+/).map((x) => x.trim()).filter(Boolean)
}

// Returns the schedule columns for one "Repeats" cell.
export function parseRepeats(raw) {
  let s = raw.trim()
  const out = { miss_policy: 'carry' }
  if (/\(skip\)$/.test(s)) {
    out.miss_policy = 'skip'
    s = s.replace(/\s*\(skip\)$/, '')
  }
  s = s.replace(/\s*\([^)]*\)$/, '') // "(set your pickup day)" and similar notes
  if (!/^Every /.test(s)) throw new Error(`does not start with "Every": ${raw}`)
  s = s.slice(6)

  const season = s.match(/^(.*), ([A-Z][a-z]{2}) to ([A-Z][a-z]{2})$/)
  if (season) {
    out.active_months = monthRange(season[2], season[3])
    s = season[1]
  }

  let m
  if ((m = s.match(/^(\d+) (days?|weeks?|months?|years?)$/))) {
    return { ...out, schedule_kind: 'countdown', interval_unit: UNITS[m[2]], interval_count: Number(m[1]) }
  }
  if ((m = s.match(/^(day|week|month|year)$/))) {
    return { ...out, schedule_kind: 'countdown', interval_unit: m[1], interval_count: 1 }
  }
  if ((m = s.match(/^month on the (\d+)(st|nd|rd|th)$/))) {
    return { ...out, schedule_kind: 'calendar', cal_month_days: [Number(m[1])] }
  }
  if ((m = s.match(/^(\w+) to (\w+)$/)) && DAYS[m[1].toLowerCase()] !== undefined) {
    const days = []
    for (let d = DAYS[m[1].toLowerCase()]; ; d = (d + 1) % 7) {
      days.push(d)
      if (d === DAYS[m[2].toLowerCase()]) break
    }
    return { ...out, schedule_kind: 'calendar', cal_weekdays: days }
  }
  const parts = splitList(s)
  if (parts.every((p) => DAYS[p.toLowerCase()] !== undefined)) {
    return { ...out, schedule_kind: 'calendar', cal_weekdays: parts.map((p) => DAYS[p.toLowerCase()]) }
  }
  if (parts.every((p) => /^[A-Z][a-z]{2}( \d{1,2})?$/.test(p))) {
    const months = parts.map((p) => month(p.slice(0, 3)))
    const days = [...new Set(parts.map((p) => Number(p.split(' ')[1] || 1)))]
    if (days.length !== 1) throw new Error(`different days in different months is not supported: ${raw}`)
    return { ...out, schedule_kind: 'calendar', cal_months: months, cal_month_days: days }
  }
  throw new Error(`unrecognised schedule: ${raw}`)
}

const slugify = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export function parseDraft(md) {
  const presets = []
  let group = null
  let current = null
  md.split('\n').forEach((line, i) => {
    const n = i + 1
    if (line.startsWith('## ')) group = line.slice(3).trim()
    else if (line.startsWith('### ')) {
      const name = line.slice(4).replace(/\s*\(.*\)$/, '').trim()
      current = { slug: slugify(name), name, description: (line.match(/\((.*)\)$/) || [])[1] || null,
        group_name: group, position: presets.length, tasks: [] }
      presets.push(current)
    } else if (current && line.startsWith('| ') && !line.startsWith('| Task') && !line.startsWith('|---')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim())
      if (cells.length !== 4) throw new Error(`line ${n}: expected 4 columns, got ${cells.length}`)
      const [title, repeats, subtasks, buy] = cells
      let schedule
      try {
        schedule = parseRepeats(repeats)
      } catch (err) {
        throw new Error(`line ${n}: ${err.message}`)
      }
      const task = {
        slug: `${current.slug}/${slugify(title)}`,
        title,
        ...schedule,
        subtasks: subtasks ? subtasks.split(/;\s*/).map((x) => x.trim()).filter(Boolean) : [],
        // "[size]" and "[model]" are for the family to fill in later.
        buy_query: buy ? buy.replace(/\s*\[[^\]]*\]/g, '').trim() || null : null,
        position: current.tasks.length,
      }
      task.lead_days = defaultLeadDays({ cal_weekdays: null, cal_months: null, ...task })
      current.tasks.push(task)
    }
  })
  const seen = new Set()
  for (const p of presets) {
    if (!p.tasks.length) throw new Error(`preset "${p.name}" has no tasks`)
    for (const t of p.tasks) {
      if (seen.has(t.slug)) throw new Error(`duplicate task "${t.title}" in ${p.name}`)
      seen.add(t.slug)
    }
  }
  return presets
}

const q = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`)
const arr = (a) => (a && a.length ? `'{${a.join(',')}}'::int[]` : 'null')
const textArr = (a) => `array[${a.map(q).join(', ')}]::text[]`

export function toSql(presets) {
  const lines = [
    '-- Generated by scripts/build-presets.mjs from presets/DRAFT.md. Do not edit by hand;',
    '-- change the markdown and generate a new migration.',
    '',
  ]
  for (const p of presets) {
    lines.push(`insert into todo.presets (slug, name, description, group_name, position)
values (${q(p.slug)}, ${q(p.name)}, ${q(p.description)}, ${q(p.group_name)}, ${p.position})
on conflict (slug) do update set name = excluded.name, description = excluded.description,
  group_name = excluded.group_name, position = excluded.position;`)
    for (const t of p.tasks) {
      lines.push(`insert into todo.preset_tasks (slug, preset_id, title, schedule_kind, interval_unit, interval_count,
  cal_weekdays, cal_month_days, cal_months, active_months, miss_policy, lead_days, subtasks, buy_query, position)
select ${q(t.slug)}, id, ${q(t.title)}, ${q(t.schedule_kind)}, ${q(t.interval_unit)}, ${t.interval_count ?? 'null'},
  ${arr(t.cal_weekdays)}, ${arr(t.cal_month_days)}, ${arr(t.cal_months)}, ${arr(t.active_months)},
  ${q(t.miss_policy)}, ${t.lead_days}, ${textArr(t.subtasks)}, ${q(t.buy_query)}, ${t.position}
from todo.presets where slug = ${q(p.slug)}
on conflict (slug) do update set preset_id = excluded.preset_id, title = excluded.title,
  schedule_kind = excluded.schedule_kind, interval_unit = excluded.interval_unit, interval_count = excluded.interval_count,
  cal_weekdays = excluded.cal_weekdays, cal_month_days = excluded.cal_month_days, cal_months = excluded.cal_months,
  active_months = excluded.active_months, miss_policy = excluded.miss_policy, lead_days = excluded.lead_days,
  subtasks = excluded.subtasks, buy_query = excluded.buy_query, position = excluded.position;`)
    }
  }
  const taskSlugs = presets.flatMap((p) => p.tasks.map((t) => q(t.slug)))
  lines.push(`delete from todo.preset_tasks where slug not in (${taskSlugs.join(', ')});`)
  lines.push(`delete from todo.presets where slug not in (${presets.map((p) => q(p.slug)).join(', ')});`)
  return lines.join('\n\n') + '\n'
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const name = process.argv[2]
  if (!name || !/^\d{4}_[a-z0-9_]+\.sql$/.test(name)) {
    console.error('usage: node scripts/build-presets.mjs 0004_presets_content.sql')
    process.exit(1)
  }
  const out = join(root, 'supabase/migrations', name)
  if (existsSync(out)) {
    console.error(`${name} already exists. Migrations are never edited; pick the next number.`)
    process.exit(1)
  }
  const presets = parseDraft(readFileSync(join(root, 'presets/DRAFT.md'), 'utf8'))
  writeFileSync(out, toSql(presets))
  const count = presets.reduce((n, p) => n + p.tasks.length, 0)
  console.log(`wrote ${name}: ${presets.length} presets, ${count} tasks`)
}
