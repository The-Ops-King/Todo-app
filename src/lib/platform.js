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
