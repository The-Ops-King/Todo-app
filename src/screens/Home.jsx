import { useCallback, useEffect, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { inviteLink } from '../lib/invite.js'
import { formatSetupCode } from '../lib/people.js'

// The Family tab: members, kids, invites, buy link settings.
export default function Home({ profile, onAddPresets, onAssign }) {
  const [family, setFamily] = useState(null)
  const [members, setMembers] = useState([])
  const [error, setError] = useState('')
  const isAdmin = profile.role === 'admin'

  const load = useCallback(async () => {
    const [f, m] = await Promise.all([
      supabase.from('families').select('name').single(),
      supabase.from('profiles').select('id, display_name, role, is_kid, hide_buy_links').order('created_at'),
    ])
    if (f.error || m.error) return setError(errorText(f.error || m.error))
    setFamily(f.data)
    setMembers(m.data)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="stack">
      <section className="card">
        <h1>{family ? family.name : '…'}</h1>
        <p className="muted">Signed in as {profile.display_name}.</p>
        {error && <p className="error">{error}</p>}
        <ul className="members">
          {members.map((m) => (
            <Member key={m.id} member={m} self={m.id === profile.id} isAdmin={isAdmin} onChange={load} onAssign={onAssign} />
          ))}
        </ul>
      </section>
      {onAddPresets && (
        <section className="card">
          <h2>Presets</h2>
          <p className="muted">Ready-made upkeep lists for a home, car, pool, pets and more. Add another any time.</p>
          <button className="secondary" onClick={onAddPresets}>Add a preset</button>
        </section>
      )}
      {isAdmin && <AddKid onAdded={(kid) => { load(); onAssign?.(kid) }} />}
      {isAdmin && <Invite />}
      {/* Signing out on a kid's phone would unlink it; only a new setup code brings it back. */}
      {!profile.is_kid && <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>}
    </div>
  )
}

function Member({ member, self, isAdmin, onChange, onAssign }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function newCode() {
    setBusy(true)
    setError('')
    const { data, error } = await supabase.rpc('kid_setup_code', { p_profile: member.id })
    setBusy(false)
    if (error) return setError(errorText(error))
    setCode(data)
  }

  async function toggleLinks() {
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('set_buy_links_hidden', {
      p_profile: member.id,
      p_hidden: !member.hide_buy_links,
    })
    setBusy(false)
    if (error) return setError(errorText(error))
    onChange()
  }

  return (
    <li className="member">
      <div className="member-row">
        <span>{member.display_name}{self && ' (you)'}</span>
        {member.role === 'admin' && <span className="tag">admin</span>}
        {member.is_kid && <span className="tag">kid</span>}
      </div>
      {onAssign && !self && (
        <button className="link" onClick={() => onAssign(member)}>Assign tasks</button>
      )}
      {isAdmin && member.is_kid && (
        <button className="link" disabled={busy} onClick={newCode}>
          {code ? 'Make another code' : 'Set up a phone'}
        </button>
      )}
      {code && <SetupCode code={code} name={member.display_name} />}
      {isAdmin && !member.is_kid && (
        <label className="toggle">
          <input type="checkbox" checked={!member.hide_buy_links} disabled={busy} onChange={toggleLinks} />
          Show buy links
        </label>
      )}
      {error && <p className="error">{error}</p>}
    </li>
  )
}

function SetupCode({ code, name }) {
  return (
    <div className="setup-code">
      <p className="code-display">{formatSetupCode(code)}</p>
      <p className="muted">
        On {name}'s phone, open the app, tap "Setting up a kid's phone?" and type this code.
        It works once and expires in 15 minutes.
      </p>
    </div>
  )
}

function AddKid({ onAdded }) {
  const [name, setName] = useState('')
  const [added, setAdded] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function add(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { data: id, error } = await supabase.rpc('add_kid', { p_display_name: name.trim() })
    if (error) {
      setBusy(false)
      return setError(errorText(error))
    }
    const { data: code, error: codeError } = await supabase.rpc('kid_setup_code', { p_profile: id })
    setBusy(false)
    if (codeError) setError(errorText(codeError))
    setAdded({ name: name.trim(), code })
    setName('')
    onAdded({ id, display_name: name.trim() })
  }

  return (
    <form className="card" onSubmit={add}>
      <h2>Add a kid</h2>
      <p className="muted">
        Kids don't need an email. All we keep is their first name. Their phone stays signed in.
      </p>
      <label>
        First name
        <input required maxLength={40} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button disabled={busy}>{busy ? 'Adding…' : 'Add kid'}</button>
      {added?.code && <SetupCode code={added.code} name={added.name} />}
      {error && <p className="error">{error}</p>}
    </form>
  )
}

function Invite() {
  const [role, setRole] = useState('member')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  async function create() {
    setBusy(true)
    setError('')
    setCopied(false)
    const { data, error } = await supabase.rpc('create_invite', { p_role: role })
    setBusy(false)
    if (error) return setError(errorText(error))
    setLink(inviteLink(data))
  }

  async function share() {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Join our family on To Do Dash', url: link })
        return
      } catch {
        // Closing the share sheet is fine. Fall back to copying.
      }
    }
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch {
      setError('Could not copy. Press and hold the link to copy it.')
    }
  }

  return (
    <section className="card">
      <h2>Invite an adult</h2>
      <p className="muted">They sign in with their own email. Each link works once and expires in 7 days.</p>
      <label>
        They join as
        <select value={role} onChange={(e) => { setRole(e.target.value); setLink('') }}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      {!link && <button disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create invite link'}</button>}
      {link && (
        <>
          <p className="invite-link">{link}</p>
          <button onClick={share}>{copied ? 'Copied' : 'Share link'}</button>
          <button className="link" onClick={() => setLink('')}>Make another</button>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
