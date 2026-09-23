import { useId } from 'react'
import { Avatar } from '../lib/avatar.jsx'

// Replacements for <select>, picked by what is being chosen:
//   Segmented   two to four short options
//   OptionList  options that need a sentence each
//   PeoplePicker  a person, shown by their icon
// All are radio groups, so screen readers and keyboards treat them as one.

export function Segmented({ label, value, options, onChange }) {
  const id = useId()
  return (
    <div className="choice">
      {label && <span className="choice-label" id={id}>{label}</span>}
      <div className="segmented wide" role="radiogroup" aria-labelledby={label ? id : undefined}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} onClick={() => onChange(v)}>{text}</button>
        ))}
      </div>
    </div>
  )
}

export function OptionList({ label, value, options, onChange }) {
  const id = useId()
  return (
    <div className="choice">
      {label && <span className="choice-label" id={id}>{label}</span>}
      <div className="option-list" role="radiogroup" aria-labelledby={label ? id : undefined}>
        {options.map(([v, title, detail]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className="option" onClick={() => onChange(v)}>
            <span className="option-dot" aria-hidden="true" />
            <span className="option-text">
              <span className="option-title">{title}</span>
              {detail && <span className="muted small">{detail}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

// `value` is one id, or an array when `multiple`. Numbered badges show order
// for multi-select, which is the rotation order.
// `everyone` is the whole family, so default colors stay put when `members`
// is a subset.
export function PeoplePicker({ label, members, everyone = members, value, onChange, multiple = false, me }) {
  const id = useId()
  const picked = multiple ? value : value ? [value] : []
  const tap = (pid) => {
    if (!multiple) return onChange(pid)
    onChange(picked.includes(pid) ? picked.filter((x) => x !== pid) : [...picked, pid])
  }
  return (
    <div className="choice">
      {label && <span className="choice-label" id={id}>{label}</span>}
      <div className="people" role={multiple ? 'group' : 'radiogroup'} aria-labelledby={label ? id : undefined}>
        {members.map((m) => {
          const on = picked.includes(m.id)
          return (
            <button key={m.id} type="button" className="person" role={multiple ? 'checkbox' : 'radio'}
              aria-checked={on} aria-pressed={on} onClick={() => tap(m.id)}>
              <Avatar person={m} members={everyone} size={40} />
              <span>{m.id === me ? 'You' : m.display_name}</span>
              {multiple && on && picked.length > 1 && <span className="person-order">{picked.indexOf(m.id) + 1}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
