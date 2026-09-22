// On iPhone and iPad, Safari and an app added to the Home Screen keep separate
// storage. A sign-in, a kid link or an invite made in one is invisible to the
// other. So on iOS the app steers everyone into the installed app before any
// of that happens.

export function isIOS() {
  const ua = navigator.userAgent
  // iPadOS reports itself as a Mac; touch support gives it away.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

// True when this browser tab is not the place to sign in or set up.
export function needsInstallFirst() {
  return isIOS() && !isStandalone()
}

// Chrome on Android offers a one-tap install. The event arrives once, early,
// so it is captured at startup and replayed when the button is pressed.
let deferredPrompt = null
const listeners = new Set()

export function watchInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredPrompt = e
    listeners.forEach((fn) => fn(true))
  })
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null
    listeners.forEach((fn) => fn(false))
  })
}

export function canPromptInstall() {
  return deferredPrompt !== null
}

export function onInstallAvailability(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export async function promptInstall() {
  if (!deferredPrompt) return false
  deferredPrompt.prompt()
  const { outcome } = await deferredPrompt.userChoice
  deferredPrompt = null
  listeners.forEach((fn) => fn(false))
  return outcome === 'accepted'
}

const SAFARI_KEY = 'todo.stayInSafari'

export function chooseSafari() {
  try {
    sessionStorage.setItem(SAFARI_KEY, '1')
  } catch {
    // Private mode: the choice lasts until reload, which is fine.
  }
  stayInSafari = true
}

let stayInSafari = false

export function choseSafari() {
  if (stayInSafari) return true
  try {
    return sessionStorage.getItem(SAFARI_KEY) === '1'
  } catch {
    return false
  }
}

// Browsers built into other apps (Instagram, Facebook, Gmail's Google app,
// TikTok, Android WebViews) cannot add a site to the Home Screen or keep a
// reliable sign-in, so the app asks to be reopened in a real browser.
// Detection is by user agent. Apps that hide behind a plain Safari user agent
// cannot be detected, and that is acceptable: they are rare.
const IN_APP = /FBAN|FBAV|FB_IAB|FBIOS|Instagram|GSA\/|LinkedInApp|Snapchat|musical_ly|BytedanceWebview|TikTok|Pinterest|Twitter|Line\/|KAKAOTALK|MicroMessenger|; wv\)/

export function isInAppBrowser() {
  return IN_APP.test(navigator.userAgent)
}

export function isAndroid() {
  return /Android/.test(navigator.userAgent)
}

export function isIOSChrome() {
  return /CriOS/.test(navigator.userAgent)
}

// Links that hand the current page to a real browser. x-safari-https and
// googlechromes are iOS schemes; the intent URL is Android's way to open Chrome.
export function openInBrowserLinks(url) {
  const u = new URL(url)
  const rest = u.host + u.pathname + u.search
  if (isAndroid()) {
    return { chrome: `intent://${rest}#Intent;scheme=https;package=com.android.chrome;end` }
  }
  return { safari: `x-safari-https://${rest}`, chrome: `googlechromes://${rest}` }
}
