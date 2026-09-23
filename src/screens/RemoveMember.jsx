import { useEffect, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { Avatar } from '../lib/avatar.jsx'
import { PeoplePicker } from '../components/Choice.jsx'

// What removing someone does to each of their tasks. Mirrors
// todo.detach_member; the database does the actual moving.
async function tasksOf(personId) {
  const { data, error } = await supabase.from('tasks')
    .select('id, title, assign_mode, task_assignees (profile_id), occurrences (responsible_id, status)')
    .eq('scope', 'family')
    .eq('occurrences.status', 'open')
    .order('title')
  if (error) throw error
  const solo = []
  const shared = []
  for (const t of data) {
    const people = t.task_assignees.map((a) => a.profile_id)
    const holds = t.occurrences.some((o) => o.responsible_id === personId)
    if (people.includes(personId)) (people.length === 1 ? solo : shared).push(t)
    else if (holds) solo.push(t)
  }
  return { solo, shared }
}

function TaskLists({ solo, shared, heirName }) {
  return (
    <>
      {solo.length > 0 && (
        <div className="choice">
          <span className="choice-label">Goes to {heirName}</span>
          <ul className="plain-list">{solo.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
        </div>
      )}
      {shared.length > 0 && (
        <div className="choice">
          <span className="choice-label">Shared, so the others keep it</span>
          <ul className="plain-list">{shared.map((t) => <li key={t.id}>{t.title}</li>)}</ul>
        </div>
      )}
    </>
  )
}

export function RemoveMember({ person, members, me, onClose, onDone }) {
  const [heir, setHeir] = useState(me)
  const [lists, setLists] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const others = members.filter((m) => m.id !== person.id)
  const heirName = heir === me ? 'you' : others.find((m) => m.id === heir)?.display_name

  useEffect(() => {
    tasksOf(person.id).then(setLists, (e) => setError(errorText(e)))
  }, [person.id])

  async function remove() {
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('remove_member', { p_profile: person.id, p_heir: heir })
    setBusy(false)
    if (error) return setError(errorText(error))
    onDone()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={`Remove ${person.display_name}`} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 className="inline"><Avatar person={person} members={members} size={32} /> Remove {person.display_name}?</h2>
          <button type="button" className="link" onClick={onClose}>Cancel</button>
        </div>
        <p className="muted">
          {person.is_kid
            ? `${person.display_name}'s phone will be signed out of the family. You can add them again later.`
            : `${person.display_name} can still sign in but won't see this family. You can invite them again later.`}
          {' '}What they've already done stays in the history with their name.
        </p>
        {!lists && !error && <p className="muted">Loading their tasks…</p>}
        {lists && lists.solo.length > 0 && (
          <PeoplePicker label="Who takes their tasks?" members={others} everyone={members} me={me} value={heir} onChange={setHeir} />
        )}
        {lists && <TaskLists {...lists} heirName={heirName} />}
        {lists && !lists.solo.length && !lists.shared.length && <p className="muted">They have no family tasks.</p>}
        {error && <p className="error">{error}</p>}
        <button className="danger-btn" disabled={busy || !lists} onClick={remove}>
          {busy ? 'Removing…' : `Remove ${person.display_name}`}
        </button>
      </div>
    </div>
  )
}

export function LeaveFamily({ profile, members, familyName, onClose, onLeft }) {
  const [lists, setLists] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Same pick as todo.leave_family: the longest-standing other admin.
  const heir = members.find((m) => m.role === 'admin' && m.id !== profile.id)

  useEffect(() => {
    tasksOf(profile.id).then(setLists, (e) => setError(errorText(e)))
  }, [profile.id])

  async function leave() {
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('leave_family')
    setBusy(false)
    if (error) return setError(errorText(error))
    onLeft()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Leave family" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Leave {familyName || 'this family'}?</h2>
          <button type="button" className="link" onClick={onClose}>Cancel</button>
        </div>
        {!heir ? (
          <p>You're the only admin. Make someone else an admin first, then you can leave.</p>
        ) : (
          <>
            <p className="muted">You'll stay signed in and can start or join another family. Your personal tasks are deleted.</p>
            {lists && <TaskLists {...lists} heirName={heir.display_name} />}
            {error && <p className="error">{error}</p>}
            <button className="danger-btn" disabled={busy || !lists} onClick={leave}>{busy ? 'Leaving…' : 'Leave family'}</button>
          </>
        )}
      </div>
    </div>
  )
}
