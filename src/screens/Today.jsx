import { useCallback, useEffect, useMemo, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { addDays, dueLabel, todayIn } from '../lib/dates.js'
import { describeSchedule } from '../lib/schedule.js'
import TaskSheet from './TaskSheet.jsx'
import TaskForm from './TaskForm.jsx'
import { Avatar, PERSON_FIELDS } from '../lib/avatar.jsx'

const TASK_FIELDS = `id, title, notes, scope, owner_id, assign_mode, lead_days, buy_query, custom_link,
  schedule_kind, interval_unit, interval_count, cal_weekdays, cal_month_days, cal_months, active_months, miss_policy,
  subtasks (id, title, position), task_assignees (profile_id, position)`

export default function Today({ profile, onAddPresets }) {
  const [family, setFamily] = useState(null)
  const [members, setMembers] = useState([])
  const [open, setOpen] = useState([])
  const [checks, setChecks] = useState([])
  const [scope, setScope] = useState('mine')
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [selected, setSelected] = useState(null)
  const [adding, setAdding] = useState(false)
  const [undo, setUndo] = useState(null)

  const load = useCallback(async () => {
    setError('')
    // Rolls skip-if-missed chores forward and starts new rotation periods.
    // The scheduler does the same; this keeps the list right on open.
    await supabase.rpc('rollover')
    const [f, m, o] = await Promise.all([
      supabase.from('families').select('name, time_zone').single(),
      supabase.from('profiles').select(PERSON_FIELDS).order('created_at'),
      supabase.from('occurrences')
        .select(`id, due_on, responsible_id, task:tasks!inner (${TASK_FIELDS})`)
        .eq('status', 'open')
        .order('due_on'),
    ])
    const failed = f.error || m.error || o.error
    if (failed) {
      setError(errorText(failed))
      setLoaded(true)
      return
    }
    const ids = o.data.map((x) => x.id)
    const c = ids.length
      ? await supabase.from('subtask_checks').select('occurrence_id, subtask_id').in('occurrence_id', ids)
      : { data: [] }
    setFamily(f.data)
    setMembers(m.data)
    setOpen(o.data)
    setChecks(c.data || [])
    setLoaded(true)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Refresh when the app comes back to the foreground, so a chore someone
  // else checked off disappears without a manual reload.
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const names = useMemo(() => Object.fromEntries(members.map((m) => [m.id, m.display_name])), [members])
  const today = family ? todayIn(family.time_zone) : null

  // Mirrors todo.can_work so the button only shows where the database will
  // accept it. The database still decides.
  const canWork = useCallback((o) => {
    if (o.task.scope === 'personal') return true
    if (profile.role === 'admin') return true
    if (o.task.assign_mode === 'pool') return o.task.task_assignees.some((a) => a.profile_id === profile.id)
    return o.responsible_id === profile.id
  }, [profile.id, profile.role])

  const isMine = useCallback((o) => {
    if (o.task.scope === 'personal') return true
    if (o.task.assign_mode === 'pool') return o.task.task_assignees.some((a) => a.profile_id === profile.id)
    return o.responsible_id === profile.id
  }, [profile.id])

  const groups = useMemo(() => {
    if (!today) return null
    const visible = open.filter((o) => scope === 'everyone' || isMine(o))
    const g = { overdue: [], today: [], upcoming: [], later: [] }
    for (const o of visible) {
      if (o.due_on < today) g.overdue.push(o)
      else if (o.due_on === today) g.today.push(o)
      else if (o.due_on <= addDays(today, o.task.lead_days)) g.upcoming.push(o)
      else g.later.push(o)
    }
    return g
  }, [open, scope, today, isMine])

  async function complete(o) {
    setOpen((list) => list.filter((x) => x.id !== o.id))
    const { error } = await supabase.rpc('complete_occurrence', { p_occurrence: o.id })
    if (error) {
      setError(errorText(error))
      return load()
    }
    setUndo({ id: o.id, title: o.task.title })
    load()
  }

  async function undoLast() {
    const u = undo
    setUndo(null)
    const { error } = await supabase.rpc('undo_completion', { p_occurrence: u.id })
    if (error) setError(errorText(error))
    load()
  }

  useEffect(() => {
    if (!undo) return
    const t = setTimeout(() => setUndo(null), 8000)
    return () => clearTimeout(t)
  }, [undo])

  if (!loaded) return <p className="muted">Loading…</p>

  const empty = groups && !groups.overdue.length && !groups.today.length && !groups.upcoming.length
  const row = (o) => (
    <Row key={o.id} occ={o} today={today} names={names} me={profile.id} members={scope === 'everyone' ? members : null}
      checks={checks} canComplete={canWork(o)} onComplete={() => complete(o)} onOpen={() => setSelected(o)} />
  )

  return (
    <div className="stack today">
      <div className="today-head">
        <h1>Today</h1>
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={scope === 'mine'} onClick={() => setScope('mine')}>Mine</button>
          <button role="tab" aria-selected={scope === 'everyone'} onClick={() => setScope('everyone')}>Everyone</button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}

      {groups.overdue.length > 0 && <Section title="Overdue" tone="overdue">{groups.overdue.map(row)}</Section>}
      {groups.today.length > 0 && <Section title="Today">{groups.today.map(row)}</Section>}
      {empty && (
        <div className="empty">
          <p className="muted">{open.length ? 'Nothing due right now.' : 'No tasks yet.'}</p>
          {!open.length && onAddPresets && <button onClick={onAddPresets}>Pick from presets</button>}
          {!open.length && <p className="muted small">Or tap + to add one yourself.</p>}
        </div>
      )}
      {groups.upcoming.length > 0 && <Section title="Coming up">{groups.upcoming.map(row)}</Section>}
      {groups.later.length > 0 && <Later>{groups.later.map(row)}</Later>}

      <button className="fab" aria-label="Add a task" onClick={() => setAdding(true)}>+</button>

      {undo && (
        <div className="toast" role="status">
          <span>Done: {undo.title}</span>
          <button className="link" onClick={undoLast}>Undo</button>
        </div>
      )}

      {selected && (
        <TaskSheet occ={selected} profile={profile} members={members} today={today} canWork={canWork(selected)}
          checks={checks.filter((c) => c.occurrence_id === selected.id)}
          onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); load() }}
          onChecksChanged={load} />
      )}
      {adding && (
        <TaskForm profile={profile} members={members} today={today}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); load() }} />
      )}
    </div>
  )
}

function Section({ title, tone, children }) {
  return (
    <section className={`section ${tone || ''}`}>
      <h2>{title}</h2>
      <ul className="rows">{children}</ul>
    </section>
  )
}

function Later({ children }) {
  const [shown, setShown] = useState(false)
  return (
    <section className="section">
      <button className="link" onClick={() => setShown(!shown)}>
        {shown ? 'Hide later' : `Later (${children.length})`}
      </button>
      {shown && <ul className="rows">{children}</ul>}
    </section>
  )
}

function Row({ occ, today, names, me, members, checks, canComplete, onComplete, onOpen }) {
  const t = occ.task
  const subs = t.subtasks.length
  const done = checks.filter((c) => c.occurrence_id === occ.id).length
  const who = t.scope === 'personal'
    ? null
    : t.assign_mode === 'pool'
      ? t.task_assignees.map((a) => names[a.profile_id]).filter(Boolean).join(' or ')
      : occ.responsible_id === me ? 'You' : names[occ.responsible_id]
  const overdue = occ.due_on < today
  // Everyone view: who it's on, by icon. A pool shows each person who can do it.
  const faceIds = t.scope === 'personal' ? [t.owner_id]
    : t.assign_mode === 'pool' ? t.task_assignees.map((a) => a.profile_id) : [occ.responsible_id]
  const faces = members ? faceIds.map((id) => members.find((m) => m.id === id)).filter(Boolean) : []
  return (
    <li className="row">
      {canComplete
        ? <button className="check" aria-label={`Mark ${t.title} done`} onClick={onComplete} />
        : <span className="check locked" aria-hidden="true" />}
      <button className="row-body" onClick={onOpen}>
        <span className="row-title">{t.title}</span>
        <span className="row-meta">
          <span className={overdue ? 'overdue-text' : ''}>{dueLabel(occ.due_on, today)}</span>
          {who && <span>{who}</span>}
          {subs > 0 && <span>{done}/{subs}</span>}
          <span>{describeSchedule(t)}</span>
        </span>
      </button>
      {faces.length > 0 && (
        <button className="faces" aria-label={`${who || 'You'}. Open ${t.title}`} onClick={onOpen}>
          {faces.slice(0, 3).map((m) => <Avatar key={m.id} person={m} members={members} size={30} />)}
          {faces.length > 3 && <span className="faces-more">+{faces.length - 3}</span>}
        </button>
      )}
    </li>
  )
}
