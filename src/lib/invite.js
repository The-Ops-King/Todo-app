// An invite link is https://todo.jtylerray.com/?invite=<token>. The token has
// to survive the sign-in round trip, so it is parked in sessionStorage and
// removed from the address bar right away.

const KEY = 'todo.invite'

export function captureInvite() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('invite')
  if (!token) return
  try {
    sessionStorage.setItem(KEY, token)
  } catch {
    // Private mode can block storage. The token then only lives for this page load.
    pendingInMemory = token
  }
  params.delete('invite')
  const rest = params.toString()
  window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''))
}

let pendingInMemory = null

export function pendingInvite() {
  try {
    return sessionStorage.getItem(KEY) || pendingInMemory
  } catch {
    return pendingInMemory
  }
}

export function clearInvite() {
  pendingInMemory = null
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // nothing stored
  }
}

export function inviteLink(token) {
  return `${window.location.origin}/?invite=${token}`
}
