// Guardrails for the browser-side helpers. No network, no dependencies.
import { addDays, daysBetween, dueLabel } from '../src/lib/dates.js'
import { describeSchedule, defaultLeadDays } from '../src/lib/schedule.js'
globalThis.__AMAZON_TAG__ = 'test-20'
const { parseInvite } = await import('../src/lib/invite.js')
const { showsBuyLinks, buyLink } = await import('../src/lib/people.js')

let passed = 0
const failures = []
const eq = (name, got, want) => (got === want ? passed++ : failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))

eq('add days across month', addDays('2026-01-31', 1), '2026-02-01')
eq('add days across leap day', addDays('2028-02-28', 1), '2028-02-29')
eq('days between', daysBetween('2026-09-20', '2026-09-23'), 3)
eq('days between across DST', daysBetween('2026-11-01', '2026-11-02'), 1)

const today = '2026-09-23' // a Wednesday
eq('overdue plural', dueLabel('2026-09-20', today), '3 days overdue')
eq('overdue one', dueLabel('2026-09-22', today), '1 day overdue')
eq('today', dueLabel('2026-09-23', today), 'Due today')
eq('tomorrow', dueLabel('2026-09-24', today), 'Tomorrow')
eq('this week', dueLabel('2026-09-26', today), 'Sat')
eq('this year', dueLabel('2026-10-04', today), 'Oct 4')
eq('next year', dueLabel('2027-03-10', today), 'Mar 10, 2027')

const cd = (unit, n, extra = {}) => ({ schedule_kind: 'countdown', interval_unit: unit, interval_count: n, ...extra })
const cal = (extra) => ({ schedule_kind: 'calendar', cal_weekdays: null, cal_month_days: null, cal_months: null, ...extra })
eq('daily', describeSchedule(cd('day', 1)), 'Daily')
eq('every 6 months', describeSchedule(cd('month', 6)), 'Every 6 months')
eq('every 2 weeks', describeSchedule(cd('week', 2)), 'Every 2 weeks')
eq('weekdays', describeSchedule(cal({ cal_weekdays: [5, 1, 2, 3, 4] })), 'Weekdays')
eq('one weekday', describeSchedule(cal({ cal_weekdays: [2] })), 'Every Tue')
eq('two weekdays', describeSchedule(cal({ cal_weekdays: [4, 1] })), 'Every Mon and Thu')
eq('month day', describeSchedule(cal({ cal_month_days: [1] })), 'Monthly on the 1st')
eq('months and day', describeSchedule(cal({ cal_month_days: [1], cal_months: [7, 1] })), 'Jan and Jul on the 1st')
eq('ordinals', describeSchedule(cal({ cal_month_days: [22, 11, 3] })), 'Monthly on the 3rd, 11th and 22nd')
eq('season', describeSchedule(cd('week', 1, { active_months: [4, 5, 6, 7, 8, 9, 10] })), 'Weekly, Apr to Oct')
eq('season over new year', describeSchedule(cd('week', 1, { active_months: [11, 12, 1, 2, 3] })), 'Weekly, Nov to Mar')
eq('scattered months', describeSchedule(cd('month', 1, { active_months: [1, 6] })), 'Monthly, only Jan and Jun')

eq('lead daily', defaultLeadDays(cd('day', 1)), 0)
eq('lead weekly', defaultLeadDays(cd('week', 1)), 1)
eq('lead monthly', defaultLeadDays(cd('month', 1)), 3)
eq('lead quarterly', defaultLeadDays(cd('month', 3)), 7)
eq('lead weekdays', defaultLeadDays(cal({ cal_weekdays: [1, 2, 3, 4, 5] })), 0)
eq('lead twice a year', defaultLeadDays(cal({ cal_month_days: [1], cal_months: [1, 7] })), 7)

const token = 'a'.repeat(64)
eq('invite from link', parseInvite(`https://todo.jtylerray.com/?invite=${token}`), token)
eq('invite bare', parseInvite(` ${token.toUpperCase()} `), token)
eq('invite junk', parseInvite('hello'), null)

eq('buy link is a tagged search', buyLink('20x25x1 air filter'), 'https://www.amazon.com/s?k=20x25x1%20air%20filter&tag=test-20')
eq('kids never see buy links', showsBuyLinks({ is_kid: true, hide_buy_links: false }), false)
eq('adults see buy links', showsBuyLinks({ is_kid: false, hide_buy_links: false }), true)
eq('admin can hide them', showsBuyLinks({ is_kid: false, hide_buy_links: true }), false)

if (failures.length) {
  console.error(`test-app: ${failures.length} failed, ${passed} passed`)
  for (const f of failures) console.error(`  x ${f}`)
  process.exit(1)
}
console.log(`test-app: ${passed} assertions passed`)
