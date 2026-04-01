'use client';

import { useState, useEffect } from 'react';

const HUNTER_LABELS: Record<string, string> = {
  typo_hunter: 'Typo Hunter',
  holo_heuristic: 'Holo Engine',
  stale_sniper: 'Stale Sniper',
};

const HUNTER_COLORS: Record<string, string> = {
  typo_hunter: '#378ADD',
  holo_heuristic: '#D4537E',
  stale_sniper: '#EF9F27',
};

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
  funnel: {
    discovered: number;
    reviewed: number;
    purchased: number;
    listed: number;
    sold: number;
  };
  hunter_efficiency: Record<string, { leads: number; purchased: number; conversion: number }>;
  hunter_performance: Array<{
    hunter_type: string;
    total_runs: number;
    total_leads: number;
    total_scanned: number;
    avg_leads_per_run: number;
    last_run: string;
  }>;
  shipping_distribution: Record<string, number>;
  confidence_distribution: Record<string, number>;
  comp_cache_size: number;
  recent_runs: Array<{
    id: string;
    hunter_type: string;
    started_at: string;
    finished_at: string | null;
    leads_found: number;
    items_scanned: number;
    errors: number;
    status: string;
  }>;
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

  if (!data) {
    return <div className="p-6 text-center text-gray-600 py-20">Failed to load analytics</div>;
  }

  const { pnl, funnel, hunter_efficiency, hunter_performance, recent_runs } = data;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white">Analytics</h2>
        <p className="text-sm text-gray-500 mt-1">
          Performance metrics and hunter efficiency
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
        <div className="grid grid-cols-3 gap-3 mt-3">
          <MetricCard label="Cards sold" value={pnl.cards_sold} />
          <MetricCard label="Active inventory" value={`${pnl.active_cards} ($${pnl.inventory_value.toFixed(0)})`} />
          <MetricCard label="Comp cache" value={`${data.comp_cache_size} records`} />
        </div>
      </section>

      {/* Conversion Funnel */}
      <section>
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
          Conversion funnel
        </h3>
        <div className="bg-gray-900 rounded-xl p-5 border border-gray-800">
          <div className="flex items-end gap-1">
            {Object.entries(funnel).map(([stage, count], i, arr) => {
              const maxCount = Math.max(...Object.values(funnel));
              const height = maxCount > 0 ? Math.max((count / maxCount) * 140, 20) : 20;
              const pct = i > 0 && arr[i - 1][1] > 0
                ? Math.round((count / arr[i - 1][1]) * 100)
                : 100;
              const colors = ['bg-blue-500', 'bg-cyan-500', 'bg-green-500', 'bg-amber-500', 'bg-green-400'];
              return (
                <div key={stage} className="flex-1 flex flex-col items-center gap-2">
                  <span className="text-xs text-gray-400">{count}</span>
                  <div
                    className={`w-full ${colors[i]} rounded-t-lg transition-all`}
                    style={{ height: `${height}px`, opacity: 0.7 + (i * 0.06) }}
                  />
                  <span className="text-[10px] text-gray-500 capitalize">{stage}</span>
                  {i > 0 && (
                    <span className="text-[9px] text-gray-600">{pct}%</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* Hunter Efficiency */}
      <section>
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
          Hunter efficiency
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {Object.entries(hunter_efficiency).map(([hunter, stats]) => (
            <div key={hunter} className="bg-gray-900 rounded-xl p-4 border border-gray-800">
              <div className="flex items-center gap-2 mb-3">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: HUNTER_COLORS[hunter] }}
                />
                <span className="text-sm font-medium text-white">
                  {HUNTER_LABELS[hunter] || hunter}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <div className="text-lg font-semibold text-white">{stats.leads}</div>
                  <div className="text-[10px] text-gray-500">Leads found</div>
                </div>
                <div>
                  <div className="text-lg font-semibold text-white">{stats.purchased}</div>
                  <div className="text-[10px] text-gray-500">Purchased</div>
                </div>
                <div>
                  <div className="text-lg font-semibold text-white">{stats.conversion}%</div>
                  <div className="text-[10px] text-gray-500">Conversion</div>
                </div>
              </div>
              {/* Conversion bar */}
              <div className="h-1.5 bg-gray-800 rounded-full mt-3 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{
                    width: `${stats.conversion}%`,
                    backgroundColor: HUNTER_COLORS[hunter],
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Hunter Run Performance */}
      {hunter_performance.length > 0 && (
        <section>
          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
            Run performance
          </h3>
          <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-800">
                  <th className="text-left p-3 text-xs text-gray-500 font-medium">Hunter</th>
                  <th className="text-right p-3 text-xs text-gray-500 font-medium">Runs</th>
                  <th className="text-right p-3 text-xs text-gray-500 font-medium">Total leads</th>
                  <th className="text-right p-3 text-xs text-gray-500 font-medium">Items scanned</th>
                  <th className="text-right p-3 text-xs text-gray-500 font-medium">Avg/run</th>
                  <th className="text-right p-3 text-xs text-gray-500 font-medium">Last run</th>
                </tr>
              </thead>
              <tbody>
                {hunter_performance.map(hp => (
                  <tr key={hp.hunter_type} className="border-b border-gray-800/50">
                    <td className="p-3 flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: HUNTER_COLORS[hp.hunter_type] }}
                      />
                      <span className="text-white text-xs">{HUNTER_LABELS[hp.hunter_type]}</span>
                    </td>
                    <td className="p-3 text-right text-xs text-gray-300">{hp.total_runs}</td>
                    <td className="p-3 text-right text-xs text-gray-300">{hp.total_leads}</td>
                    <td className="p-3 text-right text-xs text-gray-300">{hp.total_scanned.toLocaleString()}</td>
                    <td className="p-3 text-right text-xs text-gray-300">{hp.avg_leads_per_run}</td>
                    <td className="p-3 text-right text-xs text-gray-500">
                      {hp.last_run ? new Date(hp.last_run).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Recent Runs Log */}
      <section>
        <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-3">
          Recent scan runs
        </h3>
        <div className="space-y-1.5">
          {recent_runs.map(run => {
            const duration = run.finished_at
              ? Math.round((new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()) / 1000)
              : null;
            return (
              <div key={run.id} className="bg-gray-900 rounded-lg p-3 flex items-center gap-3 border border-gray-800/50">
                <div
                  className="w-2 h-2 rounded-full"
                  style={{
                    backgroundColor: run.status === 'running'
                      ? '#3B82F6'
                      : run.status === 'completed'
                      ? '#22C55E'
                      : '#EF4444',
                  }}
                />
                <span className="text-xs text-white flex-1">
                  {HUNTER_LABELS[run.hunter_type] || run.hunter_type}
                </span>
                <span className="text-[10px] text-gray-500">{run.leads_found} leads</span>
                <span className="text-[10px] text-gray-600">{run.items_scanned} scanned</span>
                {run.errors > 0 && (
                  <span className="text-[10px] text-red-400">{run.errors} errors</span>
                )}
                {duration !== null && (
                  <span className="text-[10px] text-gray-600">{duration}s</span>
                )}
                <span className="text-[10px] text-gray-600">
                  {new Date(run.started_at).toLocaleString()}
                </span>
              </div>
            );
          })}
          {recent_runs.length === 0 && (
            <div className="text-center py-8 text-gray-600 text-sm">
              No scan runs yet. Start the Python hunter orchestrator to begin.
            </div>
          )}
        </div>
      </section>
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
