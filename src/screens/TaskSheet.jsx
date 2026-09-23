import { useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { dueLabel } from '../lib/dates.js'
import { describeSchedule } from '../lib/schedule.js'
import { buyLink, showsBuyLinks } from '../lib/people.js'

const MODE_TEXT = {
  pool: 'Anyone listed can do it',
  rotate_completion: 'Takes turns each time it is done',
  rotate_period: 'Takes turns by period',
}

export default function TaskSheet({ occ, profile, members, today, checks, canWork, onClose, onChanged, onChecksChanged }) {
  const t = occ.task
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [handTo, setHandTo] = useState('')
  const names = Object.fromEntries(members.map((m) => [m.id, m.display_name]))
  const isAdmin = profile.role === 'admin'
  const subtasks = [...t.subtasks].sort((a, b) => a.position - b.position)
  const checked = new Set(checks.map((c) => c.subtask_id))
  const canHandBack = t.scope === 'family' && t.assign_mode !== 'pool' && (isAdmin || occ.responsible_id === profile.id)
  const canDelete = t.scope === 'personal' || isAdmin

  async function run(fn, after) {
    setBusy(true)
    setError('')
    const { data, error } = await fn()
    setBusy(false)
    if (error) return setError(errorText(error))
    after(data)
  }

  const toggle = (s) => run(
    () => supabase.rpc('set_subtask', { p_occurrence: occ.id, p_subtask: s.id, p_checked: !checked.has(s.id) }),
    (completed) => (completed ? onChanged() : onChecksChanged()),
  )
  const complete = () => run(() => supabase.rpc('complete_occurrence', { p_occurrence: occ.id }), onChanged)
  const handBack = () => run(() => supabase.rpc('hand_back', { p_occurrence: occ.id, p_to: handTo }), onChanged)
  const remove = () => {
    if (!window.confirm(`Delete "${t.title}"? Its history is kept, but it won't come back.`)) return
    run(() => supabase.rpc('delete_task', { p_task: t.id }), onChanged)
  }

  const who = t.scope === 'personal'
    ? 'Just you'
    : t.assign_mode === 'pool'
      ? t.task_assignees.map((a) => names[a.profile_id]).join(', ')
      : names[occ.responsible_id]

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={t.title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{t.title}</h2>
          <button className="link" onClick={onClose}>Close</button>
        </div>
        <p className={occ.due_on < today ? 'overdue-text' : 'muted'}>{dueLabel(occ.due_on, today)}</p>
        <dl className="facts">
          <dt>Repeats</dt><dd>{describeSchedule(t)}{t.miss_policy === 'skip' ? ' (skipped if missed)' : ''}</dd>
          <dt>Who</dt><dd>{who}{t.assign_mode !== 'single' && t.scope === 'family' ? `. ${MODE_TEXT[t.assign_mode]}` : ''}</dd>
        </dl>
        {t.notes && <p className="notes">{t.notes}</p>}

        {subtasks.length > 0 && (
          <ul className="subtasks">
            {subtasks.map((s) => (
              <li key={s.id}>
                <label className="toggle">
                  <input type="checkbox" checked={checked.has(s.id)} disabled={busy || !canWork} onChange={() => toggle(s)} />
                  {s.title}
                </label>
              </li>
            ))}
          </ul>
        )}

        {t.buy_query && showsBuyLinks(profile) && (
          <div className="buy">
            <a className="button secondary" href={buyLink(t.buy_query)} target="_blank" rel="noopener noreferrer sponsored">
              Buy {t.buy_query} on Amazon
            </a>
            <p className="muted small">As an Amazon Associate I earn from qualifying purchases.</p>
          </div>
        )}
        {t.custom_link && (
          <a className="button secondary" href={t.custom_link} target="_blank" rel="noopener noreferrer">Open link</a>
        )}

        {canWork && <button disabled={busy} onClick={complete}>Mark done</button>}

        {canHandBack && (
          <div className="hand-back">
            <label>
              Hand it to someone else
              <select value={handTo} onChange={(e) => setHandTo(e.target.value)}>
                <option value="">Choose a person</option>
                {members.filter((m) => m.id !== occ.responsible_id).map((m) => (
                  <option key={m.id} value={m.id}>{m.display_name}</option>
                ))}
              </select>
            </label>
            {handTo && <button className="secondary" disabled={busy} onClick={handBack}>Hand to {names[handTo]}</button>}
          </div>
        )}

        {error && <p className="error">{error}</p>}
        {canDelete && <button className="link danger" disabled={busy} onClick={remove}>Delete task</button>}
      </div>
    </div>
  )
}
