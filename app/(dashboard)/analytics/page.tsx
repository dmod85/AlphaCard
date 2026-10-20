'use client';

import { useState, useEffect } from 'react';

interface Analytics {
  pnl: {
    total_revenue: number;
    total_cost: number;
    total_profit: number;
    avg_roi: number;
    cards_sold: number;
    inventory_value: number;
    active_cards: number;
  };
  profit_by_sport: Record<string, { revenue: number; cost: number; profit: number; count: number }>;
}

export default function AnalyticsPage() {
  const [data, setData] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/analytics')
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="p-6 text-center text-gray-600 py-20">Loading analytics...</div>;
  }

  if (!data || !data.pnl) {
    return <div className="p-6 text-center text-gray-600 py-20">Failed to load analytics</div>;
  }

  const { pnl, profit_by_sport } = data;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Analytics</h2>
        <p className="text-sm text-gray-500 mt-1">
          Inventory and Sales Performance Metrics
        </p>
      </div>

      {/* P&L Overview */}
      <section>
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
          Profit & loss
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Total revenue" value={`$${pnl.total_revenue.toFixed(2)}`} />
          <MetricCard label="Total cost" value={`$${pnl.total_cost.toFixed(2)}`} />
          <MetricCard
            label="Net profit"
            value={`$${pnl.total_profit.toFixed(2)}`}
            color={pnl.total_profit >= 0 ? 'text-green-400' : 'text-red-400'}
          />
          <MetricCard label="Avg ROI" value={`${pnl.avg_roi}%`} />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-3">
          <MetricCard label="Cards sold" value={pnl.cards_sold} />
          <MetricCard label="Active inventory" value={`${pnl.active_cards} ($${pnl.inventory_value.toFixed(0)})`} />
        </div>
      </section>

      {/* Profit by Sport */}
      {profit_by_sport && Object.keys(profit_by_sport).length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
            Performance by Sport
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {Object.entries(profit_by_sport).map(([sport, stats]) => (
              <div key={sport} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
                <div className="text-sm font-medium text-white uppercase mb-2">
                  {sport}
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <div className="text-lg font-semibold text-white">{stats.count}</div>
                    <div className="text-[10px] text-gray-500">Sold</div>
                  </div>
                  <div>
                    <div className="text-lg font-semibold text-white">${stats.revenue.toFixed(0)}</div>
                    <div className="text-[10px] text-gray-500">Revenue</div>
                  </div>
                  <div>
                    <div className={`text-lg font-semibold ${stats.profit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      ${stats.profit.toFixed(0)}
                    </div>
                    <div className="text-[10px] text-gray-500">Profit</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function MetricCard({ label, value, color = 'text-white' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`text-lg font-semibold ${color} mt-0.5`}>{value}</div>
    </div>
  );
}
