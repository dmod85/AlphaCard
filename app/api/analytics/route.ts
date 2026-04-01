import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase';

export async function GET() {
  try {
    const [leadsRes, inventoryRes, runsRes, compsRes, hunterPerfRes] = await Promise.all([
      // All leads with timestamps for timeline
      supabaseAdmin
        .from('raw_leads')
        .select('status, estimated_profit, roi_pct, hunter_source, sport, confidence, current_price, median_comp, death_zone, grade_candidate, shipping_tier, discovered_at, reviewed_at')
        .order('discovered_at', { ascending: false })
        .limit(500),

      // Inventory with P&L
      supabaseAdmin
        .from('inventory')
        .select('status, purchase_price, total_cost, sold_price, net_profit, roi_pct, sport, grading_status, purchase_date, sold_date')
        .order('created_at', { ascending: false }),

      // Recent runs
      supabaseAdmin
        .from('hunter_runs')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(50),

      // Comp cache size
      supabaseAdmin
        .from('sold_comps')
        .select('id', { count: 'exact', head: true }),

      // Hunter performance view
      supabaseAdmin
        .from('v_hunter_performance')
        .select('*'),
    ]);

    const leads = leadsRes.data || [];
    const inventory = inventoryRes.data || [];
    const runs = runsRes.data || [];

    // Timeline: leads discovered per day (last 30 days)
    const timeline: Record<string, Record<string, number>> = {};
    leads.forEach(l => {
      const day = (l.discovered_at || '').slice(0, 10);
      if (!day) return;
      if (!timeline[day]) timeline[day] = { total: 0, purchased: 0, dismissed: 0 };
      timeline[day].total++;
      if (l.status === 'purchased') timeline[day].purchased++;
      if (l.status === 'dismissed') timeline[day].dismissed++;
    });

    // Conversion funnel
    const funnel = {
      discovered: leads.length,
      reviewed: leads.filter(l => l.reviewed_at).length,
      purchased: leads.filter(l => l.status === 'purchased').length,
      listed: inventory.filter(i => i.status === 'listed' || i.status === 'sold').length,
      sold: inventory.filter(i => i.status === 'sold').length,
    };

    // P&L summary
    const soldCards = inventory.filter(i => i.status === 'sold');
    const totalRevenue = soldCards.reduce((s, c) => s + parseFloat(c.sold_price || '0'), 0);
    const totalCost = soldCards.reduce((s, c) => s + parseFloat(c.total_cost || '0'), 0);
    const totalProfit = soldCards.reduce((s, c) => s + parseFloat(c.net_profit || '0'), 0);
    const avgROI = soldCards.length > 0
      ? soldCards.reduce((s, c) => s + parseFloat(c.roi_pct || '0'), 0) / soldCards.length
      : 0;

    // Current inventory value
    const activeInventory = inventory.filter(i => ['in_hand', 'listed', 'at_grader'].includes(i.status));
    const inventoryValue = activeInventory.reduce((s, c) => s + parseFloat(c.total_cost || '0'), 0);

    // Profit by sport
    const profitBySport: Record<string, { revenue: number; cost: number; profit: number; count: number }> = {};
    soldCards.forEach(c => {
      const sport = c.sport || 'other';
      if (!profitBySport[sport]) profitBySport[sport] = { revenue: 0, cost: 0, profit: 0, count: 0 };
      profitBySport[sport].revenue += parseFloat(c.sold_price || '0');
      profitBySport[sport].cost += parseFloat(c.total_cost || '0');
      profitBySport[sport].profit += parseFloat(c.net_profit || '0');
      profitBySport[sport].count++;
    });

    // Hunter efficiency
    const hunterEfficiency: Record<string, { leads: number; purchased: number; conversion: number }> = {};
    ['typo_hunter', 'holo_heuristic', 'stale_sniper'].forEach(h => {
      const hLeads = leads.filter(l => l.hunter_source === h);
      const hPurchased = hLeads.filter(l => l.status === 'purchased');
      hunterEfficiency[h] = {
        leads: hLeads.length,
        purchased: hPurchased.length,
        conversion: hLeads.length > 0 ? Math.round((hPurchased.length / hLeads.length) * 100) : 0,
      };
    });

    // Shipping tier distribution
    const shippingDist: Record<string, number> = {};
    leads.filter(l => l.status === 'new' || l.status === 'purchased').forEach(l => {
      shippingDist[l.shipping_tier] = (shippingDist[l.shipping_tier] || 0) + 1;
    });

    // Confidence distribution (buckets of 10)
    const confDist: Record<string, number> = {};
    leads.forEach(l => {
      const bucket = `${Math.floor(l.confidence / 10) * 10}-${Math.floor(l.confidence / 10) * 10 + 9}`;
      confDist[bucket] = (confDist[bucket] || 0) + 1;
    });

    return NextResponse.json({
      pnl: {
        total_revenue: Math.round(totalRevenue * 100) / 100,
        total_cost: Math.round(totalCost * 100) / 100,
        total_profit: Math.round(totalProfit * 100) / 100,
        avg_roi: Math.round(avgROI * 10) / 10,
        cards_sold: soldCards.length,
        inventory_value: Math.round(inventoryValue * 100) / 100,
        active_cards: activeInventory.length,
      },
      funnel,
      timeline,
      profit_by_sport: profitBySport,
      hunter_efficiency: hunterEfficiency,
      hunter_performance: hunterPerfRes.data || [],
      shipping_distribution: shippingDist,
      confidence_distribution: confDist,
      comp_cache_size: compsRes.count || 0,
      recent_runs: runs.slice(0, 10),
      total_runs: runs.length,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
