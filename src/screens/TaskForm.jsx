import { useMemo, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { MONTHS, WEEKDAYS, defaultLeadDays, describeSchedule } from '../lib/schedule.js'
import { showsBuyLinks } from '../lib/people.js'
import { OptionList, PeoplePicker, Segmented } from '../components/Choice.jsx'

const QUICK = [
  ['Daily', 'day', 1], ['Weekly', 'week', 1], ['Monthly', 'month', 1],
  ['Every 3 months', 'month', 3], ['Every 6 months', 'month', 6], ['Yearly', 'year', 1],
]

// Builds the JSON todo.create_task expects. The database validates all of it
// again; this form only keeps people from submitting something obviously
// incomplete.
export default function TaskForm({ profile, members, today, onClose, onSaved }) {
  const isAdmin = profile.role === 'admin'
  const [title, setTitle] = useState('')
  const [scope, setScope] = useState(isAdmin ? 'family' : 'personal')
  const [kind, setKind] = useState('countdown')
  const [unit, setUnit] = useState('week')
  const [count, setCount] = useState(1)
  const [calMode, setCalMode] = useState('weekdays')
  const [weekdays, setWeekdays] = useState([])
  const [monthDay, setMonthDay] = useState(1)
  const [calMonths, setCalMonths] = useState([])
  const [start, setStart] = useState('first_due_on')
  const [startDate, setStartDate] = useState(today)
  const [assignees, setAssignees] = useState(isAdmin ? [profile.id] : [])
  const [mode, setMode] = useState('pool')
  const [subtasks, setSubtasks] = useState([])
  const [newSub, setNewSub] = useState('')
  const [more, setMore] = useState(false)
  const [missPolicy, setMissPolicy] = useState('carry')
  const [season, setSeason] = useState([])
  const [notes, setNotes] = useState('')
  const [buyQuery, setBuyQuery] = useState('')
  const [link, setLink] = useState('')
  const [leadOverride, setLeadOverride] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const schedule = useMemo(() => {
    if (kind === 'countdown') return { schedule_kind: 'countdown', interval_unit: unit, interval_count: Number(count) || 1 }
    if (calMode === 'weekdays') return { schedule_kind: 'calendar', cal_weekdays: weekdays.length ? weekdays : null }
    return {
      schedule_kind: 'calendar',
      cal_month_days: [Number(monthDay) || 1],
      cal_months: calMonths.length ? calMonths : null,
    }
  }, [kind, unit, count, calMode, weekdays, monthDay, calMonths])

  const scheduleReady = kind === 'countdown' || calMode === 'monthday' || weekdays.length > 0
  const preview = scheduleReady
    ? describeSchedule({ ...schedule, cal_weekdays: schedule.cal_weekdays ?? null, cal_month_days: schedule.cal_month_days ?? null,
        cal_months: schedule.cal_months ?? null, active_months: season.length ? season : null })
    : ''
  const lead = leadOverride === '' ? (scheduleReady ? defaultLeadDays({
    ...schedule, cal_weekdays: schedule.cal_weekdays ?? null, cal_months: schedule.cal_months ?? null,
  }) : 0) : Number(leadOverride)

  const toggleIn = (list, set, v) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  function addSub(e) {
    e?.preventDefault()
    const v = newSub.trim()
    if (!v) return
    setSubtasks([...subtasks, v])
    setNewSub('')
  }

  async function save(e) {
    e.preventDefault()
    if (!scheduleReady) return setError('Pick at least one day of the week.')
    if (scope === 'family' && assignees.length === 0) return setError('Pick who does it.')
    const p = {
      scope,
      title: title.trim(),
      notes: notes.trim() || undefined,
      buy_query: buyQuery.trim() || undefined,
      custom_link: link.trim() || undefined,
      ...schedule,
      active_months: season.length ? season : undefined,
      miss_policy: missPolicy,
      lead_days: lead,
      subtasks: newSub.trim() ? [...subtasks, newSub.trim()] : subtasks,
    }
    if (scope === 'family') {
      p.assignees = assignees
      p.assign_mode = assignees.length === 1 ? 'single' : mode
      if (p.assign_mode === 'rotate_period') {
        p.rotate_unit = 'week'
        p.rotate_count = 1
      }
    }
    if (start === 'unsure') p.unsure = true
    else p[start] = startDate
    setBusy(true)
    setError('')
    // Absent keys, not nulls: the database reads a missing key as "not set".
    const payload = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null))
    const { error } = await supabase.rpc('create_task', { p: payload })
    setBusy(false)
    if (error) return setError(errorText(error))
    onSaved()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet" role="dialog" aria-label="New task" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="sheet-head">
          <h2>New task</h2>
          <button type="button" className="link" onClick={onClose}>Cancel</button>
        </div>

        <label>
          What needs doing
          <input required maxLength={120} placeholder="Change the air filter" value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>

        {isAdmin ? (
          <div className="segmented wide" role="radiogroup" aria-label="Who sees it">
            <button type="button" aria-selected={scope === 'family'} onClick={() => setScope('family')}>Family task</button>
            <button type="button" aria-selected={scope === 'personal'} onClick={() => setScope('personal')}>Just for me</button>
          </div>
        ) : (
          <p className="muted small">This goes on your own list. Only admins add family tasks.</p>
        )}

        <fieldset>
          <legend>How often</legend>
          <div className="segmented wide">
            <button type="button" aria-selected={kind === 'countdown'} onClick={() => setKind('countdown')}>Every so often</button>
            <button type="button" aria-selected={kind === 'calendar'} onClick={() => setKind('calendar')}>On set days</button>
          </div>
          {kind === 'countdown' ? (
            <>
              <div className="chips">
                {QUICK.map(([label, u, n]) => (
                  <button key={label} type="button" className="chip" aria-pressed={unit === u && Number(count) === n}
                    onClick={() => { setUnit(u); setCount(n) }}>{label}</button>
                ))}
              </div>
              <div className="inline">
                <span>Every</span>
                <input type="number" min={1} max={1000} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value)} />
              </div>
              <Segmented value={unit} onChange={setUnit}
                options={[['day', 'Days'], ['week', 'Weeks'], ['month', 'Months'], ['year', 'Years']]} />
              <p className="muted small">Counts from the day it's done. Done late, the next one moves back too.</p>
            </>
          ) : (
            <>
              <Segmented value={calMode} onChange={setCalMode}
                options={[['weekdays', 'Days of the week'], ['monthday', 'Day of the month']]} />
              {calMode === 'weekdays' ? (
                <div className="chips">
                  {WEEKDAYS.map((d, i) => (
                    <button key={d} type="button" className="chip" aria-pressed={weekdays.includes(i)}
                      onClick={() => toggleIn(weekdays, setWeekdays, i)}>{d}</button>
                  ))}
                </div>
              ) : (
                <>
                  <div className="inline">
                    <span>On the</span>
                    <input type="number" min={1} max={31} inputMode="numeric" value={monthDay} onChange={(e) => setMonthDay(e.target.value)} />
                  </div>
                  <p className="muted small">Only in these months (leave empty for every month):</p>
                  <div className="chips">
                    {MONTHS.map((m, i) => (
                      <button key={m} type="button" className="chip" aria-pressed={calMonths.includes(i + 1)}
                        onClick={() => toggleIn(calMonths, setCalMonths, i + 1)}>{m}</button>
                    ))}
                  </div>
                </>
              )}
              <p className="muted small">Lands on these dates no matter when the last one was done.</p>
            </>
          )}
          {preview && <p className="preview">{preview}</p>}
        </fieldset>

        <fieldset>
          <legend>Starting</legend>
          <Segmented value={start} onChange={setStart}
            options={[['first_due_on', 'First due'], ['last_done_on', 'Last done'], ['unsure', 'Not sure']]} />
          {start !== 'unsure'
            ? <input type="date" required value={startDate} max={start === 'last_done_on' ? today : undefined}
                onChange={(e) => setStartDate(e.target.value)} />
            : <p className="muted small">It'll show up as due in a week.</p>}
        </fieldset>

        {scope === 'family' && (
          <fieldset>
            <legend>Who does it</legend>
            <PeoplePicker members={members} me={profile.id} multiple value={assignees} onChange={setAssignees} />
            {assignees.length > 1 && (
              <OptionList value={mode} onChange={setMode} options={[
                ['pool', 'Any of them', 'Whoever gets to it first checks it off.'],
                ['rotate_completion', 'Take turns', 'The next person in order each time it is done.'],
                ['rotate_period', 'Take turns weekly', 'A new person each week, done or not.'],
              ]} />
            )}
          </fieldset>
        )}

        <fieldset>
          <legend>Checklist (optional)</legend>
          {subtasks.length > 0 && (
            <ul className="subtasks">
              {subtasks.map((s, i) => (
                <li key={`${s}-${i}`} className="inline">
                  <span>{s}</span>
                  <button type="button" className="link" onClick={() => setSubtasks(subtasks.filter((_, j) => j !== i))}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <div className="inline">
            <input placeholder="Add a step" maxLength={120} value={newSub} onChange={(e) => setNewSub(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addSub(e)} />
            <button type="button" className="secondary" onClick={addSub}>Add</button>
          </div>
        </fieldset>

        <button type="button" className="link" onClick={() => setMore(!more)}>{more ? 'Fewer options' : 'More options'}</button>
        {more && (
          <>
            <OptionList label="If it's missed" value={missPolicy} onChange={setMissPolicy} options={[
              ['carry', 'Keep it on the list', "It stays until it's done."],
              ['skip', 'Skip it', 'Move on to the next one.'],
            ]} />
            <fieldset>
              <legend>Only in season (optional)</legend>
              <div className="chips">
                {MONTHS.map((m, i) => (
                  <button key={m} type="button" className="chip" aria-pressed={season.includes(i + 1)}
                    onClick={() => toggleIn(season, setSeason, i + 1)}>{m}</button>
                ))}
              </div>
            </fieldset>
            <label>
              Show in "Coming up" this many days early
              <input type="number" min={0} max={90} inputMode="numeric" placeholder={String(lead)}
                value={leadOverride} onChange={(e) => setLeadOverride(e.target.value)} />
            </label>
            <label>
              Notes
              <textarea rows={3} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </label>
            {showsBuyLinks(profile) && (
              <label>
                What to buy (Amazon search)
                <input maxLength={200} placeholder="20x25x1 air filter" value={buyQuery} onChange={(e) => setBuyQuery(e.target.value)} />
              </label>
            )}
            <label>
              Link
              <input type="url" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} />
            </label>
          </>
        )}

        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? 'Saving…' : 'Add task'}</button>
      </form>
    </div>
  )
}
