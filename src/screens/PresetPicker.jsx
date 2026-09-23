import { useEffect, useMemo, useRef, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { describeSchedule } from '../lib/schedule.js'
import { addDays, todayIn } from '../lib/dates.js'
import { Avatar, Icon, personColor, presetStyle } from '../lib/presetStyle.jsx'

// Four steps:
//   1. pick     presets that fit the household
//   2. review   one list of everything; swipe away what doesn't apply
//   3. when     one card at a time: when was this last done?
//   4. who      tap a person, then tap their tasks
// Nothing is saved until the last step. The database spreads "not sure"
// tasks out so a big preset never lands on one day.

const STEPS = ['pick', 'review', 'when', 'who']

// Rough ages for one-tap answers. The exact day matters less than the month.
const WHEN = [
  ['This week', 3], ['This month', 15], ['1 to 3 months ago', 60], ['3 to 6 months ago', 135],
  ['6 to 12 months ago', 270], ['Over a year ago', 450],
]

const intervalDays = (t) => ({ day: 1, week: 7, month: 30, year: 365 }[t.interval_unit] || 0) * (t.interval_count || 0)
// Only ask where the answer changes much: tasks that repeat monthly or rarer.
const worthAsking = (t) => t.schedule_kind === 'countdown' && intervalDays(t) >= 28

export default function PresetPicker({ profile, onClose, onDone, firstRun }) {
  const [presets, setPresets] = useState(null)
  const [members, setMembers] = useState([])
  const [existing, setExisting] = useState(new Set())
  const [chosen, setChosen] = useState([])
  const [step, setStep] = useState('pick')
  const [removed, setRemoved] = useState([])
  const [undo, setUndo] = useState(null)
  const [lastDone, setLastDone] = useState({})
  const [whenIndex, setWhenIndex] = useState(0)
  const [owners, setOwners] = useState({})
  const [person, setPerson] = useState(profile.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [today, setToday] = useState(null)

  useEffect(() => {
    Promise.all([
      supabase.from('families').select('time_zone').single(),
      supabase.from('presets')
        .select(`id, slug, name, description, group_name, position,
          preset_tasks (id, title, schedule_kind, interval_unit, interval_count, cal_weekdays, cal_month_days,
            cal_months, active_months, miss_policy, position)`)
        .order('position'),
      supabase.from('profiles').select('id, display_name, is_kid').order('created_at'),
      supabase.from('tasks').select('preset_task_id').not('preset_task_id', 'is', null),
    ]).then(([f, p, m, t]) => {
      const failed = f.error || p.error || m.error || t.error
      if (failed) return setError(errorText(failed))
      setToday(todayIn(f.data.time_zone))
      setPresets(p.data.map((x) => ({ ...x, preset_tasks: [...x.preset_tasks].sort((a, b) => a.position - b.position) })))
      setMembers(m.data)
      setExisting(new Set(t.data.map((x) => x.preset_task_id)))
    })
  }, [])

  const groups = useMemo(() => {
    const g = []
    for (const p of presets || []) {
      let group = g.find((x) => x.name === p.group_name)
      if (!group) g.push((group = { name: p.group_name, presets: [] }))
      group.presets.push(p)
    }
    return g
  }, [presets])

  // Every task from the chosen presets, minus ones already added and, where
  // presets share a task (Homeowner and Renter), minus the later copy.
  const sections = useMemo(() => {
    const seen = new Set()
    return (presets || []).filter((p) => chosen.includes(p.id)).map((p) => ({
      preset: p,
      tasks: p.preset_tasks.filter((t) => {
        const key = t.title.toLowerCase()
        if (existing.has(t.id) || seen.has(key)) return false
        seen.add(key)
        return true
      }),
    }))
  }, [presets, chosen, existing])

  const kept = sections.flatMap((s) => s.tasks.filter((t) => !removed.includes(t.id)).map((t) => ({ ...t, preset: s.preset })))
  const removedTasks = sections.flatMap((s) => s.tasks).filter((t) => removed.includes(t.id))
  const toAsk = kept.filter(worthAsking)
  const stepNo = STEPS.indexOf(step) + 1
  const names = Object.fromEntries(members.map((m) => [m.id, m.display_name]))

  // index is where the task sat in the "when" step, so undo can return there.
  function remove(t, index = null) {
    setRemoved((r) => [...r, t.id])
    setUndo({ task: t, index })
  }
  function undoRemove() {
    setRemoved((r) => r.filter((x) => x !== undo.task.id))
    if (undo.index !== null) {
      setWhenIndex(undo.index)
      setStep('when')
    }
    setUndo(null)
  }
  // The next task slides into the removed one's place, so the index stays.
  function removeWhen() {
    remove(toAsk[whenIndex], whenIndex)
    if (whenIndex + 1 >= toAsk.length) setStep('who')
  }
  const undoToast = undo && (
    <div className="toast in-sheet" role="status">
      <span>Removed {undo.task.title}</span>
      <button className="link" onClick={undoRemove}>Undo</button>
    </div>
  )
  useEffect(() => {
    if (!undo) return
    const timer = setTimeout(() => setUndo(null), 5000)
    return () => clearTimeout(timer)
  }, [undo])

  function answer(date) {
    const t = toAsk[whenIndex]
    setLastDone((ld) => ({ ...ld, [t.id]: date }))
    if (whenIndex + 1 < toAsk.length) setWhenIndex(whenIndex + 1)
    else setStep('who')
  }

  function goToWhen() {
    setWhenIndex(0)
    setStep(toAsk.length ? 'when' : 'who')
  }

  const ownerOf = (id) => owners[id] || profile.id
  // Tapping gives the task to the selected person; tapping one of theirs
  // hands it back to you.
  function tapTask(id) {
    setOwners((o) => ({ ...o, [id]: ownerOf(id) === person && person !== profile.id ? profile.id : person }))
  }

  async function save() {
    setBusy(true)
    setError('')
    const items = kept.map((t) => {
      const item = { preset_task_id: t.id, assignee: ownerOf(t.id) }
      if (lastDone[t.id]) item.last_done_on = lastDone[t.id]
      return item
    })
    const { data, error } = await supabase.rpc('add_presets', { p: { assignee: profile.id, items } })
    setBusy(false)
    if (error) return setError(errorText(error))
    onDone(data)
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall picker" role="dialog" aria-label="Add presets" onClick={(e) => e.stopPropagation()}>
        <div className="picker-head">
          <div className="steps-bar" aria-hidden="true">
            {STEPS.map((s, i) => <span key={s} className={i < stepNo ? 'on' : ''} />)}
          </div>
          <div className="sheet-head">
            <span className="muted small">Step {stepNo} of 4</span>
            <button className="link" onClick={onClose}>{firstRun ? 'Skip' : 'Cancel'}</button>
          </div>
        </div>

        {!presets && !error && <p className="muted">Loading…</p>}

        {step === 'pick' && presets && (
          <>
            <h2>{firstRun ? 'What do you look after?' : 'Add a preset'}</h2>
            <p className="muted">Pick everything that fits. Each comes with the upkeep it needs.</p>
            {groups.map((g) => (
              <section key={g.name} className="preset-group">
                <h3>{g.name}</h3>
                <div className="preset-grid">
                  {g.presets.map((p) => {
                    const fresh = p.preset_tasks.filter((t) => !existing.has(t.id)).length
                    const { color, icon } = presetStyle(p)
                    const on = chosen.includes(p.id)
                    return (
                      <button key={p.id} type="button" className="preset-card" aria-pressed={on} disabled={fresh === 0}
                        style={{ '--c': color }}
                        onClick={() => setChosen(on ? chosen.filter((x) => x !== p.id) : [...chosen, p.id])}>
                        <span className="preset-icon"><Icon name={icon} color={on ? '#fff' : color} /></span>
                        <strong>{p.name}</strong>
                        <span className="preset-count">{fresh === 0 ? 'Added' : `${fresh} task${fresh === 1 ? '' : 's'}`}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
            <div className="sticky-actions">
              <button disabled={chosen.length === 0} onClick={() => setStep('review')}>
                {chosen.length ? `Next (${chosen.length} picked)` : 'Pick at least one'}
              </button>
            </div>
          </>
        )}

        {step === 'review' && (
          <>
            <h2>Here's what needs doing</h2>
            <p className="muted">Swipe left on anything that doesn't apply.</p>
            {sections.map(({ preset, tasks }) => {
              const left = tasks.filter((t) => !removed.includes(t.id))
              if (!left.length) return null
              const { color, icon } = presetStyle(preset)
              return (
                <section key={preset.id} className="preset-group">
                  <h3 className="preset-head" style={{ color }}>
                    <Icon name={icon} size={18} color={color} /> {preset.name}<span className="muted"> · {left.length}</span>
                  </h3>
                  <ul className="review-list">
                    {left.map((t) => <SwipeRow key={t.id} task={t} color={color} onRemove={() => remove(t)} />)}
                  </ul>
                </section>
              )
            })}
            {removedTasks.length > 0 && (
              <details className="removed">
                <summary>Removed ({removedTasks.length})</summary>
                <ul>
                  {removedTasks.map((t) => (
                    <li key={t.id} className="inline">
                      <span>{t.title}</span>
                      <button className="link" onClick={() => setRemoved(removed.filter((x) => x !== t.id))}>Put back</button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="sticky-actions">
              <button disabled={kept.length === 0} onClick={goToWhen}>Next ({kept.length} tasks)</button>
              <button className="link" onClick={() => setStep('pick')}>Back</button>
            </div>
          </>
        )}

        {step === 'when' && toAsk[whenIndex] && (
          <WhenCard key={toAsk[whenIndex].id} task={toAsk[whenIndex]} index={whenIndex} total={toAsk.length}
            today={today} current={lastDone[toAsk[whenIndex].id]}
            onAnswer={answer}
            onBack={() => (whenIndex ? setWhenIndex(whenIndex - 1) : setStep('review'))}
            onRemove={removeWhen}
            onSkipRest={() => setStep('who')} />
        )}

        {step === 'who' && (
          <>
            <h2>Who does what?</h2>
            <p className="muted">Tap a person, then tap their tasks. Everything else stays with you.</p>
            <div className="people">
              {members.map((m) => (
                <button key={m.id} type="button" className="person" aria-pressed={person === m.id} onClick={() => setPerson(m.id)}>
                  <Avatar name={m.display_name} color={personColor(members, m.id)} size={40} />
                  <span>{m.id === profile.id ? 'You' : m.display_name}</span>
                  <span className="muted small">{kept.filter((t) => ownerOf(t.id) === m.id).length}</span>
                </button>
              ))}
            </div>
            {person !== profile.id && (
              <button className="link" onClick={() => setOwners(Object.fromEntries(kept.map((t) => [t.id, person])))}>
                Give all of these to {names[person]}
              </button>
            )}
            {sections.map(({ preset, tasks }) => {
              const left = tasks.filter((t) => !removed.includes(t.id))
              if (!left.length) return null
              const { color, icon } = presetStyle(preset)
              return (
                <section key={preset.id} className="preset-group">
                  <h3 className="preset-head" style={{ color }}><Icon name={icon} size={18} color={color} /> {preset.name}</h3>
                  <ul className="review-list">
                    {left.map((t) => {
                      const owner = ownerOf(t.id)
                      return (
                        <li key={t.id}>
                          <button type="button" className={`task-card assignable ${owner === person ? 'picked' : ''}`}
                            style={{ '--c': color }} onClick={() => tapTask(t.id)}>
                            <span className="task-text">
                              <span className="task-title">{t.title}</span>
                              <span className="pill">{describeSchedule(t)}</span>
                            </span>
                            <Avatar name={names[owner]} color={personColor(members, owner)} />
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )
            })}
            {error && <p className="error">{error}</p>}
            <div className="sticky-actions">
              <button disabled={busy || !kept.length} onClick={save}>
                {busy ? 'Adding…' : `Add ${kept.length} task${kept.length === 1 ? '' : 's'}`}
              </button>
              <button className="link" onClick={() => {
                if (toAsk.length) {
                  setWhenIndex(toAsk.length - 1)
                  setStep('when')
                } else setStep('review')
              }}>Back</button>
            </div>
          </>
        )}
        {step === 'pick' && error && <p className="error">{error}</p>}
        {step !== 'pick' && undoToast}
      </div>
    </div>
  )
}

// Swipe left past a threshold to remove; the × does the same without a swipe.
// touch-action: pan-y keeps vertical scrolling native while sideways drags
// are tracked here.
function SwipeRow({ task, color, onRemove }) {
  const [dx, setDx] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const start = useRef(null)
  // The release handler can run before React re-renders with the last move,
  // so the live distance is kept in a ref rather than read from state.
  const dxRef = useRef(0)
  const THRESHOLD = 90

  function down(e) {
    if (e.target.closest('button')) return
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, horizontal: null }
  }
  function move(e) {
    const s = start.current
    if (!s || s.id !== e.pointerId) return
    const x = e.clientX - s.x
    const y = e.clientY - s.y
    if (s.horizontal === null && (Math.abs(x) > 8 || Math.abs(y) > 8)) {
      s.horizontal = Math.abs(x) > Math.abs(y)
      if (s.horizontal) e.currentTarget.setPointerCapture(e.pointerId)
      else start.current = null
    }
    if (s.horizontal) {
      dxRef.current = Math.min(0, x)
      setDx(dxRef.current)
    }
  }
  function up() {
    const s = start.current
    start.current = null
    const moved = dxRef.current
    dxRef.current = 0
    if (s?.horizontal && moved < -THRESHOLD) {
      setLeaving(true)
      setTimeout(onRemove, 180)
    } else setDx(0)
  }

  return (
    <li className={`swipe-wrap ${dx || leaving ? 'active' : ''}`}>
      <div className="swipe-under" aria-hidden="true"><span>Remove</span></div>
      <div className={`task-card ${leaving ? 'leaving' : ''} ${dx ? 'dragging' : ''}`}
        style={{ '--c': color, transform: leaving ? 'translateX(-110%)' : `translateX(${dx}px)` }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <span className="task-text">
          <span className="task-title">{task.title}</span>
          <span className="pill">{describeSchedule(task)}</span>
        </span>
        <button type="button" className="remove-x" aria-label={`Remove ${task.title}`} onClick={onRemove}>×</button>
      </div>
    </li>
  )
}

function WhenCard({ task, index, total, today, current, onAnswer, onRemove, onBack, onSkipRest }) {
  const [picking, setPicking] = useState(false)
  const [date, setDate] = useState(current || '')
  const { color, icon } = presetStyle(task.preset)
  return (
    <div className="when">
      <div className="when-progress"><span style={{ width: `${((index + 1) / total) * 100}%` }} /></div>
      <p className="muted small">{index + 1} of {total}</p>
      <div className="when-card" style={{ '--c': color }}>
        <span className="preset-icon big"><Icon name={icon} size={30} color={color} /></span>
        <span className="muted small">{task.preset.name}</span>
        <h2>{task.title}</h2>
        <span className="pill">{describeSchedule(task)}</span>
      </div>
      <h3 className="when-q">When did you last do this?</h3>
      {!picking ? (
        <div className="when-options">
          {WHEN.map(([label, days]) => (
            <button key={label} type="button" className="chip big" onClick={() => onAnswer(addDays(today, -days))}>{label}</button>
          ))}
          <button type="button" className="chip big" onClick={() => setPicking(true)}>Pick a date</button>
          <button type="button" className="chip big danger" onClick={onRemove}>Remove this task</button>
          <button type="button" className="chip big quiet" onClick={() => onAnswer(null)}>Never, or not sure</button>
        </div>
      ) : (
        <div className="when-date">
          <input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
          <button disabled={!date} onClick={() => onAnswer(date)}>Use this date</button>
          <button className="link" onClick={() => setPicking(false)}>Back to quick answers</button>
        </div>
      )}
      <div className="inline spread">
        <button className="link" onClick={onBack}>Back</button>
        <button className="link" onClick={onSkipRest}>Skip the rest</button>
      </div>
    </div>
  )
}
