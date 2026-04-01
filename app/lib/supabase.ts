import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || supabaseAnonKey;

// Client-side (browser)
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-side (API routes, server components)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

export default supabase;
