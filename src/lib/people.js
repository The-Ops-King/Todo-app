// Buy links follow account type: never for kids, and for adults unless an
// admin has hidden them for that person. This is a display rule. The links
// themselves are not secret; the point is that a kid's screen never shows one.
export function showsBuyLinks(profile) {
  return Boolean(profile) && !profile.is_kid && !profile.hide_buy_links
}

export function formatSetupCode(code) {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : ''
}

/* global __AMAZON_TAG__ */
// A search link rather than a product link, because filters, blades and the
// like come in sizes the family sets on the task.
export function buyLink(query) {
  return `https://www.amazon.com/s?k=${encodeURIComponent(query)}&tag=${encodeURIComponent(__AMAZON_TAG__)}`
}
