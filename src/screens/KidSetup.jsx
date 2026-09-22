import { useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'

// Runs on the kid's phone, which already holds an anonymous session. A parent
// makes a code on their own phone; typing it here links this device to the kid
// for good. No email, no password, no PIN. A typed code rather than a link,
// because on iPhone a link opens Safari and Safari does not share its sign-in
// with the Home Screen app.
export default function KidSetup({ onDone }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('claim_kid_setup', { p_code: code })
    setBusy(false)
    if (error) return setError(errorText(error))
    onDone()
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Set up this phone</h1>
      <p className="muted">Ask a parent for a setup code. They'll find it under Add a kid.</p>
      <label>
        Setup code
        <input className="code" autoCapitalize="characters" autoComplete="off" spellCheck={false}
          maxLength={9} placeholder="ABCD-EFGH"
          value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} autoFocus />
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy || code.replace(/[^A-Za-z0-9]/g, '').length < 8}>
        {busy ? 'Setting up…' : 'Set up'}
      </button>
      <button type="button" className="link" onClick={() => supabase.auth.signOut()}>
        This isn't a kid's phone
      </button>
    </form>
  )
}
