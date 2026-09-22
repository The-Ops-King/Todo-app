// Buy links follow account type: never for kids, and for adults unless an
// admin has hidden them for that person. This is a display rule. The links
// themselves are not secret; the point is that a kid's screen never shows one.
export function showsBuyLinks(profile) {
  return Boolean(profile) && !profile.is_kid && !profile.hide_buy_links
}

export function formatSetupCode(code) {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : ''
}
