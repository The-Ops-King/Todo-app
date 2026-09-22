import { useState } from 'react'
import { chooseSafari, isIOSChrome } from '../lib/platform.js'
import { inviteLink, pendingInvite } from '../lib/invite.js'

// Shown in Safari on iPhone and iPad before anyone signs in. Safari and the
// Home Screen app do not share sign-ins, so setting up here would set up the
// wrong one.
export default function InstallGuide({ onContinueInSafari }) {
  const invite = pendingInvite()
  const [copied, setCopied] = useState(false)

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteLink(invite))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="card">
      <h1>Add To Do Dash to your Home Screen</h1>
      <p className="muted">It takes 10 seconds, and it's the only way reminders can reach this phone.</p>
      <ol className="steps">
        {invite && (
          <li>
            <span>Copy your invite first. You'll paste it in the app.</span>
            <button type="button" onClick={copyInvite}>{copied ? 'Copied' : 'Copy invite'}</button>
          </li>
        )}
        <li>
          {isIOSChrome()
            ? <span>Tap Share <ShareIcon /> at the top right of Chrome.</span>
            : <span>Tap Share <ShareIcon />. Don't see it? Tap <strong>···</strong> first.</span>}
        </li>
        <li>
          <span>Scroll down and tap <strong>Add to Home Screen</strong>, then <strong>Add</strong>.</span>
        </li>
        <li>
          <span>Open <strong>To Do Dash</strong> from your Home Screen and sign in there.</span>
        </li>
      </ol>
      <p className="muted small">Setting up a kid's phone? Do the same steps on their phone, then open the app from their Home Screen.</p>
      <button type="button" className="link" onClick={() => { chooseSafari(); onContinueInSafari() }}>
        I'm an adult and want to use it in the browser instead
      </button>
    </div>
  )
}

function ShareIcon() {
  return (
    <svg className="inline-icon" viewBox="0 0 24 24" aria-label="Share" role="img">
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
