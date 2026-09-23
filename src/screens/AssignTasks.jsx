import { useEffect, useMemo, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { describeSchedule } from '../lib/schedule.js'
import { Avatar, Icon, personColor, presetStyle } from '../lib/presetStyle.jsx'

// "Which tasks go to Sally?" Lists the family's single-owner tasks grouped by
// preset; tap to pick, then hand them all over at once. Pooled and rotating
// tasks aren't listed: their people are set on the task itself.
export default function AssignTasks({ person, onClose, onDone }) {
  const [tasks, setTasks] = useState(null)
  const [members, setMembers] = useState([])
  const [picked, setPicked] = useState(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      supabase.from('tasks')
        .select(`id, title, scope, assign_mode, schedule_kind, interval_unit, interval_count, cal_weekdays,
          cal_month_days, cal_months, active_months, task_assignees (profile_id),
          preset_task:preset_tasks (preset:presets (id, slug, name, position))`)
        .eq('scope', 'family').eq('assign_mode', 'single').order('title'),
      supabase.from('profiles').select('id, display_name').order('created_at'),
    ]).then(([t, m]) => {
      if (t.error || m.error) return setError(errorText(t.error || m.error))
      setTasks(t.data)
      setMembers(m.data)
    })
  }, [])

  const sections = useMemo(() => {
    const out = new Map()
    for (const t of tasks || []) {
      const preset = t.preset_task?.preset || null
      const key = preset ? preset.id : 'own'
      if (!out.has(key)) out.set(key, { preset, tasks: [] })
      out.get(key).tasks.push(t)
    }
    return [...out.values()].sort((a, b) => (a.preset?.position ?? 999) - (b.preset?.position ?? 999))
  }, [tasks])

  const names = Object.fromEntries(members.map((m) => [m.id, m.display_name]))
  const toggle = (id) => {
    const next = new Set(picked)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setPicked(next)
  }

  async function give() {
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('reassign_tasks', { p_tasks: [...picked], p_to: person.id })
    setBusy(false)
    if (error) return setError(errorText(error))
    onDone()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall picker" role="dialog" aria-label={`Tasks for ${person.display_name}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Which tasks go to {person.display_name}?</h2>
          <button className="link" onClick={onClose}>Not now</button>
        </div>
        {!tasks && !error && <p className="muted">Loading…</p>}
        {tasks && !tasks.length && <p className="muted">There are no family tasks yet. Add some first, then come back.</p>}
        {sections.map(({ preset, tasks: list }) => {
          const { color, icon } = presetStyle(preset)
          return (
            <section key={preset?.id || 'own'} className="preset-group">
              <h3 className="preset-head" style={{ color }}>
                <Icon name={icon} size={18} color={color} /> {preset ? preset.name : 'Your own tasks'}
              </h3>
              <ul className="review-list">
                {list.map((t) => {
                  const owner = t.task_assignees[0]?.profile_id
                  const theirs = owner === person.id
                  const on = picked.has(t.id)
                  return (
                    <li key={t.id}>
                      <button type="button" className={`task-card assignable ${on || theirs ? 'picked' : ''}`}
                        style={{ '--c': color }} disabled={theirs} onClick={() => toggle(t.id)}>
                        <span className="task-text">
                          <span className="task-title">{t.title}</span>
                          <span className="pill">{describeSchedule(t)}</span>
                        </span>
                        {on
                          ? <Avatar name={person.display_name} color={personColor(members, person.id)} />
                          : <Avatar name={names[owner]} color={personColor(members, owner)} />}
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
          <button disabled={busy || picked.size === 0} onClick={give}>
            {busy ? 'Saving…' : picked.size ? `Give ${picked.size} task${picked.size === 1 ? '' : 's'} to ${person.display_name}` : 'Tap the tasks that are theirs'}
          </button>
        </div>
      </div>
    </div>
  )
}
