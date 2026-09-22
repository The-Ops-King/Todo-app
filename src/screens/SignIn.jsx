import { useEffect, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { canPromptInstall, isStandalone, needsInstallFirst, onInstallAvailability, promptInstall } from '../lib/platform.js'

const RESEND_AFTER = 60 // seconds; Supabase refuses a second code sooner than this

export default function SignIn() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sentTo, setSentTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [wait, setWait] = useState(0)
  const [installable, setInstallable] = useState(canPromptInstall())

  useEffect(() => onInstallAvailability(setInstallable), [])

  useEffect(() => {
    if (wait <= 0) return
    const t = setTimeout(() => setWait(wait - 1), 1000)
    return () => clearTimeout(t)
  }, [wait])

  // A kid's phone gets an anonymous session straight away; the app then shows
  // the setup code screen for it.
  async function startKidSetup() {
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInAnonymously()
    setBusy(false)
    if (error) setError(/disabled/i.test(error.message)
      ? "Kid setup isn't switched on yet. A parent needs to turn on anonymous sign-ins in Supabase."
      : errorText(error))
  }

  async function sendCode(e) {
    e?.preventDefault()
    const address = email.trim().toLowerCase()
    if (!address) return
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email: address,
      options: { shouldCreateUser: true },
    })
    setBusy(false)
    if (error) return setError(errorText(error))
    setSentTo(address)
    setCode('')
    setWait(RESEND_AFTER)
  }

  async function verify(e) {
    e.preventDefault()
    const token = code.replace(/\D/g, '')
    if (token.length < 6) return setError('Enter the 6 digit code from the email.')
    setBusy(true)
    setError('')
    const { error } = await supabase.auth.verifyOtp({ email: sentTo, token, type: 'email' })
    setBusy(false)
    if (error) setError(/expired|invalid/i.test(error.message)
      ? 'That code is wrong or has expired. Check the latest email, or send a new code.'
      : errorText(error))
  }

  if (!sentTo) {
    return (
      <form className="card" onSubmit={sendCode}>
        <h1>Sign in</h1>
        <p className="muted">We'll email you a 6 digit code. No password needed.</p>
        <label>
          Email
          <input type="email" autoComplete="email" inputMode="email" required
            value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? 'Sending…' : 'Email me a code'}</button>
        {/* In Safari on iPhone a kid link would land in Safari, not the Home Screen app. */}
        {!needsInstallFirst() && (
          <button type="button" className="link" disabled={busy} onClick={startKidSetup}>
            Setting up a kid's phone?
          </button>
        )}
        {installable && !isStandalone() && (
          <button type="button" className="secondary" onClick={promptInstall}>Install the app</button>
        )}
      </form>
    )
  }

  return (
    <form className="card" onSubmit={verify}>
      <h1>Check your email</h1>
      <p className="muted">We sent a code to <strong>{sentTo}</strong>.</p>
      <label>
        Code
        <input className="code" autoComplete="one-time-code" inputMode="numeric" maxLength={8}
          value={code} onChange={(e) => setCode(e.target.value)} autoFocus />
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? 'Checking…' : 'Sign in'}</button>
      <div className="row">
        <button type="button" className="link" disabled={busy || wait > 0} onClick={sendCode}>
          {wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}
        </button>
        <button type="button" className="link" onClick={() => { setSentTo(''); setError('') }}>
          Use a different email
        </button>
      </div>
    </form>
  )
}
