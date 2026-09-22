// SUPABASE_LOCATION may hold the bare project ref ("xlgckbwcncwsvzfoxeiq") or
// the full project URL. Everything that needs the API URL goes through here so
// the two forms can never be handled differently.

export function supabaseUrl(location) {
  const v = (location ?? '').trim().replace(/\/+$/, '')
  if (/^[a-z0-9]{20}$/.test(v)) return `https://${v}.supabase.co`
  if (/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(v)) return v
  throw new Error('SUPABASE_LOCATION must be a project ref or https://<ref>.supabase.co')
}
