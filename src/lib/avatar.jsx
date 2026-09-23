import { useEffect, useReducer } from 'react'
import { supabase } from './supabase.js'

// People and the family get an emoji on a color; adults can use a photo
// instead. Anyone who hasn't picked yet gets their initial on a color chosen
// by join order, so a person looks the same everywhere.

export const PERSON_FIELDS = 'id, display_name, role, is_kid, icon_emoji, icon_color, photo_version'

export const ICON_COLORS = ['#2f6f4e', '#3a6ea5', '#b0643a', '#7a5aa6', '#a0474f', '#3f8a8a', '#8a7a2e', '#5b6b7a']

export const EMOJIS = [
  '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐸', '🐵', '🐶', '🐱', '🐰', '🐢',
  '🦄', '🐙', '🦖', '🐝', '🦋', '🐧', '🦉', '🐬', '🌻', '🌵', '🍀', '🌈',
  '⭐', '🔥', '⚡', '🌙', '🍕', '🍓', '🍩', '🎸', '⚽', '🏀', '🎨', '🚀',
  '🏡', '🏠', '🌳', '⛺', '🏖️', '❤️',
]

export function personColor(members, person) {
  if (person?.icon_color) return person.icon_color
  const i = members.findIndex((m) => m.id === person?.id)
  return ICON_COLORS[(i < 0 ? 0 : i) % ICON_COLORS.length]
}

// --- photos ------------------------------------------------------------------
// Fetched once for the whole family and kept for the session. photo_version
// on the profile says when a copy is stale.

const photos = new Map()
const listeners = new Set()
let inflight = null

const dataUrl = (b64) => `data:${b64.startsWith('/9j/') ? 'image/jpeg' : 'image/webp'};base64,${b64}`
const notify = () => listeners.forEach((l) => l())

function fetchPhotos() {
  if (!inflight) {
    inflight = supabase.rpc('family_photos').then(({ data }) => {
      for (const r of data || []) photos.set(r.profile_id, { version: r.version, url: dataUrl(r.data) })
      notify()
    }).finally(() => { inflight = null })
  }
  return inflight
}

export function rememberPhoto(id, version, b64) {
  if (version) photos.set(id, { version, url: dataUrl(b64) })
  else photos.delete(id)
  notify()
}

function usePhoto(person) {
  const [, rerender] = useReducer((x) => x + 1, 0)
  useEffect(() => {
    listeners.add(rerender)
    return () => listeners.delete(rerender)
  }, [])
  const want = person?.photo_version
  const have = person ? photos.get(person.id) : null
  useEffect(() => {
    if (want && (!have || have.version < want)) fetchPhotos()
  }, [want, have?.version])
  return want ? have?.url : null
}

// --- display -----------------------------------------------------------------

export function Avatar({ person, members = [], size = 28 }) {
  const url = usePhoto(person)
  const style = { width: size, height: size, fontSize: size * (person?.icon_emoji ? 0.55 : 0.45) }
  if (url) return <img className="avatar" src={url} alt="" style={style} />
  return (
    <span className="avatar" aria-hidden="true" style={{ ...style, background: personColor(members, person) }}>
      {person?.icon_emoji || (person?.display_name || '?').trim().charAt(0).toUpperCase()}
    </span>
  )
}

export function FamilyIcon({ family, size = 28 }) {
  const style = { width: size, height: size, fontSize: size * (family?.icon_emoji ? 0.55 : 0.45), background: family?.icon_color || ICON_COLORS[0] }
  return (
    <span className="avatar" aria-hidden="true" style={style}>
      {family?.icon_emoji || (family?.name || '?').trim().charAt(0).toUpperCase()}
    </span>
  )
}
