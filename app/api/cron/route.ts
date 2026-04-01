import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase';

/**
 * Vercel Cron endpoint for automated maintenance tasks.
 * Configure in vercel.json:
 *   "crons": [{ "path": "/api/cron", "schedule": "0 *\/6 * * *" }]
 * 
 * This handles:
 * 1. Expire stale leads (>7 days old)
 * 2. Clean up old dismissed leads
 * 3. Update days_active on existing leads
 */
export async function GET(request: NextRequest) {
  // Verify cron secret (set CRON_SECRET in Vercel env vars)
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const results: Record<string, any> = {};

  try {
    // 1. Expire old leads
    const { data: expired } = await supabaseAdmin.rpc('dismiss_stale_leads', { days_old: 7 });
    results.expired_leads = expired;

    // 2. Delete dismissed leads older than 30 days
    const { count: deleted } = await supabaseAdmin
      .from('raw_leads')
      .delete({ count: 'exact' })
      .eq('status', 'dismissed')
      .lt('reviewed_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString());
    results.deleted_old_dismissed = deleted;

    // 3. Update days_active for all active leads
    const { data: activeLeads } = await supabaseAdmin
      .from('raw_leads')
      .select('id, listing_date')
      .in('status', ['new', 'reviewing']);

    if (activeLeads) {
      let updated = 0;
      for (const lead of activeLeads) {
        if (lead.listing_date) {
          const days = Math.floor(
            (Date.now() - new Date(lead.listing_date).getTime()) / (1000 * 60 * 60 * 24)
          );
          await supabaseAdmin
            .from('raw_leads')
            .update({ days_active: days })
            .eq('id', lead.id);
          updated++;
        }
      }
      results.days_updated = updated;
    }

    // 4. Get current stats for logging
    const { data: summary } = await supabaseAdmin.rpc('get_dashboard_summary');
    results.current_stats = summary;

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...results,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
