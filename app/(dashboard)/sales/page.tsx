'use client';

import { useState, useEffect, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Sale {
  id: string;
  order_number: string;
  item_title: string;
  sku: string | null;
  sold_for: number;
  sale_date: string | null;
  ebay_item_id: string | null;
  buyer: string | null;
  quantity_sold: number;
  synced_at: string;
}

interface Purchase {
  sku: string | null;
  brand: string | null;
  series: string | null;
  sport: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [search, setSearch] = useState('');
  const [days, setDays] = useState(90);
  const [lastSync, setLastSync] = useState<string | null>(null);

  // Build a SKU -> purchase lookup for the match column
  const skuMap = new Map<string, Purchase>();
  purchases.forEach(p => { if (p.sku) skuMap.set(p.sku, p); });

  // Load sales from DB (no eBay sync)
  const loadFromDb = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ebay/sold-orders?sync=false');
      const data = await res.json();
      setSales(data.sales ?? []);
      if (data.sales?.length > 0) {
        setLastSync(data.sales[0].synced_at);
      }
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  // Load purchases for match column
  const loadPurchases = useCallback(async () => {
    try {
      const res = await fetch('/api/purchases');
      const data = await res.json();
      setPurchases(data.purchases ?? []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    loadFromDb();
    loadPurchases();
  }, [loadFromDb, loadPurchases]);

  // Sync from eBay
  async function handleSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await fetch(`/api/ebay/sold-orders?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSales(data.sales ?? []);
      setSyncMsg(`✓ Synced ${data.synced} new orders from the last ${days} days.`);
      setLastSync(new Date().toISOString());
    } catch (e: any) {
      setSyncMsg(`✗ Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  }

  // Filter
  const filtered = sales.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.item_title.toLowerCase().includes(q) ||
      (s.sku ?? '').toLowerCase().includes(q) ||
      s.order_number.toLowerCase().includes(q) ||
      (s.buyer ?? '').toLowerCase().includes(q)
    );
  });

  // Stats
  const totalRevenue = filtered.reduce((s, r) => s + r.sold_for, 0);
  const avgSale = filtered.length ? totalRevenue / filtered.length : 0;
  const matched = filtered.filter(s => s.sku && skuMap.has(s.sku)).length;

  return (
    <div className="h-full flex flex-col bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="flex-none border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-white">eBay Sales</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Auto-synced from eBay completed orders
              {lastSync && (
                <span className="ml-2 text-gray-600">· Last sync: {fmtDate(lastSync)}</span>
              )}
            </p>
          </div>

          {/* Sync controls */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5">
              <span className="text-xs text-gray-500">Days back:</span>
              <select
                className="bg-transparent text-sm text-gray-200 focus:outline-none"
                value={days}
                onChange={e => setDays(parseInt(e.target.value))}
              >
                {[7, 14, 30, 60, 90].map(d => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
            <button
              onClick={handleSync}
              disabled={syncing}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
            >
              {syncing ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Syncing…
                </>
              ) : (
                <>🔄 Sync from eBay</>
              )}
            </button>
          </div>
        </div>

        {syncMsg && (
          <div className={`mb-3 px-4 py-2 rounded-lg text-sm ${syncMsg.startsWith('✓') ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
            {syncMsg}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          {[
            { label: 'Total Revenue', value: fmt$(totalRevenue), color: 'text-green-400' },
            { label: 'Sales', value: filtered.length.toString(), color: 'text-blue-400' },
            { label: 'Avg Sale', value: fmt$(avgSale), color: 'text-yellow-400' },
            { label: 'Matched to Purchase', value: `${matched} / ${filtered.length}`, color: 'text-purple-400' },
          ].map(s => (
            <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
              <p className="text-[11px] text-gray-500 uppercase tracking-wider">{s.label}</p>
              <p className={`text-xl font-bold mt-0.5 ${s.color}`}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">🔍</span>
          <input
            type="text"
            className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-9 pr-4 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500 transition"
            placeholder="Search by title, SKU, order #, buyer…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-500 text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-500 gap-2">
            <p className="text-4xl">💰</p>
            <p className="text-sm">
              {sales.length === 0
                ? 'No sales yet — click Sync to pull from eBay.'
                : 'No sales match your search.'}
            </p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-gray-900/95 backdrop-blur z-10">
              <tr className="text-[11px] text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-4 py-3">Order #</th>
                <th className="px-3 py-3">Sale Date</th>
                <th className="px-3 py-3">Item Title</th>
                <th className="px-3 py-3">SKU</th>
                <th className="px-3 py-3">Matched Purchase</th>
                <th className="px-3 py-3">Qty</th>
                <th className="px-3 py-3">Sold For</th>
                <th className="px-3 py-3">Buyer</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(sale => {
                const match = sale.sku ? skuMap.get(sale.sku) : null;
                return (
                  <tr
                    key={sale.id}
                    className="border-b border-gray-800/60 hover:bg-gray-800/25 transition"
                  >
                    <td className="px-4 py-3 text-xs text-gray-400 font-mono whitespace-nowrap">
                      {sale.order_number}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-400 whitespace-nowrap">
                      {fmtDate(sale.sale_date)}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-200 max-w-xs">
                      <span className="line-clamp-2">{sale.item_title}</span>
                    </td>
                    <td className="px-3 py-3">
                      {sale.sku ? (
                        <span className="text-[11px] text-gray-500 font-mono bg-gray-800 px-2 py-0.5 rounded">
                          {sale.sku}
                        </span>
                      ) : (
                        <span className="text-gray-700 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      {match ? (
                        <a
                          href={`/purchases?sku=${encodeURIComponent(sale.sku!)}`}
                          className="inline-flex items-center gap-1 bg-green-500/15 text-green-400 border border-green-500/30 text-[11px] font-medium px-2 py-0.5 rounded-full hover:bg-green-500/25 transition"
                        >
                          <span>✓</span>
                          <span>{match.brand ?? ''} {match.series ?? sale.sku}</span>
                        </a>
                      ) : (
                        <span className="text-gray-700 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-400 tabular-nums">
                      {sale.quantity_sold}
                    </td>
                    <td className="px-3 py-3 text-sm text-green-400 font-semibold tabular-nums">
                      {fmt$(sale.sold_for)}
                    </td>
                    <td className="px-3 py-3 text-sm text-gray-400">
                      {sale.buyer ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
