'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSalesRealtimeSync } from '../hooks/useRealtime';

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
  picture_url: string | null;
  synced_at: string;
  // Set by the ITEM_MARKED_SHIPPED webhook once a label/tracking is added —
  // null until then. Comes in via realtime, not the initial sync fetch alone.
  tracking_number: string | null;
  carrier: string | null;
  shipped_at: string | null;
  packing_slip_url: string | null;
}

interface Purchase {
  sku: string | null;
  brand: string | null;
  series: string | null;
  sport: string | null;
  cost: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Inline SKU Editor ────────────────────────────────────────────────────────

function SkuCell({
  sale,
  purchases,
  onSaved,
}: {
  sale: Sale;
  purchases: Purchase[];
  onSaved: (id: string, sku: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(sale.sku ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      const res = await fetch('/api/ebay/sold-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sale.id, sku: value.trim() || null }),
      });
      if (res.ok) {
        onSaved(sale.id, value.trim() || null);
      }
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') { setValue(sale.sku ?? ''); setEditing(false); }
  }

  if (editing) {
    const uniqueSkus = Array.from(new Map(purchases.filter(p => p.sku).map(p => [p.sku, p])).values());
    if (sale.sku && !uniqueSkus.find(p => p.sku === sale.sku)) {
      uniqueSkus.push({ sku: sale.sku, brand: 'Unknown', series: null, sport: null, cost: 0 });
    }

    return (
      <div className="flex items-center gap-1">
        <select
          ref={inputRef}
          className="bg-gray-700 border border-blue-500 rounded px-2 py-0.5 text-xs text-white font-mono w-44 focus:outline-none"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={save}
        >
          <option value="">-- Select Purchase --</option>
          {uniqueSkus.map(p => (
            <option key={p.sku!} value={p.sku!}>
              {p.sku} - {[p.brand, p.series].filter(Boolean).join(' ') || 'Unknown'}
            </option>
          ))}
        </select>
        {saving && <span className="text-gray-500 text-[10px]">…</span>}
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="group flex items-center gap-1"
      title="Click to edit SKU"
    >
      {sale.sku ? (
        <span className="text-[11px] text-gray-400 font-mono bg-gray-800 px-2 py-0.5 rounded group-hover:bg-gray-700 group-hover:text-white transition">
          {sale.sku}
        </span>
      ) : (
        <span className="text-[11px] text-gray-600 italic group-hover:text-gray-400 transition">
          + add SKU
        </span>
      )}
      <span className="text-gray-600 text-[10px] opacity-0 group-hover:opacity-100 transition">✎</span>
    </button>
  );
}

// ─── Image Thumbnail ──────────────────────────────────────────────────────────

function ItemImage({ url, title }: { url: string | null; title: string }) {
  const [err, setErr] = useState(false);

  if (!url || err) {
    return (
      <div className="w-10 h-10 rounded bg-gray-800 flex items-center justify-center text-gray-600 text-lg flex-shrink-0">
        🃏
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={title}
      className="w-10 h-10 rounded object-cover flex-shrink-0 bg-gray-800"
      onError={() => setErr(true)}
    />
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function SalesPage() {
  const [sales, setSales] = useState<Sale[]>([]);
  const { isConnected: liveConnected, lastUpdate: liveUpdate } = useSalesRealtimeSync(setSales);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [search, setSearch] = useState('');
  const [days, setDays] = useState(90);
  const [lastSync, setLastSync] = useState<string | null>(null);

  // Build a SKU -> total cost lookup
  const skuTotalCostMap = new Map<string, number>();
  const skuMap = new Map<string, Purchase>();
  purchases.forEach(p => {
    if (p.sku) {
      skuTotalCostMap.set(p.sku, (skuTotalCostMap.get(p.sku) ?? 0) + p.cost);
      if (!skuMap.has(p.sku)) {
        skuMap.set(p.sku, p);
      }
    }
  });

  // Build a SKU -> total sales lookup
  const skuTotalSalesMap = new Map<string, number>();
  sales.forEach(s => {
    if (s.sku) {
      skuTotalSalesMap.set(s.sku, (skuTotalSalesMap.get(s.sku) ?? 0) + s.sold_for);
    }
  });

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
      setSyncMsg(`✓ Synced ${data.synced} orders from the last ${days} days.`);
      setLastSync(new Date().toISOString());
    } catch (e: any) {
      setSyncMsg(`✗ Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  }

  // Called when a SKU is edited inline
  function handleSkuSaved(id: string, sku: string | null) {
    setSales(prev => prev.map(s => s.id === id ? { ...s, sku } : s));
    // Refresh purchase map if sku changed
    loadPurchases();
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
  const matched = filtered.filter(s => s.sku && skuTotalCostMap.has(s.sku)).length;

  return (
    <div className="h-full flex flex-col bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="flex-none border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-white">eBay Sales</h1>
            <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
              <span>
                Auto-synced from eBay completed orders
                {lastSync && (
                  <span className="ml-2 text-gray-600">· Last sync: {fmtDate(lastSync)}</span>
                )}
              </span>
              <span
                className={`inline-flex items-center gap-1 ${liveConnected ? 'text-green-500' : 'text-gray-600'}`}
                title={
                  liveConnected
                    ? `Live — auto-updates as shipping labels/tracking come in${liveUpdate ? ` (last update ${liveUpdate.toLocaleTimeString()})` : ''}`
                    : 'Connecting to realtime updates…'
                }
              >
                <span className={`w-1.5 h-1.5 rounded-full ${liveConnected ? 'bg-green-500 animate-pulse' : 'bg-gray-600'}`} />
                {liveConnected ? 'Live' : 'Connecting…'}
              </span>
            </p>
          </div>

          {/* Sync controls */}
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 bg-gray-900 border border-gray-800 rounded-lg px-3 py-1.5">
              <span className="text-xs text-gray-500">Days back:</span>
              <select
                className="bg-transparent text-sm text-gray-200 focus:outline-none cursor-pointer"
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
                <th className="px-3 py-3 w-14">Image</th>
                <th className="px-3 py-3">Order #</th>
                <th className="px-3 py-3">Sale Date</th>
                <th className="px-3 py-3">Item Title</th>
                <th className="px-3 py-3">SKU <span className="normal-case text-gray-600 font-normal">(click to edit)</span></th>
                <th className="px-3 py-3">Matched Purchase</th>
                <th className="px-3 py-3">Qty</th>
                <th className="px-3 py-3">Sold For</th>
                <th className="px-3 py-3">Lot Cost</th>
                <th className="px-3 py-3">ROI</th>
                <th className="px-3 py-3">Shipped</th>
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
                    {/* Image */}
                    <td className="px-3 py-2">
                      <ItemImage url={sale.picture_url} title={sale.item_title} />
                    </td>

                    {/* Order # */}
                    <td className="px-3 py-3 text-xs text-gray-400 font-mono whitespace-nowrap">
                      {sale.order_number}
                    </td>

                    {/* Sale Date */}
                    <td className="px-3 py-3 text-sm text-gray-400 whitespace-nowrap">
                      {fmtDate(sale.sale_date)}
                    </td>

                    {/* Title */}
                    <td className="px-3 py-3 text-sm text-gray-200 max-w-xs">
                      <span className="line-clamp-2">{sale.item_title}</span>
                    </td>

                    {/* SKU — inline editable */}
                    <td className="px-3 py-3">
                      <SkuCell sale={sale} purchases={purchases} onSaved={handleSkuSaved} />
                    </td>

                    {/* Matched Purchase */}
                    <td className="px-3 py-3">
                      {match ? (
                        <a
                          href={`/purchases?sku=${encodeURIComponent(sale.sku!)}`}
                          className="inline-flex items-center gap-1 bg-green-500/15 text-green-400 border border-green-500/30 text-[11px] font-medium px-2 py-0.5 rounded-full hover:bg-green-500/25 transition"
                        >
                          <span>✓</span>
                          <span>{[match.brand, match.series].filter(Boolean).join(' ') || sale.sku}</span>
                        </a>
                      ) : (
                        <span className="text-gray-700 text-xs">—</span>
                      )}
                    </td>

                    {/* Qty */}
                    <td className="px-3 py-3 text-sm text-gray-400 tabular-nums">
                      {sale.quantity_sold}
                    </td>

                    {/* Sold For */}
                    <td className="px-3 py-3 text-sm text-green-400 font-semibold tabular-nums">
                      {fmt$(sale.sold_for)}
                    </td>

                    {/* Lot Cost */}
                    <td className="px-3 py-3 text-sm text-gray-300 tabular-nums">
                      {sale.sku && skuTotalCostMap.has(sale.sku) ? (
                        fmt$(skuTotalCostMap.get(sale.sku)!)
                      ) : (
                        <span className="text-gray-600 italic text-xs">no match</span>
                      )}
                    </td>

                    {/* ROI */}
                    <td className="px-3 py-3 text-sm tabular-nums">
                      {(() => {
                        if (!sale.sku || !skuTotalCostMap.has(sale.sku)) return <span className="text-gray-600">—</span>;
                        const cost = skuTotalCostMap.get(sale.sku)!;
                        if (cost === 0) return <span className="text-gray-600">—</span>;
                        const totalSalesForSku = skuTotalSalesMap.get(sale.sku) ?? 0;
                        const roi = ((totalSalesForSku - cost) / cost) * 100;
                        const color = roi > 0 ? 'text-green-400' : roi < 0 ? 'text-red-400' : 'text-gray-400';
                        const sign = roi > 0 ? '+' : '';
                        return <span className={`font-medium ${color}`}>{sign}{roi.toFixed(1)}%</span>;
                      })()}
                    </td>

                    {/* Shipped — set by the ITEM_MARKED_SHIPPED webhook; updates live via realtime */}
                    <td className="px-3 py-3 text-xs whitespace-nowrap">
                      {sale.tracking_number ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-gray-300">
                            {sale.carrier ? `${sale.carrier} ` : ''}
                            <span className="font-mono">{sale.tracking_number}</span>
                          </span>
                          <div className="flex items-center gap-2">
                            {sale.shipped_at && (
                              <span className="text-gray-600">{fmtDate(sale.shipped_at)}</span>
                            )}
                            {sale.packing_slip_url && (
                              <a
                                href={sale.packing_slip_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
                              >
                                slip
                              </a>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-gray-700 italic">not yet shipped</span>
                      )}
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
