'use client';

import { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useSalesRealtimeSync } from '../hooks/useRealtime';
import {
  DEFAULT_PNL_SETTINGS,
  EXPENSE_CATEGORIES,
  resolvedSaleCosts,
  roiPct,
  roundMoney,
  type ExpenseCategory,
  type PnlSettings,
} from '@/app/lib/pnl';
import {
  POOL_ITEM_STATUS_LABELS,
  ROI_HELP,
  computePoolMetrics,
  formatRoiPct,
  poolInputFromPurchases,
  roiToneClass,
  saleShareOfPoolCogs,
  type AllocationMode,
  type PoolItemStatus,
  type PoolMetrics,
} from '@/app/lib/pool-roi';
import { orderHeadIds, ordersWithDuplicatedBuyerShipping } from '@/app/lib/order-costs';
import {
  PRICE_BAND_TONE,
  classifyPriceBand,
  computePriceBandPool,
  saleShareOfBandCogs,
  usesPriceBands,
  type BandSale,
} from '@/app/lib/price-bands';

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
  ebay_fee?: number | null;
  advertising_fee?: number | null;
  shipping_cost?: number | null;
  supplies_cost?: number | null;
  order_shipping_cost?: number | null;
  exclude_from_stats?: boolean;
}

interface Expense {
  id: string;
  expense_date: string;
  category: ExpenseCategory;
  amount: number;
  notes: string | null;
}

interface PoolItem {
  id: string;
  label: string | null;
  estimated_value: number;
  allocated_cost: number | null;
  status: PoolItemStatus;
  qty: number;
  sale_id: string | null;
}

interface Purchase {
  id?: string;
  sku: string | null;
  brand: string | null;
  series: string | null;
  sport: string | null;
  cost: number;
  quantity: number;
  purchase_date: string | null;
  allocation_mode?: AllocationMode | null;
  expected_bulk_recovery?: number | null;
  items?: PoolItem[] | null;
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

const EXPENSE_LABELS: Record<ExpenseCategory, string> = {
  advertising: 'eBay Advertising',
  supplies: 'Supplies',
  shipping: 'Shipping',
  ebay_fees: 'eBay Fees',
  other: 'Other',
};

function getGroupedPurchases(purchases: Purchase[], includeSku?: string | null) {
  const uniqueSkusMap = new Map(purchases.filter(p => p.sku).map(p => [p.sku!, p]));
  if (includeSku && !uniqueSkusMap.has(includeSku)) {
    uniqueSkusMap.set(includeSku, { sku: includeSku, brand: 'Unknown', series: null, sport: null, cost: 0, quantity: 1, purchase_date: null });
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

// ─── Inline dollar editor ─────────────────────────────────────────────────────

function CostCell({
  saleId,
  value,
  fallback,
  field,
  onSaved,
  pendingLabel,
  pendingTitle,
}: {
  saleId: string;
  value: number | null;
  fallback: number;
  field: 'ebay_fee' | 'advertising_fee' | 'shipping_cost' | 'supplies_cost';
  onSaved: (id: string, field: string, amount: number) => void;
  pendingLabel?: string;
  pendingTitle?: string;
}) {
  const [editing, setEditing] = useState(false);
  const stored = value != null ? Number(value) : null;
  const [text, setText] = useState(stored != null ? stored.toFixed(2) : fallback.toFixed(2));
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isEstimate = stored == null;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    setText((stored != null ? stored : fallback).toFixed(2));
  }, [stored, fallback]);

  async function save() {
    if (saving) return;
    const parsed = parseFloat(text);
    const amount = Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : fallback;
    // Clicking a pending cell and blurring must not write $0, or Finances
    // will skip the row when the real label/ad posts later.
    if (stored == null && text === fallback.toFixed(2)) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ebay/sold-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: saleId, [field]: amount }),
      });
      if (res.ok) onSaved(saleId, field, amount);
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        type="number"
        step="0.01"
        min="0"
        className="w-16 bg-gray-700 border border-blue-500 rounded px-1 py-0.5 text-xs text-white tabular-nums focus:outline-none"
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={save}
        onKeyDown={e => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') { setText((stored != null ? stored : fallback).toFixed(2)); setEditing(false); }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={`tabular-nums text-xs hover:text-white transition ${isEstimate ? 'text-gray-500 italic' : 'text-gray-300'}`}
      title={isEstimate ? (pendingTitle || 'Not posted by eBay yet — click to set') : 'Click to edit'}
    >
      {isEstimate && pendingLabel ? pendingLabel : fmt$(stored != null ? stored : fallback)}
      {saving && <span className="text-gray-600"> …</span>}
    </button>
  );
}

const EMPTY_EXPENSE = {
  expense_date: new Date().toISOString().slice(0, 10),
  category: 'supplies' as ExpenseCategory,
  amount: '',
  notes: '',
};

function ExpensePanel({
  expenses,
  onChanged,
  onClose,
}: {
  expenses: Expense[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState(EMPTY_EXPENSE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function addExpense() {
    const amount = parseFloat(form.amount);
    if (!form.expense_date || !Number.isFinite(amount)) {
      setError('Date and amount are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expense_date: form.expense_date,
          category: form.category,
          amount,
          notes: form.notes.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setForm({ ...EMPTY_EXPENSE, category: form.category });
      onChanged();
    } catch (e: any) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function removeExpense(id: string) {
    if (!confirm('Delete this expense?')) return;
    await fetch(`/api/expenses?id=${id}`, { method: 'DELETE' });
    onChanged();
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div>
            <h2 className="text-white font-semibold text-lg">Operating expenses</h2>
            <p className="text-gray-500 text-xs mt-0.5">
              Track advertising invoices, sleeves, top-loaders, postage, and other costs that hit P&amp;L
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl transition">✕</button>
        </div>

        <div className="p-5 border-b border-gray-800 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="text-xs text-gray-400">
              Date
              <input
                type="date"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.expense_date}
                onChange={e => setForm(f => ({ ...f, expense_date: e.target.value }))}
              />
            </label>
            <label className="text-xs text-gray-400">
              Category
              <select
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value as ExpenseCategory }))}
              >
                {EXPENSE_CATEGORIES.map(c => (
                  <option key={c} value={c}>{EXPENSE_LABELS[c]}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-gray-400">
              Amount
              <input
                type="number"
                step="0.01"
                min="0"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.amount}
                onChange={e => setForm(f => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
              />
            </label>
            <label className="text-xs text-gray-400">
              Notes
              <input
                type="text"
                className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. 1000 penny sleeves"
              />
            </label>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            type="button"
            onClick={addExpense}
            disabled={saving}
            className="px-4 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
          >
            {saving ? 'Saving…' : '+ Add expense'}
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5">
          {expenses.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-8">No expenses logged yet.</p>
          ) : (
            <table className="w-full text-left">
              <thead>
                <tr className="text-[11px] text-gray-500 uppercase tracking-wider border-b border-gray-800">
                  <th className="pb-2 pr-3">Date</th>
                  <th className="pb-2 pr-3">Category</th>
                  <th className="pb-2 pr-3">Amount</th>
                  <th className="pb-2 pr-3">Notes</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {expenses.map(ex => (
                  <tr key={ex.id} className="border-b border-gray-800/60 text-sm">
                    <td className="py-2 pr-3 text-gray-400 whitespace-nowrap">{fmtDate(ex.expense_date)}</td>
                    <td className="py-2 pr-3 text-gray-300">{EXPENSE_LABELS[ex.category]}</td>
                    <td className="py-2 pr-3 text-orange-400 tabular-nums">{fmt$(Number(ex.amount))}</td>
                    <td className="py-2 pr-3 text-gray-500">{ex.notes || '—'}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeExpense(ex.id)}
                        className="text-[11px] text-red-500 hover:text-red-400 px-2 py-0.5 rounded hover:bg-red-500/10"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

function DefaultsPanel({
  settings,
  onSaved,
  onClose,
}: {
  settings: PnlSettings;
  onSaved: (s: PnlSettings, filled: number) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState({
    default_shipping_cost: settings.default_shipping_cost.toString(),
    default_supplies_cost: settings.default_supplies_cost.toString(),
    default_fee_rate: (settings.default_fee_rate * 100).toString(),
    default_processing_fee: settings.default_processing_fee.toString(),
  });
  const [applyBlank, setApplyBlank] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function set(key: string, val: string) {
    setForm(f => ({ ...f, [key]: val }));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/pnl-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          default_shipping_cost: parseFloat(form.default_shipping_cost) || 0,
          default_supplies_cost: parseFloat(form.default_supplies_cost) || 0,
          default_fee_rate: (parseFloat(form.default_fee_rate) || 0) / 100,
          default_processing_fee: parseFloat(form.default_processing_fee) || 0,
          default_ad_rate: 0,
          apply_to_blank: applyBlank,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onSaved(data.settings, data.filled ?? 0);
      onClose();
    } catch (e: any) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div>
            <h2 className="text-white font-semibold text-lg">Cost defaults</h2>
            <p className="text-gray-500 text-xs mt-0.5">
              Fee rate and supplies apply to new sales. Promoted-listing ads and seller-paid labels stay blank until eBay Finances posts them (often hours later).
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl transition">✕</button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-gray-400">
              eBay fee rate (%)
              <input type="number" step="0.01" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" value={form.default_fee_rate} onChange={e => set('default_fee_rate', e.target.value)} />
            </label>
            <label className="text-xs text-gray-400">
              Per-order processing ($)
              <input type="number" step="0.01" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" value={form.default_processing_fee} onChange={e => set('default_processing_fee', e.target.value)} />
            </label>
            <label className="text-xs text-gray-400">
              Typical label ($)
              <input type="number" step="0.01" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" value={form.default_shipping_cost} onChange={e => set('default_shipping_cost', e.target.value)} />
              <span className="block text-[10px] text-gray-600 mt-1">Editor hint only — not written onto sales. Labels fill from eBay.</span>
            </label>
            <label className="text-xs text-gray-400 col-span-2">
              Supplies per sale ($)
              <input type="number" step="0.01" className="mt-1 w-full bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500" value={form.default_supplies_cost} onChange={e => set('default_supplies_cost', e.target.value)} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-300">
            <input type="checkbox" checked={applyBlank} onChange={e => setApplyBlank(e.target.checked)} className="rounded border-gray-700 bg-gray-800 text-blue-500" />
            Fill blank eBay fees and supplies on existing sales (never ads or shipping)
          </label>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-1.5 text-sm text-gray-400 hover:text-white">Cancel</button>
            <button type="button" onClick={save} disabled={saving} className="px-4 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg">
              {saving ? 'Saving…' : 'Save defaults'}
            </button>
          </div>
        </div>
      </div>
    </div>
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

function SalesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const skuFilter = searchParams.get('sku')?.trim() || '';
  const [sales, setSales] = useState<Sale[]>([]);
  const { isConnected: liveConnected, lastUpdate: liveUpdate } = useSalesRealtimeSync(setSales);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [refreshingLabels, setRefreshingLabels] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
  const [search, setSearch] = useState('');
  const [days, setDays] = useState(90);
  const [viewDays, setViewDays] = useState(skuFilter ? 0 : 14);
  const [lastSync, setLastSync] = useState<string | null>(null);

  const [selectedSales, setSelectedSales] = useState<Set<string>>(new Set());
  const [bulkSku, setBulkSku] = useState<string>('');
  const [applyingBulk, setApplyingBulk] = useState(false);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [settings, setSettings] = useState<PnlSettings>(DEFAULT_PNL_SETTINGS);
  const [showExpenses, setShowExpenses] = useState(false);
  const [showDefaults, setShowDefaults] = useState(false);
  const [showExcluded, setShowExcluded] = useState(true);

  // SKU -> lot cost / cards purchased (a SKU is often a box or lot, not one card)
  const skuTotalCostMap = new Map<string, number>();
  const skuQtyPurchasedMap = new Map<string, number>();
  const skuMap = new Map<string, Purchase>();
  const purchasesBySku = new Map<string, Purchase[]>();
  purchases.forEach(p => {
    if (p.sku) {
      skuTotalCostMap.set(p.sku, (skuTotalCostMap.get(p.sku) ?? 0) + Number(p.cost || 0));
      skuQtyPurchasedMap.set(p.sku, (skuQtyPurchasedMap.get(p.sku) ?? 0) + (p.quantity || 1));
      if (!skuMap.has(p.sku)) {
        skuMap.set(p.sku, p);
      }
      if (!purchasesBySku.has(p.sku)) purchasesBySku.set(p.sku, []);
      purchasesBySku.get(p.sku)!.push(p);
    }
  });
  const saleToPoolItem = new Map<string, string>();
  purchases.forEach(p => {
    (p.items ?? []).forEach(it => {
      if (it.sale_id) saleToPoolItem.set(it.sale_id, it.id);
    });
  });

  const firstSaleIdByOrder = orderHeadIds(sales);
  const duplicatedBuyerShip = ordersWithDuplicatedBuyerShipping(sales);

  function saleCosts(sale: Sale) {
    const head = firstSaleIdByOrder.get(sale.order_number) === sale.id;
    const dupBuyer = duplicatedBuyerShip.has(sale.order_number);
    return resolvedSaleCosts({
      ...sale,
      order_shipping_cost: dupBuyer && !head ? 0 : sale.order_shipping_cost,
      shipping_cost: sale.shipping_cost,
    }, settings);
  }

  const statsSales = sales.filter(s => !s.exclude_from_stats);

  // SKU -> lifetime net / revenue / cards sold (card cost + lot ROI)
  const skuTotalNetMap = new Map<string, number>();
  const skuTotalRevenueMap = new Map<string, number>();
  const skuQtySoldAllMap = new Map<string, number>();
  statsSales.forEach(s => {
    if (s.sku) {
      const c = saleCosts(s);
      skuTotalNetMap.set(s.sku, (skuTotalNetMap.get(s.sku) ?? 0) + c.net);
      skuTotalRevenueMap.set(s.sku, (skuTotalRevenueMap.get(s.sku) ?? 0) + c.soldFor + c.buyerShipping);
      skuQtySoldAllMap.set(s.sku, (skuQtySoldAllMap.get(s.sku) ?? 0) + (s.quantity_sold || 1));
    }
  });

  const poolBySku = new Map<string, PoolMetrics>();
  purchasesBySku.forEach((ps, sku) => {
    poolBySku.set(
      sku,
      computePoolMetrics(
        poolInputFromPurchases(ps, skuQtySoldAllMap.get(sku) ?? 0, skuTotalNetMap.get(sku) ?? 0)
      )
    );
  });

  const skuBandSales = new Map<string, BandSale[]>();
  statsSales.forEach(s => {
    if (!s.sku || !usesPriceBands(s.sku)) return;
    const c = saleCosts(s);
    const list = skuBandSales.get(s.sku) ?? [];
    list.push({ quantitySold: s.quantity_sold || 1, soldFor: c.soldFor, net: c.net });
    skuBandSales.set(s.sku, list);
  });
  const bandPoolBySku = new Map<string, ReturnType<typeof computePriceBandPool>>();
  purchasesBySku.forEach((ps, sku) => {
    if (!usesPriceBands(sku)) return;
    const cost = ps.reduce((s, p) => s + Number(p.cost || 0), 0);
    bandPoolBySku.set(sku, computePriceBandPool(cost, skuBandSales.get(sku) ?? []));
  });

  function unitCostForSku(sku: string): number | null {
    const metrics = poolBySku.get(sku);
    if (!metrics) return null;
    if (metrics.soldQty > 0 && metrics.costOfSold > 0) return metrics.costOfSold / metrics.soldQty;
    return metrics.unitCost;
  }

  function poolForSku(sku: string) {
    return poolBySku.get(sku) ?? null;
  }

  // Load purchases for match column
  const loadPurchases = useCallback(async () => {
    try {
      const res = await fetch('/api/purchases');
      const data = await res.json();
      setPurchases(data.purchases ?? []);
    } catch { /* silent */ }
  }, []);

  const loadExpenses = useCallback(async () => {
    try {
      const res = await fetch('/api/expenses');
      const data = await res.json();
      setExpenses(data.expenses ?? []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    const ac = new AbortController();

    async function init() {
      setLoading(true);
      try {
        const [salesRes, purchasesRes, expensesRes, settingsRes] = await Promise.all([
          fetch('/api/ebay/sold-orders?sync=false', { signal: ac.signal }),
          fetch('/api/purchases', { signal: ac.signal }),
          fetch('/api/expenses', { signal: ac.signal }),
          fetch('/api/pnl-settings', { signal: ac.signal }),
        ]);
        const salesData = await salesRes.json();
        const purchasesData = await purchasesRes.json();
        const expensesData = await expensesRes.json();
        const settingsData = await settingsRes.json();
        if (ac.signal.aborted) return;
        setSales(salesData.sales ?? []);
        setPurchases(purchasesData.purchases ?? []);
        setExpenses(expensesData.expenses ?? []);
        if (settingsData.settings) setSettings(settingsData.settings);
        if (salesData.sales?.length > 0) {
          setLastSync(salesData.sales[0].synced_at);
        }
        if (!ac.signal.aborted) setLoading(false);

        // Postpaid eSE labels and promoted-listing ads land after the sale.
        try {
          const labelRes = await fetch('/api/ebay/seller-costs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days: 14, quick: true, onlyBlank: true }),
            signal: ac.signal,
          });
          const labelData = await labelRes.json();
          if (!ac.signal.aborted && labelRes.ok && Array.isArray(labelData.sales)) {
            setSales(labelData.sales);
          }
        } catch (e: any) {
          if (e?.name === 'AbortError') return;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }

    init();
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (skuFilter) {
      setViewDays(0);
      setSelectedSales(new Set());
    }
  }, [skuFilter]);

  async function handleSync() {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await fetch(`/api/ebay/sold-orders?days=${days}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSales(data.sales ?? []);
      const newOrders = data.synced ?? 0;
      const labelsMatched = data.labelsMatched ?? 0;
      let msg = `✓ Synced ${newOrders} new order${newOrders === 1 ? '' : 's'} from the last ${days} day${days === 1 ? '' : 's'}`;
      if (labelsMatched) msg += `, filled ${labelsMatched} seller-paid label${labelsMatched === 1 ? '' : 's'}`;
      msg += '.';
      setSyncMsg(msg);
      setLastSync(new Date().toISOString());
    } catch (e: any) {
      setSyncMsg(`✗ Sync failed: ${e.message}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleRefreshLabels() {
    setRefreshingLabels(true);
    setSyncMsg('');
    try {
      const res = await fetch('/api/ebay/seller-costs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: Math.max(days, 14) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setSales(data.sales ?? []);
      const found = data.labelsFound ?? 0;
      const matched = data.matchedOrders ?? 0;
      const extra = data.perOrderFilled ?? 0;
      let msg = `✓ Found ${found} seller-paid label${found === 1 ? '' : 's'}, matched ${matched} order${matched === 1 ? '' : 's'}`;
      if (extra) msg += ` (${extra} of ${data.missingLookedUp ?? extra} blank-ship orders looked up)`;
      msg += '.';
      if (data.typicalLabelCost != null) {
        const typical = Number(data.typicalLabelCost);
        const min = Number(data.minLabelCost);
        const max = Number(data.maxLabelCost);
        msg += ` Typical label ${fmt$(typical)}`;
        if (min !== max) msg += ` (range ${fmt$(min)}–${fmt$(max)})`;
        msg += '. Solid amounts are from eBay (fees, ads, seller-paid labels). Ads and labels stay pending until Finances posts them. Buyer-paid shipping is added into Net.';
      }
      if (found > 0 && matched === 0) {
        const fromEbay = (data.sampleLabelOrderIds || []).join(', ') || 'none';
        const fromSales = (data.sampleSaleOrderIds || []).join(', ') || 'none';
        msg += ` No order-id match. Label order IDs: ${fromEbay}. Sale order #s: ${fromSales}.`;
      }
      if (data.debug?.amount != null) {
        msg += ` Order ${data.debug.orderId}: ${fmt$(Number(data.debug.amount))} (${data.debug.source || 'eBay'}).`;
      } else if (data.debug?.orderId) {
        msg += ` Order ${data.debug.orderId}: no seller-paid label found. Types: ${(data.debug.txTypes || []).join(', ') || 'none'}.`;
      }
      if (data.warning) msg += ` ${data.warning}`;
      setSyncMsg(msg);
    } catch (e: any) {
      setSyncMsg(`✗ Label cost refresh failed: ${e.message}`);
    } finally {
      setRefreshingLabels(false);
    }
  }

  // Called when a SKU is edited inline
  function handleSkuSaved(id: string, sku: string | null) {
    setSales(prev => prev.map(s => s.id === id ? { ...s, sku } : s));
    // Refresh purchase map if sku changed
    loadPurchases();
  }

  function handleCostSaved(id: string, field: string, amount: number) {
    setSales(prev => prev.map(s => s.id === id ? { ...s, [field]: amount } : s));
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

  async function handleExcludeFromStats(ids: string[], excluded: boolean) {
    if (ids.length === 0) return;
    setSales(prev => prev.map(s => ids.includes(s.id) ? { ...s, exclude_from_stats: excluded } : s));
    try {
      const res = await fetch('/api/ebay/sold-orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, exclude_from_stats: excluded }),
      });
      if (!res.ok) {
        setSales(prev => prev.map(s => ids.includes(s.id) ? { ...s, exclude_from_stats: !excluded } : s));
      }
    } catch {
      setSales(prev => prev.map(s => ids.includes(s.id) ? { ...s, exclude_from_stats: !excluded } : s));
    }
  }

  // Period-scoped rows (P&L ignores the search box so ROI stays apples-to-apples).
  // A ?sku= query (from clicking a purchase) scopes everything to that lot.
  const skuScopedSales = skuFilter
    ? sales.filter(s => (s.sku ?? '') === skuFilter)
    : sales;
  const skuScopedPurchases = skuFilter
    ? purchases.filter(p => (p.sku ?? '') === skuFilter)
    : purchases;
  const periodSales = skuScopedSales.filter(s => isInPeriod(s.sale_date, viewDays));
  const periodStatsSales = periodSales.filter(s => !s.exclude_from_stats);
  const excludedInPeriod = periodSales.length - periodStatsSales.length;
  const periodPurchases = skuScopedPurchases.filter(p => isInPeriod(p.purchase_date, viewDays));
  const periodExpenses = skuFilter ? [] : expenses.filter(e => isInPeriod(e.expense_date, viewDays));

  function expenseSum(category: ExpenseCategory) {
    return periodExpenses
      .filter(e => e.category === category)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
  }

  // Filter table by period + search (excluded rows stay visible unless toggled off)
  const filtered = periodSales.filter(s => {
    if (!showExcluded && s.exclude_from_stats) return false;
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      s.item_title.toLowerCase().includes(q) ||
      (s.sku ?? '').toLowerCase().includes(q) ||
      s.order_number.toLowerCase().includes(q) ||
      (s.buyer ?? '').toLowerCase().includes(q)
    );
  });

  // Lot ROI is a SKU-level number — show it once, on the first in-stats row of each SKU.
  const firstLotRoiRowIds = new Set<string>();
  const seenSkuForRoi = new Set<string>();
  for (const s of filtered) {
    if (!s.sku || s.exclude_from_stats || seenSkuForRoi.has(s.sku)) continue;
    seenSkuForRoi.add(s.sku);
    firstLotRoiRowIds.add(s.id);
  }

  // Period P&L — actual (all-in) costs, skipping sales hidden from stats
  const totalRevenue = periodStatsSales.reduce((s, r) => {
    const c = saleCosts(r);
    return s + c.soldFor + c.buyerShipping;
  }, 0);
  const purchaseCost = periodPurchases.reduce((s, p) => s + Number(p.cost || 0), 0);
  const saleCostTotals = periodStatsSales.reduce(
    (acc, r) => {
      const c = saleCosts(r);
      acc.ebayFees += c.ebayFee;
      acc.advertising += c.advertising;
      acc.shipping += c.shipping;
      acc.supplies += c.supplies;
      return acc;
    },
    { ebayFees: 0, advertising: 0, shipping: 0, supplies: 0 }
  );
  const ebayFees = saleCostTotals.ebayFees + expenseSum('ebay_fees');
  const advertising = saleCostTotals.advertising + expenseSum('advertising');
  const shipping = saleCostTotals.shipping + expenseSum('shipping');
  const supplies = saleCostTotals.supplies + expenseSum('supplies');
  const otherExpenses = expenseSum('other');

  // True COGS: average unit cost × cards actually sold this period.
  // Full-lot allocation (and "bought this period") both charge unsold
  // inventory against profit. Remaining cards stay on the balance sheet.
  let soldCogs = 0;
  let periodQtySoldMatched = 0;
  let remainingInSoldLots = 0;
  let remainingQtyInSoldLots = 0;
  const seenSoldSkus = new Set<string>();
  periodStatsSales.forEach(s => {
    if (!s.sku) return;
    const qty = s.quantity_sold || 1;
    const bandPool = bandPoolBySku.get(s.sku);
    if (bandPool) {
      const c = saleCosts(s);
      soldCogs += saleShareOfBandCogs(bandPool, { quantitySold: qty, soldFor: c.soldFor, net: c.net });
      periodQtySoldMatched += qty;
    } else {
      const unit = unitCostForSku(s.sku);
      if (unit == null) return;
      soldCogs += unit * qty;
      periodQtySoldMatched += qty;
    }
    if (!seenSoldSkus.has(s.sku)) {
      seenSoldSkus.add(s.sku);
      const band = bandPoolBySku.get(s.sku);
      const pool = poolBySku.get(s.sku);
      if (band) {
        remainingInSoldLots += band.remainingCost;
        remainingQtyInSoldLots += Math.max((pool?.sellableQty ?? 0) - band.soldQty, 0);
      } else if (pool) {
        remainingInSoldLots += pool.remainingCost;
        remainingQtyInSoldLots += Math.max(pool.sellableQty - pool.soldQty, 0);
      }
    }
  });
  // Unsold remainder of lots bought this period with no sales yet — still
  // inventory, not COGS.
  periodPurchases.forEach(p => {
    if (!p.sku || seenSoldSkus.has(p.sku) || !skuTotalCostMap.has(p.sku)) return;
    seenSoldSkus.add(p.sku);
    const pool = poolBySku.get(p.sku);
    if (pool) {
      remainingInSoldLots += pool.remainingCost;
      remainingQtyInSoldLots += Math.max(pool.sellableQty - pool.soldQty, 0);
    }
  });
  soldCogs = roundMoney(soldCogs);
  remainingInSoldLots = roundMoney(remainingInSoldLots);
  const avgUnitCost = periodQtySoldMatched > 0 ? soldCogs / periodQtySoldMatched : 0;
  const qtyUndercounted = Array.from(seenSoldSkus).some(sku => {
    const pool = poolBySku.get(sku);
    if (pool) return pool.soldQty > pool.sellableQty;
    return (skuQtySoldAllMap.get(sku) ?? 0) > (skuQtyPurchasedMap.get(sku) ?? 0);
  });

  const sellingCosts = ebayFees + advertising + shipping + supplies + otherExpenses;
  const totalCosts = soldCogs + sellingCosts;
  const profit = totalRevenue - totalCosts;
  const actualRoiPct = roiPct(profit, soldCogs);
  const roiExCostsPct = roiPct(totalRevenue - soldCogs, soldCogs);
  const avgSale = periodStatsSales.length ? totalRevenue / periodStatsSales.length : 0;
  const matched = periodStatsSales.filter(s => s.sku && skuTotalCostMap.has(s.sku)).length;

  return (
    <div className="h-full flex flex-col bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="flex-none border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-white">eBay Sales</h1>
            <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
              <span>
                {skuFilter
                  ? 'Every sale matched to this purchase'
                  : 'Sync orders and label costs from the buttons on the right'}
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
              disabled={syncing || refreshingLabels}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition"
            >
              {syncing ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Syncing…
                </>
              ) : (
                <>🔄 Sync orders</>
              )}
            </button>
            <button
              onClick={handleRefreshLabels}
              disabled={syncing || refreshingLabels}
              title="Pull Seller Hub selling costs: transaction fees, ad fees, and seller-paid labels"
              className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg border border-gray-700 transition"
            >
              {refreshingLabels ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Labels…
                </>
              ) : (
                <>📦 Refresh eBay costs</>
              )}
            </button>
          </div>
        </div>

        {syncMsg && (
          <div className={`mb-3 px-4 py-2 rounded-lg text-sm ${syncMsg.startsWith('✓') ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
            {syncMsg}
          </div>
        )}

        {skuFilter && (
          <div className="mb-3 flex items-center gap-3 px-3 py-2 rounded-lg bg-green-500/10 border border-green-500/20">
            <span className="text-sm text-green-400 shrink-0">Sales from purchase</span>
            <span className="text-[11px] text-gray-300 font-mono bg-gray-800 px-2 py-0.5 rounded truncate">
              {skuFilter}
            </span>
            {skuMap.get(skuFilter) && (
              <span className="text-xs text-gray-400 truncate">
                {(purchasesBySku.get(skuFilter)?.length ?? 0) > 1
                  ? `${purchasesBySku.get(skuFilter)!.length} lots pooled`
                  : [skuMap.get(skuFilter)!.brand, skuMap.get(skuFilter)!.series].filter(Boolean).join(' ')}
              </span>
            )}
            {bandPoolBySku.get(skuFilter) && (
              <span className="flex items-center gap-1.5 shrink-0 hidden lg:flex">
                {bandPoolBySku.get(skuFilter)!.bands.filter(b => b.qty > 0).map(b => (
                  <span
                    key={b.id}
                    className={`text-[10px] px-1.5 py-0.5 rounded ${PRICE_BAND_TONE[b.id]}`}
                    title={`${b.label} ${b.hint}: ${b.qty} sold · net $${b.net.toFixed(2)} · cost $${b.cost.toFixed(2)} · ${b.unitCost.toFixed(2)}/card`}
                  >
                    {b.label} {b.qty} {formatRoiPct(b.realizedRoi, 0)}
                  </span>
                ))}
              </span>
            )}
            {poolBySku.get(skuFilter) && (() => {
              const pool = poolBySku.get(skuFilter)!;
              return (
                <span className="text-xs text-gray-400 shrink-0 hidden md:inline">
                  Sales ${pool.totalNetSales.toFixed(2)}
                  <span className={`ml-2 ${roiToneClass(pool.realizedRoi)}`} title={ROI_HELP.realized}>
                    Realized {formatRoiPct(pool.realizedRoi)}
                  </span>
                  <span className={`ml-2 ${roiToneClass(pool.lotToDateRoi)}`} title={ROI_HELP.lotToDate}>
                    Lot-to-date {formatRoiPct(pool.lotToDateRoi)}
                  </span>
                  <span className="ml-2 text-gray-500">
                    {pool.soldQty} sold / {pool.sellableQty} sellable
                  </span>
                </span>
              );
            })()}
            <span className="text-xs text-gray-500 shrink-0">
              {filtered.length} sale{filtered.length === 1 ? '' : 's'}
            </span>
            <a
              href={`/purchases?sku=${encodeURIComponent(skuFilter)}`}
              className="ml-auto text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800 transition shrink-0"
            >
              Back to purchase
            </a>
            <button
              type="button"
              onClick={() => router.replace('/sales')}
              className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-800 transition shrink-0"
            >
              Show all sales
            </button>
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
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowExpenses(true)}
              className="px-2.5 py-1 rounded-md text-xs font-medium bg-gray-900 text-gray-300 hover:text-white border border-gray-800 transition"
            >
              Track expenses
            </button>
            <button
              type="button"
              onClick={() => setShowDefaults(true)}
              className="px-2.5 py-1 rounded-md text-xs font-medium bg-gray-900 text-gray-300 hover:text-white border border-gray-800 transition"
            >
              Cost defaults
            </button>
          </div>
        </div>

        {/* Headline P&L */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-3">
          {[
            {
              label: 'Sales Revenue',
              value: fmt$(totalRevenue),
              sub: `${periodStatsSales.length} sale${periodStatsSales.length === 1 ? '' : 's'} · avg ${fmt$(avgSale)}${excludedInPeriod ? ` · ${excludedInPeriod} hidden` : ''}${matched < periodStatsSales.length ? ` · ${matched}/${periodStatsSales.length} matched` : ''}`,
              color: 'text-green-400',
            },
            {
              label: 'Total Costs',
              value: fmt$(totalCosts),
              sub: 'sold-card cost + fees + ads + ship + supplies',
              color: 'text-orange-400',
            },
            {
              label: 'Net Profit',
              value: `${profit >= 0 ? '' : '−'}${fmt$(Math.abs(profit))}`,
              sub: 'revenue − sold-card cost − selling costs',
              color: profit > 0 ? 'text-green-400' : profit < 0 ? 'text-red-400' : 'text-gray-400',
            },
            {
              label: 'Actual ROI',
              value: actualRoiPct === null ? '—' : `${actualRoiPct > 0 ? '+' : ''}${actualRoiPct.toFixed(1)}%`,
              sub: soldCogs > 0 ? 'realized: net vs cost of cards sold' : 'no matched lots in period',
              color:
                actualRoiPct === null
                  ? 'text-gray-400'
                  : actualRoiPct > 0
                    ? 'text-green-400'
                    : actualRoiPct < 0
                      ? 'text-red-400'
                      : 'text-gray-400',
            },
            {
              label: 'ROI ex-costs',
              value: roiExCostsPct === null ? '—' : `${roiExCostsPct > 0 ? '+' : ''}${roiExCostsPct.toFixed(1)}%`,
              sub: soldCogs > 0 ? 'sales vs cost of cards sold' : 'no matched lots in period',
              color:
                roiExCostsPct === null
                  ? 'text-gray-400'
                  : roiExCostsPct > 0
                    ? 'text-green-400'
                    : roiExCostsPct < 0
                      ? 'text-red-400'
                      : 'text-gray-400',
            },
          ].map(s => (
            <div key={s.label} className="bg-gray-900 border border-gray-800 rounded-lg px-4 py-3">
              <p className="text-[11px] text-gray-500 uppercase tracking-wider">{s.label}</p>
              <p className={`text-xl font-bold mt-0.5 ${s.color}`}>{s.value}</p>
              <p className="text-[10px] text-gray-600 mt-0.5">{s.sub}</p>
            </div>
          ))}
        </div>

        {/* Cost breakdown */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-7 gap-3 mb-4">
          {[
            {
              label: 'Cost of goods sold',
              value: fmt$(soldCogs),
              title: 'Allocated cost of cards sold this period. Unsold cards are not an expense.',
              sub: soldCogs > 0
                ? `${periodQtySoldMatched} card${periodQtySoldMatched === 1 ? '' : 's'} × avg ${fmt$(avgUnitCost)}${qtyUndercounted ? ' · check lot qty' : ''}`
                : matched < periodStatsSales.length
                  ? `${periodStatsSales.length - matched} sale${periodStatsSales.length - matched === 1 ? '' : 's'} unmatched`
                  : 'no matched lots in period',
            },
            {
              label: 'Still on hand',
              value: fmt$(remainingInSoldLots),
              title: 'Unsold remainder of lots you sold from or bought this period, at remaining allocated cost.',
              sub: remainingQtyInSoldLots > 0
                ? `${remainingQtyInSoldLots} unsold card${remainingQtyInSoldLots === 1 ? '' : 's'} in those lots`
                : qtyUndercounted
                  ? 'lot qty looks low — edit purchases'
                  : 'lots from these sales are fully sold',
            },
            {
              label: 'Bought this period',
              value: fmt$(purchaseCost),
              title: 'Cash spent on purchases in this period. Not subtracted from profit until those cards sell.',
              sub: 'cash outlay · unsold stays on hand',
            },
            {
              label: 'eBay Fees',
              value: fmt$(ebayFees),
              sub: expenseSum('ebay_fees') > 0 ? `incl. ${fmt$(expenseSum('ebay_fees'))} logged` : 'final value + processing',
            },
            {
              label: 'Advertising',
              value: fmt$(advertising),
              sub: expenseSum('advertising') > 0 ? `incl. ${fmt$(expenseSum('advertising'))} logged` : 'from eBay Finances only',
            },
            {
              label: 'Shipping',
              value: fmt$(shipping),
              sub: expenseSum('shipping') > 0
                ? `incl. ${fmt$(expenseSum('shipping'))} logged`
                : periodStatsSales.some(s => s.shipping_cost == null && firstSaleIdByOrder.get(s.order_number) === s.id)
                  ? 'pending labels not in ROI yet'
                  : 'seller-paid eBay labels',
            },
            {
              label: 'Supplies',
              value: fmt$(supplies),
              sub: otherExpenses > 0
                ? `+ ${fmt$(otherExpenses)} other`
                : expenseSum('supplies') > 0
                  ? `incl. ${fmt$(expenseSum('supplies'))} logged`
                  : 'sleeves, mailers, etc.',
            },
          ].map(s => (
            <div key={s.label} className="bg-gray-900/70 border border-gray-800 rounded-lg px-3 py-2.5" title={'title' in s ? s.title : undefined}>
              <p className="text-[10px] text-gray-500 uppercase tracking-wider">{s.label}</p>
              <p className="text-sm font-semibold mt-0.5 text-gray-200 tabular-nums">{s.value}</p>
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
              placeholder={skuFilter ? 'Search within this purchase…' : 'Search by title, SKU, order #, buyer…'}
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>

          {excludedInPeriod > 0 && (
            <button
              type="button"
              onClick={() => setShowExcluded(v => !v)}
              className={`shrink-0 px-2.5 py-1.5 rounded-md text-xs font-medium border transition ${showExcluded
                ? 'bg-amber-900/20 text-amber-300 border-amber-500/30'
                : 'bg-gray-900 text-gray-400 border-gray-800 hover:text-white'
                }`}
              title={showExcluded ? 'Excluded sales are dimmed in the table but omitted from revenue/ROI' : 'Show excluded sales in the table'}
            >
              {showExcluded ? `Showing ${excludedInPeriod} hidden` : `${excludedInPeriod} hidden from stats`}
            </button>
          )}

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
              <button
                type="button"
                onClick={() => {
                  const ids = Array.from(selectedSales);
                  const allHidden = ids.every(id => sales.find(s => s.id === id)?.exclude_from_stats);
                  handleExcludeFromStats(ids, !allHidden);
                  setSelectedSales(new Set());
                }}
                className="px-3 py-1 bg-gray-800 hover:bg-gray-700 text-white text-sm font-medium rounded transition border border-gray-600"
                title="Omit selected sales from revenue, costs, and ROI"
              >
                {Array.from(selectedSales).every(id => sales.find(s => s.id === id)?.exclude_from_stats)
                  ? 'Include in stats'
                  : 'Hide from stats'}
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
                : skuFilter && skuScopedSales.length === 0
                  ? 'No sales matched to this purchase yet.'
                  : search
                    ? 'No sales match your search.'
                    : !showExcluded && excludedInPeriod > 0
                      ? 'Hidden sales are filtered out of the table — click “hidden from stats” to show them.'
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
                <th className="px-3 py-3">eBay Fee</th>
                <th className="px-3 py-3">Ads</th>
                <th className="px-3 py-3">Ship</th>
                <th className="px-3 py-3">Supplies</th>
                <th
                  className="px-3 py-3"
                  title="After eBay fees, ads, labels, and supplies. Does not subtract what you paid for the card."
                >
                  Net
                </th>
                <th
                  className="px-3 py-3"
                  title="This sale’s share of the pool basis (allocated cost of the card sold)."
                >
                  Card cost
                </th>
                <th
                  className="px-3 py-3"
                  title={ROI_HELP.realized}
                >
                  Realized
                </th>
                <th
                  className="px-3 py-3"
                  title={ROI_HELP.lotToDate}
                >
                  Lot-to-date
                </th>
                <th className="px-3 py-3">Shipped</th>
                <th className="px-3 py-3 w-16">Stats</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(sale => {
                const match = sale.sku ? skuMap.get(sale.sku) : null;
                const isOrderHead = firstSaleIdByOrder.get(sale.order_number) === sale.id;
                const costs = saleCosts(sale);
                const excluded = !!sale.exclude_from_stats;
                const showLotRoi = firstLotRoiRowIds.has(sale.id);
                return (
                  <tr
                    key={sale.id}
                    className={`border-b border-gray-800/60 hover:bg-gray-800/40 transition ${selectedSales.has(sale.id) ? 'bg-blue-900/10' : ''} ${excluded ? 'opacity-40' : ''}`}
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
                      {excluded && (
                        <div className="text-[10px] text-amber-400/80 mt-0.5">Hidden from revenue / ROI</div>
                      )}
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
                          <span>
                            {(purchasesBySku.get(sale.sku!)?.length ?? 0) > 1
                              ? `${sale.sku} · ${purchasesBySku.get(sale.sku!)!.length} lots`
                              : [match.brand, match.series].filter(Boolean).join(' ') || sale.sku}
                          </span>
                        </a>
                      ) : (
                        <span className="text-gray-700 text-xs">—</span>
                      )}
                    </td>

                    {/* Qty */}
                    <td className="px-3 py-3 text-sm text-gray-400 tabular-nums">
                      {sale.quantity_sold}
                    </td>

                    {/* Sold For (item). Buyer-paid shipping is added into Net. */}
                    <td className="px-3 py-3 text-sm text-green-400 font-semibold tabular-nums">
                      {fmt$(sale.sold_for)}
                      {isOrderHead && costs.buyerShipping > 0 && (
                        <div className="text-[10px] font-normal text-gray-500">
                          +{fmt$(costs.buyerShipping)} ship
                        </div>
                      )}
                    </td>

                    {/* eBay Fee */}
                    <td className="px-3 py-3">
                      <CostCell saleId={sale.id} field="ebay_fee" value={sale.ebay_fee ?? null} fallback={costs.ebayFee} onSaved={handleCostSaved} />
                    </td>

                    {/* Ads */}
                    <td className="px-3 py-3">
                      <CostCell
                        saleId={sale.id}
                        field="advertising_fee"
                        value={sale.advertising_fee ?? null}
                        fallback={0}
                        pendingLabel="—"
                        pendingTitle="Only filled when eBay Finances reports a promoted-listing fee. Click to set."
                        onSaved={handleCostSaved}
                      />
                    </td>

                    {/* Ship */}
                    <td className="px-3 py-3">
                      <CostCell
                        saleId={sale.id}
                        field="shipping_cost"
                        value={sale.shipping_cost ?? null}
                        fallback={0}
                        pendingLabel={isOrderHead ? 'pending' : '—'}
                        pendingTitle={
                          isOrderHead
                            ? 'Seller-paid label not posted yet. eBay often charges eSE hours later. Click to set.'
                            : 'Share of the order label fills from eBay. Click to set.'
                        }
                        onSaved={handleCostSaved}
                      />
                    </td>

                    {/* Supplies */}
                    <td className="px-3 py-3">
                      <CostCell saleId={sale.id} field="supplies_cost" value={sale.supplies_cost ?? null} fallback={costs.supplies} onSaved={handleCostSaved} />
                    </td>

                    {/* Net after selling costs */}
                    <td className={`px-3 py-3 text-sm font-medium tabular-nums ${costs.net >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      {fmt$(costs.net)}
                    </td>

                    {/* Card cost of this sale (this card’s share of pool basis) */}
                    <td className="px-3 py-3 text-sm text-gray-300 tabular-nums">
                      {(() => {
                        if (!sale.sku) return <span className="text-gray-600 italic text-xs">no match</span>;
                        const pool = poolForSku(sale.sku);
                        if (!pool) return <span className="text-gray-600 italic text-xs">no match</span>;
                        const qty = sale.quantity_sold || 1;
                        const linkedId = saleToPoolItem.get(sale.id);
                        const linked = pool.allocatedLines.find(l => l.id === linkedId);
                        const bandPool = sale.sku ? bandPoolBySku.get(sale.sku) : undefined;
                        const band = bandPool
                          ? classifyPriceBand(costs.soldFor / Math.max(qty, 1))
                          : null;
                        const cogs = linked
                          ? roundMoney(linked.allocatedCost)
                          : bandPool
                            ? saleShareOfBandCogs(bandPool, { quantitySold: qty, soldFor: costs.soldFor, net: costs.net })
                            : saleShareOfPoolCogs(pool, qty);
                        const items = (purchasesBySku.get(sale.sku) ?? []).flatMap(p => p.items ?? []);
                        return (
                          <div className="flex flex-col gap-0.5">
                            <span
                              title={
                                linked
                                  ? `${linked.label || 'pool card'} basis ${fmt$(cogs)}`
                                  : band
                                    ? `${band.label} ${band.hint}: ${fmt$(cogs)} basis`
                                    : `sold cost ${fmt$(pool.costOfSold)} ÷ ${pool.soldQty} sold = ${fmt$(cogs)} each`
                              }
                            >
                              {fmt$(cogs)}
                            </span>
                            {band && (
                              <span className={`self-start text-[9px] px-1 py-px rounded ${PRICE_BAND_TONE[band.id]}`}>
                                {band.label}
                              </span>
                            )}
                            {items.length > 0 && (
                              <select
                                className="bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-[10px] text-gray-400 max-w-[140px]"
                                value={linkedId ?? ''}
                                onChange={async e => {
                                  const poolItemId = e.target.value || null;
                                  await fetch('/api/ebay/sold-orders', {
                                    method: 'PATCH',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({ id: sale.id, pool_item_id: poolItemId }),
                                  });
                                  loadPurchases();
                                }}
                                title="Match this sale to a specific pool card"
                              >
                                <option value="">avg basis</option>
                                {items.map(it => (
                                  <option key={it.id} value={it.id}>
                                    {it.label || POOL_ITEM_STATUS_LABELS[it.status] || it.id.slice(0, 6)}
                                  </option>
                                ))}
                              </select>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    {/* Realized ROI — once per SKU */}
                    <td
                      className="px-3 py-3 text-sm tabular-nums"
                      title={!showLotRoi && sale.sku ? 'Pool ROI is shown on the first sale of this SKU' : ROI_HELP.realized}
                    >
                      {(() => {
                        if (!showLotRoi) {
                          return <span className="sr-only">same lot as first {sale.sku} row</span>;
                        }
                        const pool = poolForSku(sale.sku!);
                        const roi = pool?.realizedRoi ?? null;
                        if (roi == null) return <span className="text-gray-600">—</span>;
                        return (
                          <span
                            className={`font-medium ${roiToneClass(roi)}`}
                            title={`${sale.sku}: ${pool!.soldQty} sold · net ${fmt$(pool!.totalNetSales)} − sold cost ${fmt$(pool!.costOfSold)} = ${fmt$(pool!.realizedProfit)}`}
                          >
                            {formatRoiPct(roi, 1)}
                          </span>
                        );
                      })()}
                    </td>

                    {/* Lot-to-date ROI — once per SKU */}
                    <td
                      className="px-3 py-3 text-sm tabular-nums"
                      title={!showLotRoi && sale.sku ? 'Pool ROI is shown on the first sale of this SKU' : ROI_HELP.lotToDate}
                    >
                      {(() => {
                        if (!showLotRoi) {
                          return <span className="sr-only">same lot as first {sale.sku} row</span>;
                        }
                        const pool = poolForSku(sale.sku!);
                        const roi = pool?.lotToDateRoi ?? null;
                        if (roi == null) return <span className="text-gray-600">—</span>;
                        return (
                          <span
                            className={`font-medium ${roiToneClass(roi)}`}
                            title={`${sale.sku}: net ${fmt$(pool!.totalNetSales)} vs full buy ${fmt$(pool!.purchaseCost)} · recovered ${pool!.recoveredPct == null ? '—' : `${Math.round(pool!.recoveredPct)}%`}`}
                          >
                            {formatRoiPct(roi, 1)}
                          </span>
                        );
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

                    <td className="px-3 py-3">
                      <button
                        type="button"
                        onClick={() => handleExcludeFromStats([sale.id], !excluded)}
                        title={excluded ? 'Include this sale in revenue and ROI' : 'Hide this sale from revenue and ROI'}
                        className={`text-xs px-2 py-0.5 rounded border transition ${excluded
                          ? 'text-amber-300 border-amber-500/40 bg-amber-900/20 hover:bg-amber-900/40'
                          : 'text-gray-500 border-gray-800 hover:text-white hover:border-gray-600'
                          }`}
                      >
                        {excluded ? 'Show' : 'Hide'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showExpenses && (
        <ExpensePanel
          expenses={expenses}
          onChanged={loadExpenses}
          onClose={() => setShowExpenses(false)}
        />
      )}
      {showDefaults && (
        <DefaultsPanel
          settings={settings}
          onSaved={async (next, filled) => {
            setSettings(next);
            if (filled > 0) {
              const res = await fetch('/api/ebay/sold-orders?sync=false');
              const data = await res.json();
              setSales(data.sales ?? []);
              setSyncMsg(`✓ Applied cost defaults to ${filled} sale${filled === 1 ? '' : 's'}.`);
            }
          }}
          onClose={() => setShowDefaults(false)}
        />
      )}
    </div>
  );
}

export default function SalesPage() {
  return (
    <Suspense fallback={<div className="h-full flex items-center justify-center bg-gray-950 text-gray-500 text-sm">Loading…</div>}>
      <SalesPageContent />
    </Suspense>
  );
}
