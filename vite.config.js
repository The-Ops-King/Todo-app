import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { supabaseUrl } from './scripts/lib/supabase-url.mjs'

// The browser gets the project URL and the publishable key, both public by
// design. Access control lives in Postgres row level security, not in keeping
// these hidden. Nothing else from the build environment reaches the bundle.
function publicEnv() {
  const location = process.env.SUPABASE_LOCATION
  return {
    url: location ? supabaseUrl(location) : '',
    key: process.env.SUPABASE_PUBLISHABLE_KEY ?? '',
  }
}

export default defineConfig(() => {
  const env = publicEnv()
  return {
    plugins: [react()],
    build: { target: 'es2020' },
    server: { port: 5173 },
    define: {
      __SUPABASE_URL__: JSON.stringify(env.url),
      __SUPABASE_KEY__: JSON.stringify(env.key),
    },
  }
})
