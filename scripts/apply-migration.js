/**
 * apply-migration.js
 * Applies the purchases/sales migration using the Supabase service key.
 * Run once: node scripts/apply-migration.js
 */

const fs = require('fs');
const path = require('path');

// Load .env.local manually
const envPath = path.join(__dirname, '..', '.env.local');
const envContent = fs.readFileSync(envPath, 'utf8');
envContent.split('\n').forEach(line => {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) {
    process.env[key.trim()] = rest.join('=').trim().replace(/\r$/, '');
  }
});

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const sql = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260721_purchases_sales.sql'),
  'utf8'
);

async function run() {
  console.log('Applying migration...');
  
  // Split on semicolons to run statement by statement
  const statements = sql
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 10 && !s.startsWith('--'));

  let ok = 0;
  let errs = 0;

  for (const stmt of statements) {
    const full = stmt + ';';
    // Use the REST /sql endpoint via fetch
    const res = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/`, {
      method: 'HEAD',
    });
  }

  // Use supabase-js rpc to run raw SQL — requires pg_execute or similar
  // Instead, use the supabase management REST API
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)/)?.[1];
  if (!projectRef) { console.error('Cannot extract project ref from URL'); process.exit(1); }

  console.log(`Project ref: ${projectRef}`);
  console.log('NOTE: The Management API requires a personal access token (SUPABASE_ACCESS_TOKEN).');
  console.log('');
  console.log('Please run this SQL manually in your Supabase dashboard:');
  console.log('  https://supabase.com/dashboard/project/' + projectRef + '/sql/new');
  console.log('');
  console.log('Copy/paste the file: supabase/migrations/20260721_purchases_sales.sql');
}

run();
