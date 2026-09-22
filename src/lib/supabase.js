import { createClient } from '@supabase/supabase-js'

/* global __SUPABASE_URL__, __SUPABASE_KEY__ */
export const configured = Boolean(__SUPABASE_URL__ && __SUPABASE_KEY__)

// Every table and function this app uses lives in the `todo` schema.
export const supabase = configured
  ? createClient(__SUPABASE_URL__, __SUPABASE_KEY__, {
      db: { schema: 'todo' },
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
  : null

// Postgres errors raised by todo.* functions are written for people, so they
// can be shown as they are. Anything else gets a generic line.
export function errorText(err) {
  if (!err) return ''
  const msg = err.message || String(err)
  if (/fetch|network/i.test(msg)) return 'Could not reach the server. Check your connection and try again.'
  return msg.charAt(0).toUpperCase() + msg.slice(1)
}
