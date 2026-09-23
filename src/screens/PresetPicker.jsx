import { useEffect, useMemo, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { describeSchedule } from '../lib/schedule.js'

// Two steps: pick the presets that fit the household, then uncheck anything
// that doesn't apply. Everything added goes to one person (changeable per
// task later). "Not sure" is the default for last-done; the database spreads
// those out so a big preset never lands on one day.
export default function PresetPicker({ profile, onClose, onDone, firstRun }) {
  const [presets, setPresets] = useState(null)
  const [members, setMembers] = useState([])
  const [existing, setExisting] = useState(new Set())
  const [chosen, setChosen] = useState([])
  const [step, setStep] = useState(1)
  const [unchecked, setUnchecked] = useState(new Set())
  const [lastDone, setLastDone] = useState({})
  const [assignee, setAssignee] = useState(profile.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      supabase.from('presets')
        .select(`id, slug, name, description, group_name, position,
          preset_tasks (id, title, schedule_kind, interval_unit, interval_count, cal_weekdays, cal_month_days,
            cal_months, active_months, miss_policy, position)`)
        .order('position'),
      supabase.from('profiles').select('id, display_name, is_kid').order('created_at'),
      supabase.from('tasks').select('preset_task_id').not('preset_task_id', 'is', null),
    ]).then(([p, m, t]) => {
      const failed = p.error || m.error || t.error
      if (failed) return setError(errorText(failed))
      setPresets(p.data.map((x) => ({ ...x, preset_tasks: [...x.preset_tasks].sort((a, b) => a.position - b.position) })))
      setMembers(m.data)
      setExisting(new Set(t.data.map((x) => x.preset_task_id)))
    })
  }, [])

  const groups = useMemo(() => {
    if (!presets) return []
    const g = []
    for (const p of presets) {
      let group = g.find((x) => x.name === p.group_name)
      if (!group) g.push((group = { name: p.group_name, presets: [] }))
      group.presets.push(p)
    }
    return g
  }, [presets])

  const selected = presets ? presets.filter((p) => chosen.includes(p.id)) : []
  // Homeowner and Renter (and a few others) share tasks. The first chosen
  // preset keeps a shared task; later ones show it as covered.
  const coveredBy = useMemo(() => {
    const seen = new Map()
    const covered = new Map()
    for (const p of selected) {
      for (const t of p.preset_tasks) {
        const key = t.title.toLowerCase()
        if (seen.has(key)) covered.set(t.id, seen.get(key))
        else seen.set(key, p.name)
      }
    }
    return covered
  }, [presets, chosen]) // eslint-disable-line react-hooks/exhaustive-deps
  const items = selected.flatMap((p) => p.preset_tasks)
    .filter((t) => !existing.has(t.id) && !unchecked.has(t.id) && !coveredBy.has(t.id))

  const toggle = (set, setter, id) => {
    const next = new Set(set)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setter(next)
  }

  async function add() {
    setBusy(true)
    setError('')
    const payload = {
      assignee,
      items: items.map((t) => (lastDone[t.id] ? { preset_task_id: t.id, last_done_on: lastDone[t.id] } : { preset_task_id: t.id })),
    }
    const { data, error } = await supabase.rpc('add_presets', { p: payload })
    setBusy(false)
    if (error) return setError(errorText(error))
    onDone(data)
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall" role="dialog" aria-label="Add presets" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{step === 1 ? (firstRun ? 'What do you look after?' : 'Add a preset') : 'Uncheck what doesn’t apply'}</h2>
          <button className="link" onClick={onClose}>{firstRun ? 'Skip' : 'Cancel'}</button>
        </div>

        {!presets && !error && <p className="muted">Loading…</p>}

        {step === 1 && presets && (
          <>
            <p className="muted">Pick everything that fits. Each one comes with the upkeep tasks it needs, and you'll uncheck the ones that don't apply next.</p>
            {groups.map((g) => (
              <section key={g.name} className="preset-group">
                <h3>{g.name}</h3>
                <div className="preset-grid">
                  {g.presets.map((p) => {
                    const fresh = p.preset_tasks.filter((t) => !existing.has(t.id)).length
                    return (
                      <button key={p.id} type="button" className="preset-card" aria-pressed={chosen.includes(p.id)}
                        disabled={fresh === 0}
                        onClick={() => setChosen(chosen.includes(p.id) ? chosen.filter((x) => x !== p.id) : [...chosen, p.id])}>
                        <strong>{p.name}</strong>
                        <span>{fresh === 0 ? 'Already added' : `${fresh} task${fresh === 1 ? '' : 's'}`}</span>
                      </button>
                    )
                  })}
                </div>
              </section>
            ))}
            <button disabled={chosen.length === 0} onClick={() => setStep(2)}>
              {chosen.length ? 'Next' : 'Pick at least one'}
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <label>
              Assign these to
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                {members.map((m) => <option key={m.id} value={m.id}>{m.id === profile.id ? `${m.display_name} (you)` : m.display_name}</option>)}
              </select>
            </label>
            <p className="muted small">
              You can hand any task to someone else later. Leave "Last done" as "Not sure" and those get spread over
              the next few weeks instead of all landing at once.
            </p>
            {selected.map((p) => (
              <section key={p.id} className="preset-group">
                <h3>{p.name}</h3>
                <ul className="preset-tasks">
                  {p.preset_tasks.filter((t) => !existing.has(t.id)).map((t) => {
                    if (coveredBy.has(t.id)) {
                      return (
                        <li key={t.id} className="off">
                          <span className="pt-title">{t.title}</span>
                          <span className="pt-meta">Already in {coveredBy.get(t.id)}</span>
                        </li>
                      )
                    }
                    const on = !unchecked.has(t.id)
                    return (
                      <li key={t.id} className={on ? '' : 'off'}>
                        <label className="toggle">
                          <input type="checkbox" checked={on} onChange={() => toggle(unchecked, setUnchecked, t.id)} />
                          <span>
                            <span className="pt-title">{t.title}</span>
                            <span className="pt-meta">{describeSchedule(t)}</span>
                          </span>
                        </label>
                        {on && t.schedule_kind === 'countdown' && (
                          <LastDone value={lastDone[t.id] || ''} onChange={(v) => setLastDone({ ...lastDone, [t.id]: v })} />
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
            {error && <p className="error">{error}</p>}
            <div className="sticky-actions">
              <button disabled={busy || items.length === 0} onClick={add}>
                {busy ? 'Adding…' : `Add ${items.length} task${items.length === 1 ? '' : 's'}`}
              </button>
              <button className="link" onClick={() => setStep(1)}>Back</button>
            </div>
          </>
        )}
        {step === 1 && error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}

function LastDone({ value, onChange }) {
  const [open, setOpen] = useState(Boolean(value))
  if (!open) {
    return <button type="button" className="link small" onClick={() => setOpen(true)}>Last done: not sure</button>
  }
  return (
    <div className="inline last-done">
      <span className="small">Last done</span>
      <input type="date" value={value} max={new Date().toISOString().slice(0, 10)} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="link small" onClick={() => { onChange(''); setOpen(false) }}>Not sure</button>
    </div>
  )
}
