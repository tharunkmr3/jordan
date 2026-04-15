import { createClient } from '@supabase/supabase-js'

// Admin client that bypasses Row Level Security (RLS).
// Only use this for server-side admin operations — never expose to the browser.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    }
  )
}
