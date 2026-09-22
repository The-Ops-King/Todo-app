// Confirms the build can see the variables the app needs. Prints names only,
// never values. Vercel's project env API does not list linked shared
// variables, so the build log is where we confirm they reached this project.
// Production fails closed: a missing variable stops the deploy instead of
// shipping an app that cannot reach its database.

const REQUIRED = ['SUPABASE_LOCATION', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_DB_URL']
// Bypasses every access rule in the shared Supabase project. Nothing here
// needs it, so it should not be linked to this project at all.
const UNWANTED = ['SUPABASE_PRIVATE_KEY']

const env = process.env.VERCEL_ENV ?? 'local'
console.log(`[check-env] VERCEL_ENV=${env}`)

const missing = []
for (const k of REQUIRED) {
  const ok = !!process.env[k]
  console.log(`[check-env] ${ok ? 'present' : 'MISSING'}: ${k}`)
  if (!ok) missing.push(k)
}
for (const k of UNWANTED) {
  if (process.env[k]) console.log(`[check-env] WARNING ${k} is linked to this project and should not be`)
}

if (missing.length && env === 'production') {
  console.error(`[check-env] refusing a production build without: ${missing.join(', ')}`)
  process.exit(1)
}
