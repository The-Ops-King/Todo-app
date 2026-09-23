// Human wording for a task's schedule, and the defaults the task form uses.
// The database decides every due date; nothing here computes one.

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const UNIT = { day: ['day', 'days'], week: ['week', 'weeks'], month: ['month', 'months'], year: ['year', 'years'] }

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function listJoin(items) {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

function weekdayText(days) {
  const d = [...days].sort((a, b) => a - b)
  if (d.length === 7) return 'Every day'
  if (d.join() === '1,2,3,4,5') return 'Weekdays'
  if (d.join() === '0,6') return 'Weekends'
  return `Every ${listJoin(d.map((x) => WEEKDAYS[x]))}`
}

export function describeSchedule(t) {
  let text
  if (t.schedule_kind === 'countdown') {
    const n = t.interval_count
    const [one, many] = UNIT[t.interval_unit]
    if (n === 1) text = { day: 'Daily', week: 'Weekly', month: 'Monthly', year: 'Yearly' }[t.interval_unit]
    else text = `Every ${n} ${n === 1 ? one : many}`
  } else if (t.cal_weekdays) {
    text = weekdayText(t.cal_weekdays)
  } else {
    const days = listJoin([...t.cal_month_days].sort((a, b) => a - b).map(ordinal))
    text = t.cal_months
      ? `${listJoin([...t.cal_months].sort((a, b) => a - b).map((m) => MONTHS[m - 1]))} on the ${days}`
      : `Monthly on the ${days}`
  }
  if (t.active_months) text += `, ${seasonText(t.active_months)}`
  return text
}

// "Apr to Oct" for a contiguous run (wrapping over New Year), else a list.
function seasonText(months) {
  const set = new Set(months)
  if (set.size === 12) return 'all year'
  const start = [...set].find((m) => !set.has(m === 1 ? 12 : m - 1))
  if (start !== undefined) {
    let end = start
    let len = 1
    while (set.has(end === 12 ? 1 : end + 1)) {
      end = end === 12 ? 1 : end + 1
      len++
    }
    if (len === set.size) return `${MONTHS[start - 1]} to ${MONTHS[end - 1]}`
  }
  return `only ${listJoin([...set].sort((a, b) => a - b).map((m) => MONTHS[m - 1]))}`
}

// How many days early a task shows in Upcoming, from the spec: daily 0,
// weekly 1, monthly 3, quarterly and longer 7.
export function defaultLeadDays(t) {
  if (t.schedule_kind === 'calendar') {
    if (t.cal_weekdays) return t.cal_weekdays.length >= 5 ? 0 : 1
    return t.cal_months && t.cal_months.length <= 4 ? 7 : 3
  }
  const days = { day: 1, week: 7, month: 30, year: 365 }[t.interval_unit] * t.interval_count
  if (days <= 1) return 0
  if (days <= 7) return 1
  if (days < 90) return 3
  return 7
}
