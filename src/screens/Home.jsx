import { useEffect, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { inviteLink } from '../lib/invite.js'

// Placeholder home until Today is built: family, members, invites.
export default function Home({ profile }) {
  const [family, setFamily] = useState(null)
  const [members, setMembers] = useState([])
  const [error, setError] = useState('')
  const isAdmin = profile.role === 'admin'

  useEffect(() => {
    Promise.all([
      supabase.from('families').select('name').single(),
      supabase.from('profiles').select('id, display_name, role').order('created_at'),
    ]).then(([f, m]) => {
      if (f.error || m.error) return setError(errorText(f.error || m.error))
      setFamily(f.data)
      setMembers(m.data)
    })
  }, [])

  return (
    <div className="stack">
      <section className="card">
        <h1>{family ? family.name : '…'}</h1>
        <p className="muted">Hi {profile.display_name}. Your to-do list is coming next.</p>
        {error && <p className="error">{error}</p>}
        <ul className="members">
          {members.map((m) => (
            <li key={m.id}>
              {m.display_name}
              {m.role === 'admin' && <span className="tag">admin</span>}
            </li>
          ))}
        </ul>
      </section>
      {isAdmin && <Invite />}
      <button className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
    </div>
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
      <h2>Invite someone</h2>
      <p className="muted">Each link works once and expires in 7 days.</p>
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
