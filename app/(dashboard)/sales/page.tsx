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
  purchase_date: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);
}

function fmtDate(d: string | null) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const PERIOD_OPTIONS: { label: string; days: number }[] = [
  { label: '1d', days: 1 },
  { label: '7d', days: 7 },
  { label: '14d', days: 14 },
  { label: '30d', days: 30 },
  { label: '60d', days: 60 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
];

function periodLabel(days: number) {
  if (!days) return 'All time';
  return days === 1 ? 'Last 1 day' : `Last ${days} days`;
}

function isInPeriod(dateStr: string | null, days: number): boolean {
  if (!days) return true;
  if (!dateStr) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  cutoff.setHours(0, 0, 0, 0);
  // DATE-only values (YYYY-MM-DD) parse as UTC midnight; treat as local calendar dates.
  const local = /^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    ? new Date(
      Number(dateStr.slice(0, 4)),
      Number(dateStr.slice(5, 7)) - 1,
      Number(dateStr.slice(8, 10))
    )
    : new Date(dateStr);
  return local.getTime() >= cutoff.getTime();
}

function getGroupedPurchases(purchases: Purchase[], includeSku?: string | null) {
  const uniqueSkusMap = new Map(purchases.filter(p => p.sku).map(p => [p.sku!, p]));
  if (includeSku && !uniqueSkusMap.has(includeSku)) {
    uniqueSkusMap.set(includeSku, { sku: includeSku, brand: 'Unknown', series: null, sport: null, cost: 0, purchase_date: null });
  }
  const uniqueSkus = Array.from(uniqueSkusMap.values());
  const groups: Record<string, Purchase[]> = {};
  uniqueSkus.forEach(p => {
    const sport = p.sport || 'Other / Unknown';
    if (!groups[sport]) groups[sport] = [];
    groups[sport].push(p);
  });
  const sortedSports = Object.keys(groups).sort();
  sortedSports.forEach(sport => {
    groups[sport].sort((a, b) => (a.sku || '').localeCompare(b.sku || ''));
  });
  return { groups, sortedSports };
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
    const { groups, sortedSports } = getGroupedPurchases(purchases, sale.sku);

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
          {sortedSports.map(sport => (
            <optgroup key={sport} label={sport}>
              {groups[sport].map(p => (
                <option key={p.sku!} value={p.sku!}>
                  {p.sku} - {[p.brand, p.series].filter(Boolean).join(' ') || 'Unknown'}
                </option>
              ))}
            </optgroup>
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
  const [viewDays, setViewDays] = useState(14);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const [selectedSales, setSelectedSales] = useState<Set<string>>(new Set());
  const [bulkSku, setBulkSku] = useState<string>('');
  const [applyingBulk, setApplyingBulk] = useState(false);

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

  // Load purchases for match column
  const loadPurchases = useCallback(async () => {
    try {
      const res = await fetch('/api/purchases');
      const data = await res.json();
      setPurchases(data.purchases ?? []);
    } catch { /* silent */ }
  }, []);

  // Show DB rows immediately, then auto-sync the last 1 day from eBay.
  useEffect(() => {
    const ac = new AbortController();

    async function init() {
      setLoading(true);
      try {
        const [salesRes, purchasesRes] = await Promise.all([
          fetch('/api/ebay/sold-orders?sync=false', { signal: ac.signal }),
          fetch('/api/purchases', { signal: ac.signal }),
        ]);
        const salesData = await salesRes.json();
        const purchasesData = await purchasesRes.json();
        if (ac.signal.aborted) return;
        setSales(salesData.sales ?? []);
        setPurchases(purchasesData.purchases ?? []);
        if (salesData.sales?.length > 0) {
          setLastSync(salesData.sales[0].synced_at);
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }

      if (ac.signal.aborted) return;

      setSyncing(true);
      try {
        const res = await fetch('/api/ebay/sold-orders?days=1', { signal: ac.signal });
        const data = await res.json();
        if (ac.signal.aborted) return;
        if (!res.ok) throw new Error(data.error);
        setSales(data.sales ?? []);
        setLastSync(new Date().toISOString());
        if ((data.synced ?? 0) > 0) {
          setSyncMsg(
            `✓ Synced ${data.synced} new order${data.synced === 1 ? '' : 's'} from the last day.`
          );
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
        if (!ac.signal.aborted) setSyncMsg(`✗ Auto-sync failed: ${e.message}`);
      } finally {
        if (!ac.signal.aborted) setSyncing(false);
      }
    }

    init();
    return () => ac.abort();
  }, []);

  // Manual sync from eBay (uses the lookback dropdown)
  async function handleSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await fetch(`/api/ebay/sold-orders?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSales(data.sales ?? []);
      setSyncMsg(`✓ Synced ${data.synced} orders from the last ${days} day${days === 1 ? '' : 's'}.`);
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

  async function handleApplyBulkSku() {
    if (selectedSales.size === 0) return;
    setApplyingBulk(true);
    try {
      const res = await fetch('/api/ebay/sold-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedSales), sku: bulkSku.trim() || null }),
      });
      if (res.ok) {
        setSales(prev => prev.map(s => selectedSales.has(s.id) ? { ...s, sku: bulkSku.trim() || null } : s));
        setSelectedSales(new Set());
        setBulkSku('');
        loadPurchases();
      }
    } finally {
      setApplyingBulk(false);
    }
  }

  function handleToggleAll() {
    if (selectedSales.size === filtered.length && filtered.length > 0) {
      setSelectedSales(new Set());
    } else {
      setSelectedSales(new Set(filtered.map(s => s.id)));
    }
  }

  function handleToggleSale(id: string) {
    const newSet = new Set(selectedSales);
    if (newSet.has(id)) newSet.delete(id);
    else newSet.add(id);
    setSelectedSales(newSet);
  }

  // Period-scoped rows (P&L ignores the search box so ROI stays apples-to-apples)
  const periodSales = sales.filter(s => isInPeriod(s.sale_date, viewDays));
  const periodPurchases = purchases.filter(p => isInPeriod(p.purchase_date, viewDays));

  // Filter table by period + search
  const filtered = periodSales.filter(s => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.item_title.toLowerCase().includes(q) ||
      (s.sku ?? '').toLowerCase().includes(q) ||
      s.order_number.toLowerCase().includes(q) ||
      (s.buyer ?? '').toLowerCase().includes(q)
    );
  });

  // Period P&L
  const totalRevenue = periodSales.reduce((s, r) => s + Number(r.sold_for || 0), 0);
  const purchaseCost = periodPurchases.reduce((s, p) => s + Number(p.cost || 0), 0);
  const profit = totalRevenue - purchaseCost;
  const roiPct = purchaseCost > 0 ? (profit / purchaseCost) * 100 : null;
  const avgSale = periodSales.length ? totalRevenue / periodSales.length : 0;
  const matched = periodSales.filter(s => s.sku && skuTotalCostMap.has(s.sku)).length;

  return (
    <div className="h-full flex flex-col bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="flex-none border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-white">eBay Sales</h1>
            <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
              <span>
                Auto-syncs the last day on load
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
              <span className="text-xs text-gray-500">Sync lookback:</span>
              <select
                className="bg-transparent text-sm text-gray-200 focus:outline-none cursor-pointer"
                value={days}
                onChange={e => setDays(parseInt(e.target.value))}
              >
                {[1, 7, 14, 30, 60, 90].map(d => (
                  <option key={d} value={d}>{d} day{d === 1 ? '' : 's'}</option>
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

        {/* Period selector */}
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs text-gray-500 shrink-0">Period:</span>
            <div className="flex items-center gap-1 flex-wrap">
              {PERIOD_OPTIONS.map(opt => (
                <button
                  key={opt.days}
                  type="button"
                  onClick={() => {
                    setViewDays(opt.days);
                    setSelectedSales(new Set());
                  }}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition ${viewDays === opt.days
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-900 text-gray-400 hover:text-white border border-gray-800'
                    }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-gray-600 shrink-0 hidden sm:block">
            {periodLabel(viewDays)} · sales vs purchases
          </p>
        </div>

        {/* P&L stats for the selected period */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          {[
            {
              label: 'Sales Revenue',
              value: fmt$(totalRevenue),
              sub: `${periodSales.length} sale${periodSales.length === 1 ? '' : 's'}`,
              color: 'text-green-400',
            },
            {
              label: 'Purchase Cost',
              value: fmt$(purchaseCost),
              sub: `${periodPurchases.length} purchase${periodPurchases.length === 1 ? '' : 's'}`,
              color: 'text-orange-400',
            },
            {
              label: 'Profit',
              value: `${profit >= 0 ? '' : '−'}${fmt$(Math.abs(profit))}`,
              sub: 'sales − cost',
              color: profit > 0 ? 'text-green-400' : profit < 0 ? 'text-red-400' : 'text-gray-400',
            },
            {
              label: 'ROI',
              value: roiPct === null ? '—' : `${roiPct > 0 ? '+' : ''}${roiPct.toFixed(1)}%`,
              sub: purchaseCost > 0 ? 'profit / cost' : 'no purchases',
              color:
                roiPct === null
                  ? 'text-gray-400'
                  : roiPct > 0
                    ? 'text-green-400'
                    : roiPct < 0
                      ? 'text-red-400'
                      : 'text-gray-400',
            },
            {
              label: 'Avg Sale',
              value: fmt$(avgSale),
              sub: periodLabel(viewDays).toLowerCase(),
              color: 'text-yellow-400',
            },
            {
              label: 'Matched SKUs',
              value: `${matched} / ${periodSales.length}`,
              sub: 'sales linked to a purchase',
              color: 'text-purple-400',
            },
          ].map(s => (
            <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
              <p className="text-[11px] text-gray-500 uppercase tracking-wider">{s.label}</p>
              <p className={`text-xl font-bold mt-0.5 ${s.color}`}>{s.value}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">{s.sub}</p>
            </div>
          ))}
        </div>

        {/* Search & Bulk Actions */}
        <div className="flex items-center gap-4">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm">🔍</span>
            <input
              type="text"
              className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-9 pr-4 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500 transition"
              placeholder="Search by title, SKU, order #, buyer…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {selectedSales.size > 0 && (
            <div className="flex items-center gap-3 bg-blue-900/20 border border-blue-500/30 rounded-lg px-4 py-1.5 transition-all">
              <span className="text-sm text-blue-400 font-medium">{selectedSales.size} selected</span>
              <div className="h-5 w-px bg-blue-500/30 mx-1"></div>
              <select
                className="bg-gray-800 border border-blue-500/50 rounded px-3 py-1 text-sm text-white focus:outline-none focus:border-blue-400 transition cursor-pointer"
                value={bulkSku}
                onChange={e => setBulkSku(e.target.value)}
              >
                <option value="">-- Apply SKU --</option>
                {(() => {
                  const { groups, sortedSports } = getGroupedPurchases(purchases);
                  return sortedSports.map(sport => (
                    <optgroup key={sport} label={sport}>
                      {groups[sport].map(p => (
                        <option key={p.sku!} value={p.sku!}>
                          {p.sku} - {[p.brand, p.series].filter(Boolean).join(' ') || 'Unknown'}
                        </option>
                      ))}
                    </optgroup>
                  ));
                })()}
              </select>
              <button
                onClick={handleApplyBulkSku}
                disabled={applyingBulk}
                className="px-4 py-1 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded transition flex items-center gap-2"
              >
                {applyingBulk ? (
                  <>
                    <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Applying…
                  </>
                ) : (
                  'Apply'
                )}
              </button>
            </div>
          )}
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
                ? 'No sales yet — syncing from eBay, or click Sync to pull a longer window.'
                : search
                  ? 'No sales match your search.'
                  : `No sales in ${periodLabel(viewDays).toLowerCase()}.`}
            </p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-gray-900/95 backdrop-blur z-10">
              <tr className="text-[11px] text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-3 py-3 w-8">
                  <input
                    type="checkbox"
                    className="rounded border-gray-700 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-gray-900 cursor-pointer"
                    checked={filtered.length > 0 && selectedSales.size === filtered.length}
                    onChange={handleToggleAll}
                  />
                </th>
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
                    className={`border-b border-gray-800/60 hover:bg-gray-800/40 transition ${selectedSales.has(sale.id) ? 'bg-blue-900/10' : ''}`}
                  >
                    {/* Checkbox */}
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="rounded border-gray-700 bg-gray-800 text-blue-500 focus:ring-blue-500 focus:ring-offset-gray-900 cursor-pointer"
                        checked={selectedSales.has(sale.id)}
                        onChange={() => handleToggleSale(sale.id)}
                      />
                    </td>

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

                    {/* Shipped — tracking set by the ITEM_MARKED_SHIPPED webhook (updates live via
                        realtime); the slip link always hits the on-demand regenerate endpoint rather
                        than the webhook-stored packing_slip_url, so it works even if that webhook's
                        own backfill silently failed (see /api/ebay/packing-slip/[orderNumber]) */}
                    <td className="px-3 py-3 text-xs whitespace-nowrap">
                      <div className="flex flex-col gap-0.5">
                        {sale.tracking_number ? (
                          <span className="text-gray-300">
                            {sale.carrier ? `${sale.carrier} ` : ''}
                            <span className="font-mono">{sale.tracking_number}</span>
                          </span>
                        ) : (
                          <span className="text-gray-700 italic">not yet shipped</span>
                        )}
                        <div className="flex items-center gap-2">
                          {sale.shipped_at && (
                            <span className="text-gray-600">{fmtDate(sale.shipped_at)}</span>
                          )}
                          <a
                            href={`/api/ebay/packing-slip/${encodeURIComponent(sale.order_number)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
                            title="Regenerate and view/print the packing slip for this order"
                          >
                            {sale.packing_slip_url ? 'reprint slip' : 'print slip'}
                          </a>
                        </div>
                      </div>
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
