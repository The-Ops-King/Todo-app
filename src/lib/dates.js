// Day-level dates as 'YYYY-MM-DD' strings, the same shape Postgres returns for
// `date`. "Today" is always the family's day, never the device's, so a phone
// on vacation in another time zone still sees the household's list.

export function todayIn(timeZone) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date())
}

function toUTC(day) {
  const [y, m, d] = day.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function addDays(day, n) {
  return new Date(toUTC(day) + n * 86400000).toISOString().slice(0, 10)
}

// Whole days from a to b (positive when b is later).
export function daysBetween(a, b) {
  return Math.round((toUTC(b) - toUTC(a)) / 86400000)
}

const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' })
const MONTH_DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
const FULL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })

// "3 days overdue", "Due today", "Tomorrow", "Fri", "Oct 4", "Mar 10, 2027".
export function dueLabel(due, today) {
  const diff = daysBetween(today, due)
  if (diff < -1) return `${-diff} days overdue`
  if (diff === -1) return '1 day overdue'
  if (diff === 0) return 'Due today'
  if (diff === 1) return 'Tomorrow'
  const date = new Date(toUTC(due))
  if (diff < 7) return WEEKDAY.format(date)
  if (due.slice(0, 4) === today.slice(0, 4)) return MONTH_DAY.format(date)
  return FULL.format(date)
}
