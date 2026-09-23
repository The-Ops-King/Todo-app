import { useRef, useState } from 'react'
import { errorText, supabase } from '../lib/supabase.js'
import { Avatar, EMOJIS, FamilyIcon, ICON_COLORS, personColor, rememberPhoto } from '../lib/avatar.jsx'
import { squarePhoto } from '../lib/photo.js'

// One sheet for a person's icon or the family's. `person` or `family` says
// which. Photos are offered only on your own adult profile; the database
// enforces the same.
export default function IconEditor({ person, family, members = [], self, onClose, onSaved }) {
  const subject = person || family
  const [emoji, setEmoji] = useState(subject.icon_emoji || null)
  const [color, setColor] = useState(subject.icon_color || (person ? personColor(members, person) : ICON_COLORS[0]))
  const [photoVersion, setPhotoVersion] = useState(person?.photo_version ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef(null)
  const canPhoto = Boolean(person && self && !person.is_kid)
  const preview = person
    ? { ...person, icon_emoji: emoji, icon_color: color, photo_version: photoVersion }
    : { ...family, icon_emoji: emoji, icon_color: color }

  async function pickPhoto(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const b64 = await squarePhoto(file)
      const { data: version, error } = await supabase.rpc('set_photo', { p_data: b64 })
      if (error) throw new Error(errorText(error))
      rememberPhoto(person.id, version, b64)
      setPhotoVersion(version)
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  async function removePhoto() {
    setBusy(true)
    setError('')
    const { error } = await supabase.rpc('clear_photo')
    setBusy(false)
    if (error) return setError(errorText(error))
    rememberPhoto(person.id, null)
    setPhotoVersion(null)
  }

  async function save() {
    setBusy(true)
    setError('')
    const { error } = person
      ? await supabase.rpc('set_icon', { p_profile: person.id, p_emoji: emoji, p_color: color })
      : await supabase.rpc('set_family_icon', { p_emoji: emoji, p_color: color })
    setBusy(false)
    if (error) return setError(errorText(error))
    onSaved()
  }

  const name = person ? (self ? 'Your icon' : `${person.display_name}'s icon`) : 'Family icon'
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={name} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{name}</h2>
          <button type="button" className="link" onClick={onClose}>Cancel</button>
        </div>

        <div className="icon-preview">
          {person ? <Avatar person={preview} members={members} size={88} /> : <FamilyIcon family={preview} size={88} />}
        </div>

        {canPhoto && (
          <div className="inline icon-photo">
            <button type="button" className="secondary" disabled={busy} onClick={() => fileRef.current?.click()}>
              {photoVersion ? 'Change photo' : 'Use a photo'}
            </button>
            {photoVersion && <button type="button" className="link danger" disabled={busy} onClick={removePhoto}>Remove photo</button>}
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickPhoto} />
          </div>
        )}
        {photoVersion
          ? <p className="muted small">Your photo shows instead of the emoji. Remove it to use the emoji.</p>
          : null}

        <div className="swatches" role="radiogroup" aria-label="Color">
          {ICON_COLORS.map((c) => (
            <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Color ${c}`}
              className="swatch" style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>

        <div className="emoji-grid" role="radiogroup" aria-label="Emoji">
          <button type="button" role="radio" aria-checked={!emoji} className="emoji letter" onClick={() => setEmoji(null)}>
            {(subject.display_name || subject.name || '?').trim().charAt(0).toUpperCase()}
          </button>
          {EMOJIS.map((e) => (
            <button key={e} type="button" role="radio" aria-checked={emoji === e} className="emoji" onClick={() => setEmoji(e)}>{e}</button>
          ))}
        </div>

        {error && <p className="error">{error}</p>}
        <button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}
