import { useCallback, useEffect, useState } from 'react'
import { configured, supabase } from './lib/supabase.js'
import SignIn from './screens/SignIn.jsx'
import Onboarding from './screens/Onboarding.jsx'
import Home from './screens/Home.jsx'
import Today from './screens/Today.jsx'
import KidSetup from './screens/KidSetup.jsx'
import InstallGuide from './screens/InstallGuide.jsx'
import OpenInBrowser from './screens/OpenInBrowser.jsx'
import { choseSafari, isInAppBrowser, needsInstallFirst } from './lib/platform.js'

// signed out -> SignIn; signed in without a To Do Dash profile -> Onboarding
// (email accounts) or KidSetup (kid devices, which hold an anonymous session);
// otherwise Home. The shared Supabase project means a signed-in person may
// exist in auth without belonging to this app, so the profile row decides.
export default function App() {
  const [session, setSession] = useState(undefined)
  const [profile, setProfile] = useState(undefined)
  const [loadError, setLoadError] = useState('')
  const [inSafari, setInSafari] = useState(choseSafari())

  useEffect(() => {
    if (!configured) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const loadProfile = useCallback(async () => {
    if (!session) {
      setProfile(undefined)
      return
    }
    setLoadError('')
    const { data, error } = await supabase
      .from('profiles')
      .select('id, family_id, display_name, role, is_kid, hide_buy_links')
      .eq('user_id', session.user.id)
      .maybeSingle()
    if (error) setLoadError(error.message)
    else setProfile(data)
  }, [session])

  useEffect(() => {
    loadProfile()
  }, [loadProfile])

  if (!configured) {
    return <Shell><p className="error">This build is missing its Supabase settings.</p></Shell>
  }
  if (session === undefined) return <Shell><p className="muted">Loading…</p></Shell>
  if (!session) {
    if (isInAppBrowser()) return <Shell><OpenInBrowser /></Shell>
    if (needsInstallFirst() && !inSafari) {
      return <Shell><InstallGuide onContinueInSafari={() => setInSafari(true)} /></Shell>
    }
    return <Shell><SignIn /></Shell>
  }
  if (loadError) {
    return (
      <Shell>
        <p className="error">Could not load your account: {loadError}</p>
        <button onClick={loadProfile}>Try again</button>
      </Shell>
    )
  }
  if (profile === undefined) return <Shell><p className="muted">Loading…</p></Shell>
  if (profile === null) {
    return session.user.is_anonymous
      ? <Shell><KidSetup onDone={loadProfile} /></Shell>
      : <Shell><Onboarding onDone={loadProfile} email={session.user.email} /></Shell>
  }
  return <Main profile={profile} />
}

function Main({ profile }) {
  const [tab, setTab] = useState('today')
  return (
    <div className="shell with-tabs">
      <main>{tab === 'today' ? <Today profile={profile} /> : <Home profile={profile} />}</main>
      <nav className="tabs">
        <button aria-current={tab === 'today'} onClick={() => setTab('today')}>Today</button>
        <button aria-current={tab === 'family'} onClick={() => setTab('family')}>Family</button>
      </nav>
    </div>
  )
}

function Shell({ children }) {
  return (
    <div className="shell">
      <header className="brand">To Do Dash</header>
      <main>{children}</main>
    </div>
  )
}
