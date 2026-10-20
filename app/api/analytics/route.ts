import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/app/lib/supabase-admin';

export async function GET() {
  try {
    // Inventory with P&L
    const { data: inventoryData, error: invErr } = await supabaseAdmin
      .from('inventory')
      .select('status, purchase_price, total_cost, sold_price, net_profit, roi_pct, sport, grading_status, purchase_date, sold_date')
      .order('created_at', { ascending: false });

    if (invErr) throw invErr;

    const inventory = inventoryData || [];

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
      profit_by_sport: profitBySport,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
