import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export async function GET() {
  try {
    // Parallel queries for speed
    const [leadsRes, runsRes, inventoryRes, hotRes] = await Promise.all([
      supabaseAdmin
        .from('raw_leads')
        .select('status, estimated_profit, hunter_source, sport, confidence, death_zone, grade_candidate'),
      supabaseAdmin
        .from('hunter_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(10),
      supabaseAdmin
        .from('v_inventory_summary')
        .select('*'),
      supabaseAdmin
        .from('v_hot_leads')
        .select('*')
        .limit(5),
    ]);

    const leads = leadsRes.data || [];
    const newLeads = leads.filter(l => l.status === 'new');

    // Aggregate stats
    const byHunter: Record<string, number> = {};
    const bySport: Record<string, number> = {};
    let totalProfit = 0;
    let totalConfidence = 0;
    let deathZoneCount = 0;
    let gradeCandidates = 0;

    for (const lead of newLeads) {
      byHunter[lead.hunter_source] = (byHunter[lead.hunter_source] || 0) + 1;
      bySport[lead.sport] = (bySport[lead.sport] || 0) + 1;
      totalProfit += parseFloat(lead.estimated_profit || '0');
      totalConfidence += parseFloat(lead.confidence || '0');
      if (lead.death_zone) deathZoneCount++;
      if (lead.grade_candidate) gradeCandidates++;
    }

    return NextResponse.json({
      total_leads: leads.length,
      new_leads: newLeads.length,
      total_potential_profit: Math.round(totalProfit * 100) / 100,
      avg_confidence: newLeads.length > 0
        ? Math.round((totalConfidence / newLeads.length) * 10) / 10
        : 0,
      death_zone_count: deathZoneCount,
      grade_candidates: gradeCandidates,
      leads_by_hunter: byHunter,
      leads_by_sport: bySport,
      recent_runs: runsRes.data || [],
      inventory_summary: inventoryRes.data || [],
      hot_leads: hotRes.data || [],
      dismissed: leads.filter(l => l.status === 'dismissed').length,
      purchased: leads.filter(l => l.status === 'purchased').length,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
