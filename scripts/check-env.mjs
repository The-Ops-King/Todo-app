// Prints which integration variables this build can see. Names only, never
// values. Vercel's project env API does not list linked shared variables, so
// the build log is the only place to confirm they reached this project.
//
// Report only for now. Once the variable names are confirmed this becomes a
// hard failure for the ones the app needs.

const PATTERN = /SUPABASE|POSTGRES|DATABASE|RESEND|MAIL|VAPID|AMAZON/i

const present = Object.keys(process.env).filter((k) => PATTERN.test(k)).sort()

console.log(`[check-env] VERCEL_ENV=${process.env.VERCEL_ENV ?? 'local'}`)
if (present.length === 0) {
  console.log('[check-env] no integration variables visible to this build')
} else {
  for (const k of present) {
    const empty = process.env[k] === '' ? ' (empty)' : ''
    console.log(`[check-env] present: ${k}${empty}`)
  }
}
