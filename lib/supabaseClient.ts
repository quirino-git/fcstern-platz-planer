import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anon) {
  // This error will show in the browser console during dev if env vars are missing.
  // Keep it explicit to avoid silent failures.
  // eslint-disable-next-line no-console
  console.warn("Supabase env vars missing. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local");
}

export const supabase = createClient(url ?? "", anon ?? "");
