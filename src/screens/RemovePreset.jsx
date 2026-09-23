import { useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { describeSchedule } from '../lib/schedule.js'
import { Icon, presetStyle } from '../lib/presetStyle.jsx'

// Confirm list for removing a preset: every family task that came from it,
// all checked. Unchecking one keeps it. Tasks that were edited or handed to
// someone are listed like any other; nothing is removed without being shown.
export default function RemovePreset({ preset, tasks, onClose, onDone }) {
  const [picked, setPicked] = useState(() => new Set(tasks.map((t) => t.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { color, icon } = presetStyle(preset)

  const toggle = (id) => setPicked((s) => {
    const n = new Set(s)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })

  async function remove() {
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('delete_tasks', { p_tasks: [...picked] })
    setBusy(false)
    if (error) return setError(errorText(error))
    onDone()
  }

  const n = picked.size
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={`Remove ${preset.name}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 className="preset-head" style={{ color }}><Icon name={icon} size={20} color={color} /> Remove {preset.name}</h2>
          <button type="button" className="link" onClick={onClose}>Cancel</button>
        </div>
        <p className="muted">These tasks will be deleted. Uncheck any you want to keep. What's already been done stays in the history.</p>
        <ul className="remove-list">
          {tasks.map((t) => (
            <li key={t.id}>
              <label className="toggle">
                <input type="checkbox" checked={picked.has(t.id)} onChange={() => toggle(t.id)} />
                <span className="task-text">
                  <span className="task-title">{t.title}</span>
                  <span className="muted small">{describeSchedule(t)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {error && <p className="error">{error}</p>}
        <button className="danger-btn" disabled={busy || n === 0} onClick={remove}>
          {busy ? 'Removing…' : n === 0 ? 'Nothing selected' : `Delete ${n} ${n === 1 ? 'task' : 'tasks'}`}
        </button>
      </div>
    </div>
  )
}
