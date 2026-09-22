import { useState } from 'react'
import { isAndroid, openInBrowserLinks } from '../lib/platform.js'
import { inviteLink, pendingInvite } from '../lib/invite.js'

// Shown inside Instagram, Facebook, the Google app and similar. Those built-in
// browsers can't install the app, so everything starts over in a real one.
// The invite, if there is one, rides along in the link.
export default function OpenInBrowser() {
  const invite = pendingInvite()
  const url = invite ? inviteLink(invite) : window.location.origin + '/'
  const links = openInBrowserLinks(url)
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="card">
      <h1>Open this in {isAndroid() ? 'Chrome' : 'Safari or Chrome'}</h1>
      <p className="muted">
        You're in the browser built into another app. To Do Dash needs a real browser so it can be
        added to your Home Screen and stay signed in.
      </p>
      {links.safari && <a className="button" href={links.safari}>Open in Safari</a>}
      <a className={links.safari ? 'button secondary' : 'button'} href={links.chrome}>Open in Chrome</a>
      <p className="muted small">
        Nothing happens? Tap the <strong>···</strong> or share button in this app and choose
        <strong> Open in browser</strong>, or copy the link and paste it into {isAndroid() ? 'Chrome' : 'Safari'}.
      </p>
      <button type="button" className="secondary" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
    </div>
  )
}
