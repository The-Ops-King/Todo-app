// A color and a simple line icon per preset, and a color per family member.
// Colors are chosen to sit next to the app green without fighting it, and
// each has enough contrast for white text.

const COLORS = ['#2f6f4e', '#3a6ea5', '#b0643a', '#7a5aa6', '#a0474f', '#3f8a8a', '#8a7a2e', '#5b6b7a']

const ICONS = {
  home: 'M3 11l9-7 9 7M5 10v10h14V10M10 20v-6h4v6',
  roof: 'M2 12l10-8 10 8M6 9V4h3v2.5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z',
  leaf: 'M5 19C5 10 10 5 20 4c-1 10-6 15-15 15zM5 19l8-8',
  sprout: 'M12 21v-9M12 12C12 8 9 6 5 6c0 4 3 6 7 6zM12 12c0-3 2-5 6-5 0 3-2 5-6 5z',
  wave: 'M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 20c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M8 11V5a2 2 0 014 0',
  bubbles: 'M8 14a3 3 0 100-6 3 3 0 000 6zM16 18a2 2 0 100-4 2 2 0 000 4zM15 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM3 21h18',
  pipe: 'M3 8h8v8h10M3 5v6M21 13v6',
  drop: 'M12 3s6 7 6 11a6 6 0 01-12 0c0-4 6-11 6-11z',
  flame: 'M12 21c4 0 7-3 7-7 0-5-5-7-5-11-3 2-5 5-5 8-1-1-2-2-2-4-2 2-2 4-2 7 0 4 3 7 7 7z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5',
  key: 'M14 10a4 4 0 11-8 0 4 4 0 018 0zM13 12l8 8M18 17l2-2M16 15l2-2',
  car: 'M3 16v-4l2-5h14l2 5v4M3 16h18M3 16v2h3v-2M18 16v2h3v-2M7 12h.01M17 12h.01',
  moto: 'M5 18a3 3 0 100-6 3 3 0 000 6zM19 18a3 3 0 100-6 3 3 0 000 6zM5 15h6l4-6h3M14 9l-2-3H9',
  bike: 'M5 18a3 3 0 100-6 3 3 0 000 6zM19 18a3 3 0 100-6 3 3 0 000 6zM5 15l4-7h6l4 7M9 8l3 7h2M14 5h2',
  boat: 'M3 16l2 4h14l2-4H3zM12 16V3l6 9h-6M12 6L7 12h5',
  van: 'M2 17V7h13l5 5v5H2zM15 7v5h5M6 20a2 2 0 100-4 2 2 0 000 4zM17 20a2 2 0 100-4 2 2 0 000 4z',
  paw: 'M12 20c-3 0-5-2-5-4s2-4 5-4 5 2 5 4-2 4-5 4zM6 11a2 2 0 100-4 2 2 0 000 4zM18 11a2 2 0 100-4 2 2 0 000 4zM9.5 7a2 2 0 100-4 2 2 0 000 4zM14.5 7a2 2 0 100-4 2 2 0 000 4z',
  cat: 'M5 20V9l-1-6 5 3h6l5-3-1 6v11H5zM9 13h.01M15 13h.01M10 17h4',
  fish: 'M2 12c3-5 9-7 14-4l5-3v14l-5-3c-5 3-11 1-14-4zM15 11h.01',
  egg: 'M12 21c4 0 7-3 7-7 0-5-3-11-7-11S5 9 5 14c0 4 3 7 7 7z',
  bottle: 'M10 2h4M10 2v3l-2 3v12a2 2 0 002 2h4a2 2 0 002-2V8l-2-3V2M8 12h8',
  backpack: 'M6 21V10a6 6 0 0112 0v11H6zM9 4a3 3 0 016 0M9 14h6v4H9z',
  broom: 'M14 3l-4 9M6 21l2-9h6l2 9M7 16h10',
  sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6zM19 17l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2z',
  heart: 'M12 20s-8-5-8-11a4.5 4.5 0 018-3 4.5 4.5 0 018 3c0 6-8 11-8 11z',
  dollar: 'M12 2v20M17 6H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6',
  laptop: 'M4 5h16v11H4zM2 19h20',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
}

const SLUG_ICON = {
  homeowner: 'home', 'home-exterior-and-roof': 'roof', 'home-safety': 'shield', 'lawn-and-yard': 'leaf',
  garden: 'sprout', pool: 'wave', 'hot-tub': 'bubbles', 'septic-system': 'pipe', 'well-water': 'drop',
  'fireplace-and-wood-stove': 'flame', generator: 'bolt', solar: 'sun', renter: 'key',
  car: 'car', motorcycle: 'moto', bicycle: 'bike', boat: 'boat', 'rv-camper': 'van',
  dog: 'paw', cat: 'cat', aquarium: 'fish', 'backyard-chickens': 'egg', 'baby-infant': 'bottle',
  'kids-and-school': 'backpack', 'household-chores': 'broom', 'deep-cleaning': 'sparkle',
  'personal-health': 'heart', 'finances-and-paperwork': 'dollar', tech: 'laptop',
}

export function presetStyle(preset) {
  if (!preset) return { color: '#6b6860', icon: 'list' }
  return { color: COLORS[(preset.position ?? 0) % COLORS.length], icon: SLUG_ICON[preset.slug] || 'list' }
}

export function Icon({ name, size = 22, color = 'currentColor' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] || ICONS.list} />
    </svg>
  )
}

const PEOPLE = ['#2f6f4e', '#3a6ea5', '#b0643a', '#7a5aa6', '#a0474f', '#3f8a8a', '#8a7a2e']

// Members arrive in created order, so a person keeps their color.
export function personColor(members, id) {
  const i = members.findIndex((m) => m.id === id)
  return PEOPLE[(i < 0 ? 0 : i) % PEOPLE.length]
}

export function Avatar({ name, color, size = 28 }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.45 }}>
      {(name || '?').trim().charAt(0).toUpperCase()}
    </span>
  )
}
