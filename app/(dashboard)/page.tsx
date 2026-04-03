'use client';

import { useState, useEffect, useCallback } from 'react';
import type { Lead, DashboardStats, HunterSource, CardSport, SoldComp } from '@/app/types';
import RunnerPanel from './components/RunnerPanel';

const HUNTER_LABELS: Record<string, string> = {
  typo_hunter: 'Typo Hunter',
  holo_heuristic: 'Holo Engine',
  stale_sniper: 'Stale Sniper',
  manual: 'Manual',
};

const HUNTER_COLORS: Record<string, string> = {
  typo_hunter: '#378ADD',
  holo_heuristic: '#D4537E',
  stale_sniper: '#EF9F27',
  manual: '#888',
};

const TIER_LABELS: Record<string, string> = {
  ese: 'ESE $0.63',
  bmwt: 'BMWT $4.50',
  tracked: 'Tracked $8+',
};

export default function Dashboard() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [filter, setFilter] = useState<string>('all');
  const [sport, setSport] = useState<string>('all');
  const [sort, setSort] = useState<string>('confidence');
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams({ status: 'new', sort, limit: '50' });
      if (sport !== 'all') params.set('sport', sport);
      if (filter !== 'all') params.set('hunter', filter);
      const [leadsRes, statsRes] = await Promise.all([
        fetch(`/api/leads?${params}`),
        fetch('/api/leads/stats'),
      ]);
      const leadsData = await leadsRes.json();
      const statsData = await statsRes.json();
      setLeads(leadsData.leads || []);
      setStats(statsData);
    } catch (err) {
      console.error('Failed to fetch:', err);
    } finally {
      setLoading(false);
    }
  }, [sort, sport, filter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, [fetchData]);

  const updateLead = async (id: string, updates: Partial<Lead>) => {
    await fetch('/api/leads', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...updates }),
    });
    setLeads(prev => prev.filter(l => l.id !== id));
  };

  // Server handles sport/hunter filtering; client array is already filtered sdfsdj
  const filtered = leads;

  const totalProfit = filtered.reduce(
    (sum, l) => sum + Math.max(0, l.estimated_profit || 0), 0
  );

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6 font-sans">
      {/* Header */}
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            <span className="text-green-400">Alpha</span>Card
          </h1>
          <p className="text-gray-500 text-sm mt-1">Sourcing & Resale Engine</p>
        </div>
        <div className="flex gap-3 items-center">
          <div className="text-xs text-gray-600">
            {new Date().toLocaleTimeString()} · Auto-refreshing
          </div>
          <button
            onClick={fetchData}
            className="px-3 py-1.5 bg-gray-800 text-gray-300 rounded-lg text-sm hover:bg-gray-700 transition"
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Run Scan panel */}
      <RunnerPanel onComplete={fetchData} />

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <MetricCard label="Active leads" value={filtered.length} sub={`${leads.length} total`} />
        <MetricCard
          label="Potential profit"
          value={`$${Math.round(totalProfit)}`}
          valueColor="text-green-400"
          sub={`${filtered.filter(l => (l.estimated_profit || 0) > 0).length} profitable`}
        />
        <MetricCard
          label="Avg confidence"
          value={`${filtered.length ? Math.round(filtered.reduce((s, l) => s + l.confidence, 0) / filtered.length) : 0}%`}
          sub={`${filtered.filter(l => l.grade_candidate).length} grade candidates`}
        />
        <MetricCard
          label="Death zone"
          value={filtered.filter(l => l.death_zone).length}
          valueColor="text-red-400"
          sub="$20-$25 range"
        />
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-6 items-center">
        {['all', 'typo_hunter', 'holo_heuristic', 'stale_sniper'].map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition ${filter === f
              ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
              }`}
          >
            {f === 'all' ? 'All sources' : HUNTER_LABELS[f]}
          </button>
        ))}

        <select
          value={sport}
          onChange={e => setSport(e.target.value)}
          className="ml-auto bg-gray-800 text-gray-300 text-xs rounded-lg px-3 py-1.5 border-0"
        >
          <option value="all">All sports</option>
          <option value="nfl">NFL</option>
          <option value="nba">NBA</option>
          <option value="mlb">MLB</option>
          <option value="nhl">NHL</option>
        </select>

        <select
          value={sort}
          onChange={e => setSort(e.target.value)}
          className="bg-gray-800 text-gray-300 text-xs rounded-lg px-3 py-1.5 border-0"
        >
          <option value="confidence">Confidence</option>
          <option value="estimated_profit">Profit</option>
          <option value="roi_pct">ROI</option>
          <option value="discovered_at">Newest</option>
        </select>
      </div>

      {/* Lead Cards */}
      <div className="space-y-3">
        {loading ? (
          <div className="text-center py-12 text-gray-600">Loading leads...</div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12 text-gray-600">
            No leads match your filters. Run the hunters to find new opportunities.
          </div>
        ) : (
          filtered.map(lead => (
            <LeadCard
              key={lead.id}
              lead={lead}
              onDismiss={() => updateLead(lead.id, { status: 'dismissed' })}
              onPurchase={() => updateLead(lead.id, { status: 'purchased' })}
            />
          ))
        )}
      </div>
    </div>
  );
}

function MetricCard({
  label, value, valueColor = 'text-white', sub,
}: {
  label: string; value: string | number; valueColor?: string; sub?: string;
}) {
  return (
    <div className="bg-gray-900 rounded-xl p-4">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-semibold ${valueColor}`}>{value}</div>
      {sub && <div className="text-xs text-gray-600 mt-1">{sub}</div>}
    </div>
  );
}

function LeadCard({
  lead, onDismiss, onPurchase,
}: {
  lead: Lead; onDismiss: () => void; onPurchase: () => void;
}) {
  const profit = lead.estimated_profit || 0;
  const isProfit = profit >= 0;
  const [showComps, setShowComps] = useState(false);
  const [comps, setComps] = useState<SoldComp[] | null>(null);
  const [compsLoading, setCompsLoading] = useState(false);

  const fetchComps = async () => {
    if (comps !== null) { setShowComps(v => !v); return; }
    setCompsLoading(true);
    setShowComps(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/comps`);
      const data = await res.json();
      setComps(data.comps || []);
    } catch {
      setComps([]);
    } finally {
      setCompsLoading(false);
    }
  };

  const usedComps = comps?.filter(c => !c.is_outlier) ?? [];
  const median = usedComps.length
    ? (() => {
      const sorted = [...usedComps].sort((a, b) => a.sold_price - b.sold_price);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2
        ? sorted[mid].sold_price
        : (sorted[mid - 1].sold_price + sorted[mid].sold_price) / 2;
    })()
    : null;

  return (
    <div
      className={`bg-gray-900 rounded-xl p-4 border transition hover:border-gray-600 ${lead.death_zone
        ? 'border-l-4 border-l-red-500 border-gray-800'
        : lead.grade_candidate
          ? 'border-l-4 border-l-amber-500 border-gray-800'
          : 'border-gray-800'
        }`}
    >
      <div className="flex gap-4">
        {/* Card Image */}
        <div className="w-14 h-20 bg-gray-800 rounded-lg flex items-center justify-center text-gray-600 text-sm font-medium shrink-0 overflow-hidden">
          {lead.image_url ? (
            <img
              src={lead.image_url}
              alt={lead.title}
              className="w-full h-full object-cover"
              onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            (lead.player_name || '??')
              .split(' ')
              .map(w => w[0])
              .join('')
              .slice(0, 2)
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium leading-snug line-clamp-2">{lead.title}</h3>

          <div className="flex flex-wrap gap-1.5 mt-2">
            <span
              className="text-[10px] px-2 py-0.5 rounded-full font-medium"
              style={{
                backgroundColor: `${HUNTER_COLORS[lead.hunter_source]}22`,
                color: HUNTER_COLORS[lead.hunter_source],
              }}
            >
              {HUNTER_LABELS[lead.hunter_source]}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 font-medium">
              {lead.sport.toUpperCase()}
            </span>
            {lead.alpha_reason?.includes('broad scan') && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 font-medium">
                Broad
              </span>
            )}
            {lead.best_offer && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">
                Best Offer
              </span>
            )}
            {lead.death_zone && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/10 text-red-400 font-medium">
                Death Zone
              </span>
            )}
            {lead.grade_candidate && (
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">
                Grade Candidate
              </span>
            )}
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
              {TIER_LABELS[lead.shipping_tier]}
            </span>
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
              {lead.days_active}d active
            </span>
          </div>

          {lead.alpha_reason && (
            <p className="text-xs text-gray-500 mt-2 line-clamp-2 leading-relaxed">
              {lead.alpha_reason}
            </p>
          )}

          <div className="flex gap-2 mt-3">
            <a href={lead.item_url} target="_blank" rel="noopener noreferrer">
              <button className="text-xs px-3 py-1 rounded-lg bg-blue-500/20 text-blue-400 hover:bg-blue-500/30 transition">
                Open on eBay
              </button>
            </a>
            <button
              onClick={onPurchase}
              className="text-xs px-3 py-1 rounded-lg bg-green-500/20 text-green-400 hover:bg-green-500/30 transition"
            >
              Purchased
            </button>
            <button
              onClick={onDismiss}
              className="text-xs px-3 py-1 rounded-lg bg-gray-800 text-gray-400 hover:bg-gray-700 transition"
            >
              Dismiss
            </button>
            <button
              onClick={fetchComps}
              className="ml-auto text-xs px-3 py-1 rounded-lg bg-gray-800 text-gray-400 hover:bg-gray-700 transition"
            >
              {compsLoading
                ? 'Loading…'
                : comps !== null
                  ? `${showComps ? '▲' : '▼'} Comps (${usedComps.length})`
                  : `Comps (${lead.comp_count})`}
            </button>
          </div>

          {showComps && (
            <div className="mt-3 rounded-lg overflow-hidden border border-gray-800">
              {compsLoading ? (
                <div className="text-xs text-gray-500 px-3 py-2">Loading comp sales…</div>
              ) : comps && comps.length === 0 ? (
                <div className="text-xs text-gray-500 px-3 py-2">No comps in the last 60 days.</div>
              ) : (
                <>
                  {median !== null && (
                    <div className="flex justify-between items-center px-3 py-1.5 bg-gray-800/60 text-xs">
                      <span className="text-gray-400">
                        {usedComps.length} sales used · {comps!.length - usedComps.length} outliers removed
                      </span>
                      <span className="text-white font-medium">Median ${median.toFixed(2)}</span>
                    </div>
                  )}
                  <table className="w-full text-xs">
                    <tbody>
                      {comps!.map(comp => (
                        <tr
                          key={comp.id}
                          className={`border-t border-gray-800/60 ${comp.is_outlier ? 'opacity-40' : ''}`}
                        >
                          <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">
                            {new Date(comp.sold_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                          </td>
                          <td className="px-3 py-1.5 text-gray-300 max-w-0 w-full truncate">
                            {comp.item_url ? (
                              <a
                                href={comp.item_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="hover:text-blue-400 transition"
                              >
                                {comp.title}
                              </a>
                            ) : comp.title}
                          </td>
                          <td className="px-3 py-1.5 text-right whitespace-nowrap font-medium text-white">
                            ${comp.sold_price.toFixed(2)}
                          </td>
                          {comp.is_outlier && (
                            <td className="px-2 py-1.5 text-red-400 whitespace-nowrap" title={comp.outlier_reason ?? 'Outlier'}>
                              ✕
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>

        {/* Numbers */}
        <div className="text-right shrink-0 w-24">
          <div className="text-xs text-gray-500 flex justify-between">
            <span>Ask</span>
            <span className="text-gray-300">${lead.current_price.toFixed(2)}</span>
          </div>
          <div className="text-xs text-gray-500 flex justify-between mt-0.5">
            <span>Comp</span>
            <span className="text-gray-300">${(lead.median_comp || 0).toFixed(2)}</span>
          </div>
          <div className={`text-lg font-semibold mt-2 ${isProfit ? 'text-green-400' : 'text-red-400'}`}>
            ${profit.toFixed(2)}
          </div>
          <div className="text-xs text-gray-500">{(lead.roi_pct || 0).toFixed(0)}% ROI</div>

          <div className="h-1 bg-gray-800 rounded-full mt-2 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.min(lead.confidence, 100)}%`,
                backgroundColor:
                  lead.confidence > 70 ? '#1D9E75' : lead.confidence > 40 ? '#EF9F27' : '#E24B4A',
              }}
            />
          </div>
          <div className="text-[10px] text-gray-600 mt-0.5">{lead.confidence}% confidence</div>
        </div>
      </div>
    </div>
  );
}
