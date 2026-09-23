import { useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { clearInvite, parseInvite, pendingInvite } from '../lib/invite.js'

export default function Onboarding({ onDone, email }) {
  const [pasted, setPasted] = useState('')
  const invite = pendingInvite() || parseInvite(pasted)
  const [name, setName] = useState('')
  const [familyName, setFamilyName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ignoreInvite, setIgnoreInvite] = useState(false)
  const joining = invite && !ignoreInvite

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = joining
      ? await supabase.rpc('accept_invite', { p_token: invite, p_display_name: name.trim() })
      : await supabase.rpc('create_family', {
          p_family_name: familyName.trim(),
          p_display_name: name.trim(),
          p_time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        })
    setBusy(false)
    if (error) return setError(errorText(error))
    clearInvite()
    onDone(joining ? 'joined' : 'created')
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>{joining ? 'Join your family' : 'Set up your family'}</h1>
      <p className="muted">Signed in as {email}</p>
      <label>
        Your name
        <input required maxLength={40} autoComplete="given-name"
          value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {!joining && !pendingInvite() && (
        <label>
          Have an invite link? Paste it here
          <input autoComplete="off" spellCheck={false} placeholder="https://todo.jtylerray.com/?invite=…"
            value={pasted} onChange={(e) => setPasted(e.target.value)} />
        </label>
      )}
      {!joining && (
        <label>
          Or name your new family
          <input required maxLength={80} placeholder="The Rays"
            value={familyName} onChange={(e) => setFamilyName(e.target.value)} />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? 'Saving…' : joining ? 'Join' : 'Create family'}</button>
      <div className="row">
        {joining && (
          <button type="button" className="link" onClick={() => { setIgnoreInvite(true); setPasted(''); setError('') }}>
            Start a new family instead
          </button>
        )}
        <button type="button" className="link" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </form>
  )
}
