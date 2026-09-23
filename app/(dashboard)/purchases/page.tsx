'use client';

import { Suspense, useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  DEFAULT_PNL_SETTINGS,
  resolvedSaleCosts,
  type PnlSettings,
} from '@/app/lib/pnl';
import { orderHeadIds, ordersWithDuplicatedBuyerShipping } from '@/app/lib/order-costs';
import {
  ALLOCATION_MODE_LABELS,
  ALLOCATION_MODES,
  POOL_ITEM_STATUS_LABELS,
  POOL_ITEM_STATUSES,
  ROI_HELP,
  allocateLines,
  computePoolMetrics,
  defaultAllocationMode,
  formatRoiPct,
  parseAllocationMode,
  poolInputFromPurchases,
  roiToneClass,
  sumAllocatedCost,
  type AllocationMode,
  type PoolItemStatus,
  type PoolLine,
  type PoolMetrics,
} from '@/app/lib/pool-roi';
import {
  PRICE_BAND_TONE,
  computePriceBandPool,
  usesPriceBands,
  type PriceBandPool,
} from '@/app/lib/price-bands';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolItem {
  id: string;
  purchase_id?: string;
  label: string | null;
  estimated_value: number;
  allocated_cost: number | null;
  status: PoolItemStatus;
  qty: number;
  sale_id: string | null;
}

interface Purchase {
  id: string;
  purchase_date: string;
  year: number | null;
  brand: string | null;
  series: string | null;
  sport: string | null;
  team: string | null;
  box_size: string | null;
  cost: number;
  quantity: number;
  sku: string | null;
  bought_from: string | null;
  notes: string | null;
  created_at: string;
  allocation_mode: AllocationMode;
  expected_bulk_recovery: number;
  items: PoolItem[];
}

interface SkuGroup {
  sku: string | null;
  purchases: Purchase[];
  totalCost: number;
  totalSales: number;
  totalQuantity: number;
  quantitySold: number;
  metrics: PoolMetrics;
  bandPool: PriceBandPool | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BRANDS = ['Panini', 'Topps', 'Bowman', 'Upper Deck', 'Mix', 'Lot', 'Other'];
const SPORTS = ['Basketball', 'Football', 'Baseball', 'Soccer', 'Hockey', 'UFC', 'Other'];
const BOX_SIZES = ['Lot', 'Value x 3', 'Value x 4', 'Value x 5', 'Blaster', 'Hobby', 'Mega', 'Retail', 'Other'];
const SOURCES = ['eBay', 'Amazon', 'Mercari', 'Whatnot', 'Local', 'Other'];

const EMPTY_FORM = {
  purchase_date: new Date().toISOString().split('T')[0],
  year: '',
  brand: '',
  series: '',
  sport: '',
  team: '',
  box_size: '',
  cost: '',
  quantity: '1',
  sku: '',
  bought_from: 'eBay',
  notes: '',
  allocation_mode: 'equal' as AllocationMode,
  expected_bulk_recovery: '0',
};

type FormLine = {
  key: string;
  id?: string;
  label: string;
  estimated_value: string;
  allocated_cost: string;
  status: PoolItemStatus;
  qty: string;
};

function emptyFormLine(status: PoolItemStatus = 'in_stock'): FormLine {
  return {
    key: `tmp-${Math.random().toString(36).slice(2, 9)}`,
    label: status === 'bulk_leftover' ? 'Bulk leftover' : '',
    estimated_value: '',
    allocated_cost: '',
    status,
    qty: '1',
  };
}

function itemsToFormLines(items: PoolItem[] | undefined): FormLine[] {
  if (!items?.length) return [];
  return items.map(it => ({
    key: it.id,
    id: it.id,
    label: it.label ?? '',
    estimated_value: it.estimated_value != null ? String(it.estimated_value) : '',
    allocated_cost: it.allocated_cost != null ? String(it.allocated_cost) : '',
    status: it.status,
    qty: String(it.qty || 1),
  }));
}

// ─── CSV Import Modal ─────────────────────────────────────────────────────────

function CsvImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const HEADERS = ['purchase_date', 'year', 'brand', 'series', 'sport', 'team', 'box_size', 'cost', 'quantity', 'sku', 'bought_from'];

  function parseCSV(raw: string) {
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length < 2) return [];
    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, ''));
    return lines.slice(1).map(line => {
      const cols = line.split('\t');
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = (cols[i] || '').trim(); });
      return row;
    });
  }

  function handlePaste(val: string) {
    setCsv(val);
    setError('');
    try {
      setPreview(parseCSV(val).slice(0, 5));
    } catch { setPreview([]); }
  }

  async function handleImport() {
    setImporting(true);
    setError('');
    try {
      const rows = parseCSV(csv).map(r => ({
        purchase_date: r.purchase_date || new Date().toISOString().split('T')[0],
        year: r.year ? parseInt(r.year) : null,
        brand: r.brand || null,
        series: r.series || null,
        sport: r.sport || null,
        team: r.team || null,
        box_size: r.box_size || null,
        cost: parseFloat(r.cost?.replace(/[^0-9.]/g, '') || '0') || 0,
        quantity: parseInt(r.quantity || '1') || 1,
        sku: r.sku || r.reference_number || null,
        bought_from: r.bought_from || 'eBay',
        notes: r.notes || null,
      }));
      const res = await fetch('/api/purchases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onImported();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Import failed');
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl shadow-2xl">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <div>
            <h2 className="text-white font-semibold text-lg">CSV / Spreadsheet Import</h2>
            <p className="text-gray-500 text-xs mt-0.5">Paste tab-separated rows from your spreadsheet</p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl transition">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Header hint */}
          <div className="bg-gray-800/60 rounded-lg p-3 font-mono text-[11px] text-gray-400 overflow-x-auto whitespace-nowrap">
            {HEADERS.join('\t')}
          </div>

          <textarea
            className="w-full h-40 bg-gray-800 border border-gray-700 rounded-lg p-3 text-xs text-gray-200 font-mono resize-none focus:outline-none focus:border-green-500 transition"
            placeholder="Paste your spreadsheet rows here (tab-separated, with header row)…"
            value={csv}
            onChange={e => handlePaste(e.target.value)}
          />

          {preview.length > 0 && (
            <div>
              <p className="text-[11px] text-gray-500 mb-2">Preview ({preview.length} of {parseCSV(csv).length} rows)</p>
              <div className="bg-gray-800/60 rounded-lg p-3 overflow-x-auto">
                <table className="text-[11px] text-gray-300 w-full">
                  <thead>
                    <tr className="text-gray-500">
                      {Object.keys(preview[0]).map(h => <th key={h} className="text-left pr-4 pb-1">{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((r, i) => (
                      <tr key={i}>
                        {Object.values(r).map((v, j) => <td key={j} className="pr-4 py-0.5 whitespace-nowrap">{v}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {error && <p className="text-red-400 text-xs">{error}</p>}
        </div>

        <div className="flex justify-end gap-3 px-5 pb-5">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
          <button
            onClick={handleImport}
            disabled={importing || !csv.trim()}
            className="px-5 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition"
          >
            {importing ? 'Importing…' : `Import ${csv.trim() ? parseCSV(csv).length : 0} rows`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Form Helpers ─────────────────────────────────────────────────────────────

const inputCls = 'w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500 transition';

function Field({
  label,
  value,
  onChange,
  type = 'text',
  placeholder = '',
  inputMode,
  maxLength,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  type?: string;
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  maxLength?: number;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        inputMode={inputMode}
        maxLength={maxLength}
        className={inputCls}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  options: string[];
}) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <select
        className={inputCls}
        value={value}
        onChange={e => onChange(e.target.value)}
      >
        <option value="">— select —</option>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

function PoolLinesEditor({
  mode,
  cost,
  bulkRecovery,
  lines,
  onChange,
}: {
  mode: AllocationMode;
  cost: number;
  bulkRecovery: number;
  lines: FormLine[];
  onChange: (lines: FormLine[]) => void;
}) {
  const poolLines: PoolLine[] = lines.map(l => ({
    id: l.id,
    label: l.label,
    estimatedValue: parseFloat(l.estimated_value) || 0,
    allocatedCostOverride: l.allocated_cost === '' ? null : parseFloat(l.allocated_cost),
    status: l.status,
    qty: parseInt(l.qty, 10) || 1,
  }));
  const allocated = allocateLines({
    purchaseCost: cost,
    sellableQty: poolLines.reduce((s, l) => s + l.qty, 0) || 1,
    soldQty: 0,
    totalNetSales: 0,
    allocationMode: mode,
    expectedBulkRecovery: bulkRecovery,
    lines: poolLines,
  });
  const allocatedSum = sumAllocatedCost(allocated);
  const drift = Math.round((allocatedSum - cost) * 100) / 100;

  function patch(key: string, field: keyof FormLine, val: string) {
    onChange(lines.map(l => l.key === key ? { ...l, [field]: val } : l));
  }

  return (
    <div className="col-span-2 space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs text-gray-400">
          Pool cards
          <span className="ml-2 text-[10px] text-gray-600">
            {mode === 'weighted' ? 'Estimated values weight the basis' : 'Hits share cost minus bulk recovery'}
          </span>
        </label>
        <span className={`text-[10px] ${Math.abs(drift) < 0.01 ? 'text-gray-500' : 'text-yellow-400'}`}>
          Allocated {allocatedSum.toFixed(2)} / {cost.toFixed(2)}
        </span>
      </div>
      {lines.length === 0 && (
        <p className="text-[11px] text-gray-600">
          {mode === 'residual'
            ? 'Optional. Without rows, hits equal-split (cost − bulk recovery). Add rows to value-weight hits.'
            : 'Add a row per card (or per group of similar cards) with an estimated value.'}
        </p>
      )}
      {lines.map((l, i) => (
        <div key={l.key} className="grid grid-cols-12 gap-1.5 items-center">
          <input
            className={`${inputCls} col-span-3 py-1.5 text-xs`}
            placeholder={l.status === 'bulk_leftover' ? 'Bulk leftover' : 'Label'}
            value={l.label}
            onChange={e => patch(l.key, 'label', e.target.value)}
          />
          <input
            className={`${inputCls} col-span-2 py-1.5 text-xs`}
            placeholder="Est. $"
            inputMode="decimal"
            value={l.estimated_value}
            onChange={e => patch(l.key, 'estimated_value', e.target.value)}
            title="Estimated value — used to weight basis"
          />
          <select
            className={`${inputCls} col-span-3 py-1.5 text-xs`}
            value={l.status}
            onChange={e => patch(l.key, 'status', e.target.value as PoolItemStatus)}
          >
            {POOL_ITEM_STATUSES.map(s => (
              <option key={s} value={s}>{POOL_ITEM_STATUS_LABELS[s]}</option>
            ))}
          </select>
          <input
            className={`${inputCls} col-span-2 py-1.5 text-xs text-gray-400`}
            placeholder={`$${allocated[i]?.allocatedCost.toFixed(2) ?? '0.00'}`}
            inputMode="decimal"
            value={l.allocated_cost}
            onChange={e => patch(l.key, 'allocated_cost', e.target.value)}
            title="Override allocated cost. Leave blank to use computed basis."
          />
          <button
            type="button"
            onClick={() => onChange(lines.filter(x => x.key !== l.key))}
            className="col-span-2 text-[11px] text-red-500 hover:text-red-400"
          >
            Remove
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange([...lines, emptyFormLine('in_stock')])}
          className="text-[11px] text-blue-400 hover:text-blue-300"
        >
          + Add card
        </button>
        {mode === 'residual' && !lines.some(l => l.status === 'bulk_leftover') && (
          <button
            type="button"
            onClick={() => onChange([...lines, emptyFormLine('bulk_leftover')])}
            className="text-[11px] text-yellow-400 hover:text-yellow-300"
          >
            + Bulk leftover row
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Purchase Form Modal ──────────────────────────────────────────────────────

function PurchaseModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Purchase | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState(
    initial
      ? {
        purchase_date: initial.purchase_date,
        year: initial.year?.toString() ?? '',
        brand: initial.brand ?? '',
        series: initial.series ?? '',
        sport: initial.sport ?? '',
        team: initial.team ?? '',
        box_size: initial.box_size ?? '',
        cost: initial.cost?.toString() ?? '',
        quantity: initial.quantity?.toString() ?? '1',
        sku: initial.sku ?? '',
        bought_from: initial.bought_from ?? 'eBay',
        notes: initial.notes ?? '',
        allocation_mode: parseAllocationMode(initial.allocation_mode),
        expected_bulk_recovery: (initial.expected_bulk_recovery ?? 0).toString(),
      }
      : { ...EMPTY_FORM }
  );
  const [lines, setLines] = useState<FormLine[]>(itemsToFormLines(initial?.items));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Track whether the user has manually edited the SKU so we don't overwrite it.
  const [skuLocked, setSkuLocked] = useState(!!initial?.sku);
  const [modeLocked, setModeLocked] = useState(!!initial?.id);

  // ── SKU auto-generation: YEAR-BRAND-SERIES-SPORT (spaces→_, uppercase) ──
  function buildAutoSku(year: string, brand: string, series: string, sport: string): string {
    const clean = (s: string) => s.trim().toUpperCase().replace(/\s+/g, '_');
    const parts = [year.trim(), clean(brand), clean(series), clean(sport)].filter(Boolean);
    return parts.join('-');
  }

  // Unified field setter — auto-fills SKU when relevant fields change
  function set(key: string, val: string) {
    setForm(f => {
      const next = { ...f, [key]: val };

      // Rebuild SKU from formula whenever year/brand/series/sport change,
      // unless the user has manually locked the SKU field.
      if (['year', 'brand', 'series', 'sport'].includes(key) && !skuLocked) {
        next.sku = buildAutoSku(next.year, next.brand, next.series, next.sport);
      }

      if (key === 'box_size' && !modeLocked) {
        next.allocation_mode = defaultAllocationMode(val);
      }

      return next;
    });
  }

  function handleSkuChange(val: string) {
    setSkuLocked(true); // user is manually editing — stop auto-fill
    setForm(f => ({ ...f, sku: val }));
  }

  function handleSkuClear() {
    // If user clears the SKU field, re-enable auto-fill
    setSkuLocked(false);
    setForm(f => ({
      ...f,
      sku: buildAutoSku(f.year, f.brand, f.series, f.sport),
    }));
  }

  async function handleSave() {
    if (!form.purchase_date || !form.cost) { setError('Date and cost are required.'); return; }
    setSaving(true);
    setError('');
    try {
      const method = initial ? 'PATCH' : 'POST';
      const items = lines.map(l => ({
        id: l.id,
        label: l.label || null,
        estimated_value: parseFloat(l.estimated_value) || 0,
        allocated_cost: l.allocated_cost === '' ? null : parseFloat(l.allocated_cost),
        status: l.status,
        qty: parseInt(l.qty, 10) || 1,
      }));
      const body = initial
        ? { id: initial.id, ...form, items }
        : { ...form, items };
      const res = await fetch('/api/purchases', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl shadow-2xl overflow-y-auto max-h-[90vh]">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="text-white font-semibold text-lg">{initial ? 'Edit Purchase' : 'Add Purchase'}</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-xl transition">✕</button>
        </div>

        <div className="p-5 grid grid-cols-2 gap-4">
          <Field label="Purchase Date *" value={form.purchase_date} onChange={v => set('purchase_date', v)} type="date" />
          <Field label="Cost ($) *" value={form.cost} onChange={v => set('cost', v)} type="number" inputMode="decimal" placeholder="0.00" />
          <div>
            <label className="block text-xs text-gray-400 mb-1" title={ROI_HELP.sellableQty}>Sellable cards</label>
            <input
              type="number"
              inputMode="numeric"
              className={inputCls}
              placeholder="1"
              value={form.quantity}
              onChange={e => set('quantity', e.target.value.replace(/\D/g, ''))}
            />
            <p className="text-[10px] text-gray-600 mt-1">{ROI_HELP.sellableQty}</p>
          </div>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Allocation</label>
            <select
              className={inputCls}
              value={form.allocation_mode}
              onChange={e => {
                setModeLocked(true);
                set('allocation_mode', e.target.value);
              }}
            >
              {ALLOCATION_MODES.map(m => (
                <option key={m} value={m}>{ALLOCATION_MODE_LABELS[m]}</option>
              ))}
            </select>
            <p className="text-[10px] text-gray-600 mt-1">
              {form.allocation_mode === 'equal' && 'Same-tier singles. Each sellable card gets an equal share of cost.'}
              {form.allocation_mode === 'weighted' && 'Hits and cheap cards in one pool. Basis follows estimated value.'}
              {form.allocation_mode === 'residual' && 'Ripped box / blaster: leftovers get scrap value, hits get the rest.'}
            </p>
          </div>
          {form.allocation_mode === 'residual' && (
            <div>
              <label className="block text-xs text-gray-400 mb-1">Expected bulk recovery ($)</label>
              <input
                type="number"
                inputMode="decimal"
                className={inputCls}
                placeholder="0.00"
                value={form.expected_bulk_recovery}
                onChange={e => set('expected_bulk_recovery', e.target.value)}
              />
              <p className="text-[10px] text-gray-600 mt-1">
                Leftovers sold as one bulk lot. $0 if they will never be sold — hits then carry the full box cost.
              </p>
            </div>
          )}

          {/* Year — text field, numeric keyboard, strips non-digits, max 4 chars */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Card Year</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={4}
              pattern="[0-9]{4}"
              className={inputCls}
              placeholder="2025"
              value={form.year}
              onChange={e => {
                const val = e.target.value.replace(/\D/g, '').slice(0, 4);
                set('year', val);
              }}
            />
          </div>

          {/* Brand */}
          <Select label="Brand" value={form.brand} onChange={v => set('brand', v)} options={BRANDS} />

          {/* Series */}
          <Field label="Series" value={form.series} onChange={v => set('series', v)} placeholder="Optic, Chrome, Prizm WNBA…" />

          {/* Sport */}
          <Select label="Sport" value={form.sport} onChange={v => set('sport', v)} options={SPORTS} />

          {/* SKU — auto-filled from Year·Brand·Series·Sport, user can override */}
          <div className="col-span-2">
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-gray-400">
                SKU
                {!skuLocked ? (
                  <span className="ml-2 text-[10px] text-green-500">✦ auto-filling from Year · Brand · Series · Sport</span>
                ) : (
                  <span className="ml-2 text-[10px] text-yellow-500">✎ manually set</span>
                )}
              </label>
              {skuLocked && (
                <button
                  type="button"
                  onClick={handleSkuClear}
                  className="text-[10px] text-gray-500 hover:text-green-400 transition"
                >
                  ↺ reset to auto
                </button>
              )}
            </div>
            <input
              type="text"
              className={`${inputCls} font-mono ${skuLocked ? 'border-yellow-600/50' : 'border-green-700/50'}`}
              placeholder="2025-PANINI-OPTIC-FOOTBALL"
              value={form.sku}
              onChange={e => handleSkuChange(e.target.value)}
            />
          </div>

          <Field label="Team" value={form.team} onChange={v => set('team', v)} placeholder="optional" />
          <Select label="Box Size" value={form.box_size} onChange={v => set('box_size', v)} options={BOX_SIZES} />
          <Select label="Bought From" value={form.bought_from} onChange={v => set('bought_from', v)} options={SOURCES} />

          {(form.allocation_mode === 'weighted' || form.allocation_mode === 'residual') && (
            <PoolLinesEditor
              mode={form.allocation_mode}
              cost={parseFloat(form.cost) || 0}
              bulkRecovery={parseFloat(form.expected_bulk_recovery) || 0}
              lines={lines}
              onChange={setLines}
            />
          )}

          <div className="col-span-2">
            <label className="block text-xs text-gray-400 mb-1">Notes</label>
            <textarea
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-green-500 transition resize-none"
              rows={2}
              placeholder="optional"
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
            />
          </div>
        </div>

        {error && <p className="text-red-400 text-xs px-5 pb-2">{error}</p>}

        <div className="flex justify-end gap-3 px-5 pb-5">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition">Cancel</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition"
          >
            {saving ? 'Saving…' : initial ? 'Save Changes' : 'Add Purchase'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 1800);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-gray-800 border border-gray-700 text-white text-sm px-4 py-2 rounded-lg shadow-xl animate-fade-in">
      {message}
    </div>
  );
}

// ─── Inline Editable Cell ───────────────────────────────────────────────────────

function EditableCell({
  purchase,
  field,
  type = 'text',
  options,
  onSaved,
}: {
  purchase: Purchase;
  field: keyof Purchase;
  type?: 'text' | 'number' | 'date' | 'select';
  options?: string[];
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState<string>(purchase[field]?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<any>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      if (type !== 'select' && type !== 'date') {
        inputRef.current?.select();
      }
    }
  }, [editing, type]);

  useEffect(() => {
    setValue(purchase[field]?.toString() ?? '');
  }, [purchase, field]);

  async function save() {
    if (value === (purchase[field]?.toString() ?? '')) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      let parsedValue: any = value;
      if (type === 'number') parsedValue = parseFloat(value) || 0;
      if (value === '' && type !== 'text') parsedValue = null;

      const res = await fetch('/api/purchases', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: purchase.id, [field]: parsedValue }),
      });
      if (res.ok) onSaved();
    } catch {
      // silent
    } finally {
      setSaving(false);
      setEditing(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') {
      setValue(purchase[field]?.toString() ?? '');
      setEditing(false);
    }
  }

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditing(true);
  };

  if (editing) {
    const inputCls = "bg-gray-700 border border-blue-500 rounded px-1.5 py-0.5 text-xs text-white focus:outline-none w-full min-w-[60px]";
    return (
      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
        {type === 'select' ? (
          <select
            ref={inputRef}
            className={inputCls}
            value={value}
            onChange={e => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={handleKeyDown}
          >
            <option value="">—</option>
            {options?.map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : (
          <input
            ref={inputRef}
            type={type}
            className={inputCls}
            value={value}
            onChange={e => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={handleKeyDown}
          />
        )}
      </div>
    );
  }

  const display = purchase[field]?.toString();
  const isCurrency = field === 'cost';
  return (
    <div
      onClick={startEdit}
      className="group cursor-pointer hover:bg-gray-800/50 rounded px-1 -mx-1 py-0.5 flex items-center gap-1 min-h-[24px]"
      title={`Edit ${field}`}
    >
      <span className={display ? '' : 'text-gray-500 italic text-[11px]'}>
        {type === 'number' && display
          ? (isCurrency ? `$${parseFloat(display).toFixed(2)}` : display)
          : display || '—'}
      </span>
      <span className="text-blue-500 text-[10px] opacity-0 group-hover:opacity-100 transition">✎</span>
    </div>
  );
}

// ─── Sold Progress Badge ────────────────────────────────────────────────────────

function RoiBadge({ value, title }: { value: number | null; title?: string }) {
  if (value == null) {
    return <span className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded" title={title}>—</span>;
  }
  return (
    <span className={`text-[10px] bg-gray-800 px-1.5 py-0.5 rounded whitespace-nowrap ${roiToneClass(value)}`} title={title}>
      {formatRoiPct(value)}
    </span>
  );
}

function SoldBadge({ sold, total }: { sold: number; total: number }) {
  if (total <= 0) return <span className="text-gray-600">—</span>;
  const capped = Math.min(sold, total);
  const pct = capped / total;
  const color =
    sold === 0 ? 'text-gray-500 bg-gray-800' :
      pct >= 1 ? 'text-green-400 bg-green-500/10' :
        'text-yellow-400 bg-yellow-500/10';
  return (
    <div className="flex items-center gap-2">
      <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${color}`}>
        {sold} / {total}
      </span>
      <div className="w-12 h-1.5 bg-gray-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${pct >= 1 ? 'bg-green-500' : sold > 0 ? 'bg-yellow-500' : 'bg-gray-700'}`}
          style={{ width: `${Math.min(pct, 1) * 100}%` }}
        />
      </div>
    </div>
  );
}

// ─── SKU Pill with copy ───────────────────────────────────────────────────────

function SkuPill({ sku, onCopy }: { sku: string | null; onCopy: (s: string) => void }) {
  if (!sku) return <span className="text-gray-700 text-xs italic">—</span>;
  return (
    <div className="flex items-center gap-1 group" onClick={e => e.stopPropagation()}>
      <span className="text-[11px] text-gray-400 font-mono bg-gray-800 px-2 py-0.5 rounded">
        {sku}
      </span>
      <button
        onClick={e => { e.stopPropagation(); onCopy(sku); }}
        title="Copy SKU"
        className="opacity-0 group-hover:opacity-100 transition text-gray-500 hover:text-green-400 text-[11px] px-1"
      >
        📋
      </button>
    </div>
  );
}

// ─── SKU Group Row ────────────────────────────────────────────────────────────

function SkuGroupRow({
  group,
  onEdit,
  onDelete,
  onAddSub,
  onCopySkU,
  onRefresh,
  onViewSales,
}: {
  group: SkuGroup;
  onEdit: (p: Purchase) => void;
  onDelete: (id: string) => void;
  onAddSub: (sku: string) => void;
  onCopySkU: (sku: string) => void;
  onRefresh: () => void;
  onViewSales: (sku: string, e?: React.MouseEvent) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasItems = group.purchases.some(p => (p.items?.length ?? 0) > 0);
  const hasSubs = group.purchases.length > 1 || hasItems;
  const first = group.purchases[0];
  const mode = group.metrics.allocationMode;

  function handleRowClick(e: React.MouseEvent, sku: string | null) {
    if (!sku) return;
    onViewSales(sku, e);
  }

  return (
    <>
      {/* Parent / summary row */}
      <tr
        className={`border-b border-gray-800/60 hover:bg-gray-800/30 transition select-none ${expanded ? 'bg-gray-800/20' : ''} ${group.sku ? 'cursor-pointer' : ''}`}
        onClick={e => handleRowClick(e, group.sku)}
        title={group.sku ? (hasSubs ? `View all sales for SKU ${group.sku} (${group.purchases.length} lots pooled)` : 'View all sales from this purchase') : undefined}
      >
        <td className="px-4 py-3 text-gray-400 text-xs w-6">
          {hasSubs && (
            <button
              type="button"
              onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
              title={expanded ? 'Hide purchases in this group' : 'Show purchases in this group'}
              className="p-1 -m-1 rounded hover:bg-gray-700/60"
            >
              <span className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
            </button>
          )}
        </td>
        <td className="px-3 py-3 text-sm text-gray-300 whitespace-nowrap">
          <div className="flex items-center gap-2">
            <EditableCell purchase={first} field="purchase_date" type="date" onSaved={onRefresh} />
            {hasSubs && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
                title={expanded ? 'Hide purchases in this group' : 'Show purchases in this group'}
                className="text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded-full hover:bg-gray-600"
              >
                ×{group.purchases.length}
              </button>
            )}
          </div>
        </td>
        <td className="px-3 py-3 text-sm text-gray-300"><EditableCell purchase={first} field="year" type="number" onSaved={onRefresh} /></td>
        <td className="px-3 py-3 text-sm text-gray-200"><EditableCell purchase={first} field="brand" type="select" options={BRANDS} onSaved={onRefresh} /></td>
        <td className="px-3 py-3 text-sm text-blue-300">
          {hasSubs ? (
            <span title={`${group.purchases.length} separate buys share SKU ${group.sku}. Expand to see each lot.`}>
              Pooled · {group.purchases.length} lots
            </span>
          ) : (
            <EditableCell purchase={first} field="series" onSaved={onRefresh} />
          )}
        </td>
        <td className="px-3 py-3 text-sm text-gray-300"><EditableCell purchase={first} field="sport" type="select" options={SPORTS} onSaved={onRefresh} /></td>
        <td className="px-3 py-3 text-sm text-gray-400">
          <div className="flex items-center gap-1.5">
            <EditableCell purchase={first} field="box_size" type="select" options={BOX_SIZES} onSaved={onRefresh} />
            {mode !== 'equal' && (
              <span className="text-[9px] uppercase tracking-wide text-yellow-500/80 bg-yellow-500/10 px-1 py-0.5 rounded">
                {ALLOCATION_MODE_LABELS[mode]}
              </span>
            )}
          </div>
        </td>
        <td className="px-3 py-3 text-sm text-green-400 font-medium tabular-nums">
          {hasSubs ? (
            <div>
              ${group.totalCost.toFixed(2)}
              <span className="ml-1 text-[10px] text-green-600">total</span>
            </div>
          ) : (
            <EditableCell purchase={first} field="cost" type="number" onSaved={onRefresh} />
          )}
        </td>
        <td className="px-3 py-3 text-sm text-gray-300 tabular-nums" title={ROI_HELP.sellableQty}>
          {hasSubs ? (
            <div>
              {group.metrics.sellableQty}
              <span className="ml-1 text-[10px] text-gray-600">total</span>
            </div>
          ) : (
            <EditableCell purchase={first} field="quantity" type="number" onSaved={onRefresh} />
          )}
        </td>
        <td className="px-3 py-3" title={`${group.metrics.soldQty} sold / ${group.metrics.sellableQty} sellable`}>
          <SoldBadge sold={group.metrics.soldQty} total={group.metrics.sellableQty} />
        </td>
        <td className="px-3 py-3 text-sm tabular-nums" title={group.sku ? (hasSubs ? `View all sales for SKU ${group.sku}` : 'View all sales from this purchase') : undefined}>
          {group.metrics.totalNetSales > 0 ? (
            <span className="text-green-400 font-medium">${group.metrics.totalNetSales.toFixed(2)}</span>
          ) : (
            <span className="text-gray-600">—</span>
          )}
        </td>
        <td className="px-3 py-3">
          <RoiBadge value={group.metrics.realizedRoi} title={ROI_HELP.realized} />
        </td>
        <td className="px-3 py-3">
          <RoiBadge value={group.metrics.lotToDateRoi} title={ROI_HELP.lotToDate} />
        </td>
        <td className="px-3 py-3 text-xs tabular-nums text-gray-300" title="Sales / purchase cost">
          {group.metrics.recoveredPct == null ? (
            <span className="text-gray-600">—</span>
          ) : (
            `${Math.round(group.metrics.recoveredPct)}%`
          )}
        </td>
        <td className="px-3 py-3 text-xs tabular-nums text-gray-300" title="Allocated cost of cards sold">
          {group.metrics.soldQty > 0 ? `$${group.metrics.costOfSold.toFixed(2)}` : <span className="text-gray-600">—</span>}
        </td>
        <td className="px-3 py-3 text-xs tabular-nums text-gray-400" title="Purchase cost still sitting in unsold cards">
          ${group.metrics.remainingCost.toFixed(2)}
        </td>
        <td className="px-3 py-3">
          <SkuPill sku={group.sku} onCopy={onCopySkU} />
        </td>
        <td className="px-3 py-3 text-sm text-gray-400"><EditableCell purchase={first} field="bought_from" type="select" options={SOURCES} onSaved={onRefresh} /></td>
        <td className="px-3 py-3">
          <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => onAddSub(group.sku ?? '')}
              title="Add another purchase with this SKU"
              className="text-[11px] text-blue-400 hover:text-blue-300 transition px-2 py-1 rounded hover:bg-blue-500/10"
            >+ sub</button>
            <button
              onClick={() => onEdit(first)}
              title="Edit"
              className="text-[13px] text-gray-400 hover:text-white transition px-2 py-1 rounded hover:bg-gray-700"
            >✎</button>
            {group.purchases.length === 1 && (
              <button
                onClick={() => { if (confirm('Delete this purchase?')) onDelete(first.id); }}
                title="Delete"
                className="text-[11px] text-red-500 hover:text-red-400 transition px-2 py-1 rounded hover:bg-red-500/10"
              >✕</button>
            )}
          </div>
        </td>
      </tr>

      {group.bandPool && (
        <tr className="bg-gray-900/50 border-b border-gray-800/40">
          <td />
          <td colSpan={16} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 pl-6">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">Price bands</span>
              {group.bandPool.bands.filter(b => b.qty > 0).map(b => (
                <span
                  key={b.id}
                  className={`text-[11px] px-2 py-0.5 rounded ${PRICE_BAND_TONE[b.id]}`}
                  title={`${b.label} ${b.hint}: ${b.qty} sold · net $${b.net.toFixed(2)} vs cost $${b.cost.toFixed(2)} (${b.unitCost.toFixed(2)}/card)`}
                >
                  {b.label} · {b.qty} · ${b.unitCost.toFixed(2)}/card · {formatRoiPct(b.realizedRoi, 0)}
                </span>
              ))}
              {group.bandPool.remainingCost > 0 && (
                <span className="text-[11px] text-gray-500">
                  ${group.bandPool.remainingCost.toFixed(2)} not in a sold band (unsold / no hits yet)
                </span>
              )}
            </div>
          </td>
        </tr>
      )}

      {/* Sub-purchase rows */}
      {expanded && group.purchases.length > 1 && group.purchases.map((p) => (
        <tr
          key={p.id}
          className={`bg-gray-800/10 border-b border-gray-800/30 hover:bg-gray-800/25 transition ${p.sku ? 'cursor-pointer' : ''}`}
          onClick={e => handleRowClick(e, p.sku)}
          title={p.sku ? 'View all sales from this purchase' : undefined}
        >
          <td className="px-4 py-2 w-6" />
          <td className="px-3 py-2 text-xs text-gray-400 pl-8"><EditableCell purchase={p} field="purchase_date" type="date" onSaved={onRefresh} /></td>
          <td className="px-3 py-2 text-xs text-gray-400"><EditableCell purchase={p} field="year" type="number" onSaved={onRefresh} /></td>
          <td className="px-3 py-2 text-xs text-gray-300"><EditableCell purchase={p} field="brand" type="select" options={BRANDS} onSaved={onRefresh} /></td>
          <td className="px-3 py-2 text-xs text-blue-300/70"><EditableCell purchase={p} field="series" onSaved={onRefresh} /></td>
          <td className="px-3 py-2 text-xs text-gray-300"><EditableCell purchase={p} field="sport" type="select" options={SPORTS} onSaved={onRefresh} /></td>
          <td className="px-3 py-2 text-xs text-gray-400"><EditableCell purchase={p} field="box_size" type="select" options={BOX_SIZES} onSaved={onRefresh} /></td>
          <td className="px-3 py-2 text-xs text-green-400 tabular-nums"><EditableCell purchase={p} field="cost" type="number" onSaved={onRefresh} /></td>
          <td className="px-3 py-2 text-xs text-gray-300 tabular-nums"><EditableCell purchase={p} field="quantity" type="number" onSaved={onRefresh} /></td>
          <td className="px-3 py-2" />
          <td className="px-3 py-2" />
          <td className="px-3 py-2" />
          <td className="px-3 py-2" />
          <td className="px-3 py-2" />
          <td className="px-3 py-2" />
          <td className="px-3 py-2" />
          <td className="px-3 py-2">
            <SkuPill sku={p.sku} onCopy={onCopySkU} />
          </td>
          <td className="px-3 py-2 text-xs text-gray-400"><EditableCell purchase={p} field="bought_from" type="select" options={SOURCES} onSaved={onRefresh} /></td>
          <td className="px-3 py-2">
            <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
              <button onClick={() => onEdit(p)} title="Edit" className="text-[13px] text-gray-400 hover:text-white transition px-2 py-0.5 rounded hover:bg-gray-700">✎</button>
              <button
                onClick={() => { if (confirm('Delete this purchase?')) onDelete(p.id); }}
                title="Delete"
                className="text-[11px] text-red-500 hover:text-red-400 transition px-2 py-0.5 rounded hover:bg-red-500/10"
              >✕</button>
            </div>
          </td>
        </tr>
      ))}

      {expanded && group.metrics.allocatedLines.map((line, i) => (
        <tr key={line.id || `line-${i}`} className="bg-gray-900/50 border-b border-gray-800/30">
          <td className="px-4 py-1.5 w-6" />
          <td className="px-3 py-1.5 text-[11px] text-gray-500 pl-8" colSpan={6}>
            <span className="text-gray-300">{line.label || `Card ${i + 1}`}</span>
            {line.estimatedValue > 0 && (
              <span className="ml-2 text-gray-600">est ${line.estimatedValue.toFixed(2)}</span>
            )}
          </td>
          <td className="px-3 py-1.5 text-[11px] text-green-400/80 tabular-nums">${line.allocatedCost.toFixed(2)}</td>
          <td className="px-3 py-1.5 text-[11px] text-gray-500 tabular-nums">{line.qty}</td>
          <td className="px-3 py-1.5" colSpan={10} onClick={e => e.stopPropagation()}>
            {line.id ? (
              <select
                className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-300"
                value={line.status}
                onChange={async e => {
                  await fetch('/api/purchases/items', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: line.id, status: e.target.value }),
                  });
                  onRefresh();
                }}
              >
                {POOL_ITEM_STATUSES.map(s => (
                  <option key={s} value={s}>{POOL_ITEM_STATUS_LABELS[s]}</option>
                ))}
              </select>
            ) : (
              <span className="text-[11px] text-gray-500">{POOL_ITEM_STATUS_LABELS[line.status]}</span>
            )}
          </td>
        </tr>
      ))}
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function PurchasesPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState(searchParams.get('sku') ?? '');
  const [showModal, setShowModal] = useState(false);
  const [editPurchase, setEditPurchase] = useState<Purchase | null>(null);
  const [showCsv, setShowCsv] = useState(false);
  const [preFillSku, setPreFillSku] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sales, setSales] = useState<any[]>([]);
  const [settings, setSettings] = useState<PnlSettings>(DEFAULT_PNL_SETTINGS);

  const load = useCallback(async (q = '') => {
    setLoading(true);
    try {
      const params = q ? `?q=${encodeURIComponent(q)}` : '';
      const res = await fetch(`/api/purchases${params}`);
      const data = await res.json();
      setPurchases(data.purchases ?? []);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  }, []);

  const loadSales = useCallback(async () => {
    try {
      const [salesRes, settingsRes] = await Promise.all([
        fetch('/api/ebay/sold-orders?sync=false'),
        fetch('/api/pnl-settings'),
      ]);
      const data = await salesRes.json();
      const settingsData = await settingsRes.json();
      setSales(data.sales ?? []);
      if (settingsData.settings) setSettings(settingsData.settings);
    } catch { /* silent */ }
  }, []);

  useEffect(() => { load(); loadSales(); }, [load, loadSales]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(search), 300);
  }, [search, load]);

  // Group by sku
  const groups: SkuGroup[] = (() => {
    const firstSaleIdByOrder = orderHeadIds(sales);
    const duplicatedBuyerShip = ordersWithDuplicatedBuyerShipping(sales);
    function saleCostsRow(s: any) {
      const head = firstSaleIdByOrder.get(s.order_number) === s.id;
      const dupBuyer = duplicatedBuyerShip.has(s.order_number);
      return resolvedSaleCosts({
        ...s,
        order_shipping_cost: dupBuyer && !head ? 0 : s.order_shipping_cost,
        shipping_cost: s.shipping_cost,
      }, settings);
    }

    const skuTotalSalesMap = new Map<string, number>();
    const skuQuantitySoldMap = new Map<string, number>();
    const skuBandSales = new Map<string, { quantitySold: number; soldFor: number; net: number }[]>();
    sales.forEach(s => {
      if (s.sku && !s.exclude_from_stats) {
        const c = saleCostsRow(s);
        skuTotalSalesMap.set(s.sku, (skuTotalSalesMap.get(s.sku) ?? 0) + c.net);
        skuQuantitySoldMap.set(s.sku, (skuQuantitySoldMap.get(s.sku) ?? 0) + (s.quantity_sold ?? 1));
        if (usesPriceBands(s.sku)) {
          const list = skuBandSales.get(s.sku) ?? [];
          list.push({ quantitySold: s.quantity_sold ?? 1, soldFor: c.soldFor, net: c.net });
          skuBandSales.set(s.sku, list);
        }
      }
    });

    const map = new Map<string, Purchase[]>();
    purchases.forEach(p => {
      const key = p.sku ?? `__no_sku__${p.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    });
    return Array.from(map.entries()).map(([, ps]) => {
      const quantitySold = ps[0].sku ? (skuQuantitySoldMap.get(ps[0].sku) ?? 0) : 0;
      const totalSales = ps[0].sku ? (skuTotalSalesMap.get(ps[0].sku) ?? 0) : 0;
      const totalCost = ps.reduce((s, p) => s + Number(p.cost || 0), 0);
      const totalQuantity = ps.reduce((s, p) => s + (p.quantity ?? 1), 0);
      const metrics = computePoolMetrics(poolInputFromPurchases(ps, quantitySold, totalSales));
      const sku = ps[0].sku;
      const bandPool = sku && usesPriceBands(sku)
        ? computePriceBandPool(totalCost, skuBandSales.get(sku) ?? [])
        : null;
      return {
        sku,
        purchases: ps,
        totalCost,
        totalSales,
        totalQuantity,
        quantitySold,
        metrics,
        bandPool,
      };
    });
  })();

  // Stats
  const totalSpent = purchases.reduce((s, p) => s + p.cost, 0);
  const avgCost = purchases.length ? totalSpent / purchases.length : 0;

  async function handleDelete(id: string) {
    await fetch(`/api/purchases?id=${id}`, { method: 'DELETE' });
    load(search);
  }

  function handleEdit(p: Purchase) {
    setEditPurchase(p);
    setPreFillSku(null);
    setShowModal(true);
  }

  function handleAddSub(sku: string) {
    setEditPurchase(null);
    setPreFillSku(sku);
    setShowModal(true);
  }

  function handleCopySku(sku: string) {
    navigator.clipboard.writeText(sku).then(() => {
      setToast(`Copied: ${sku}`);
    });
  }

  function handleViewSales(sku: string, e?: React.MouseEvent) {
    const href = `/sales?sku=${encodeURIComponent(sku)}`;
    if (e && (e.metaKey || e.ctrlKey || e.button === 1)) {
      window.open(href, '_blank');
      return;
    }
    router.push(href);
  }

  return (
    <div className="h-full flex flex-col bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="flex-none border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-white">Card Purchases</h1>
            <p className="text-xs text-gray-500 mt-0.5">
              Track every lot, box, and card you buy · click a purchase to see its sales
            </p>
            <p className="text-[11px] text-gray-600 mt-1">
              <span className="text-gray-400">Realized</span> — {ROI_HELP.realized}
              <span className="mx-2 text-gray-700">·</span>
              <span className="text-gray-400">Lot-to-date</span> — {ROI_HELP.lotToDate}
              <span className="mx-2 text-gray-700">·</span>
              Sellable is cards you will sell, not pack count.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCsv(true)}
              className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm rounded-lg transition"
            >
              📥 Import CSV
            </button>
            <button
              onClick={() => { setEditPurchase(null); setPreFillSku(null); setShowModal(true); }}
              className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-lg transition"
            >
              + Add Purchase
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          {[
            { label: 'Total Spent', value: `$${totalSpent.toFixed(2)}`, color: 'text-red-400' },
            { label: 'Purchases', value: purchases.length.toString(), color: 'text-blue-400' },
            { label: 'Avg Cost', value: `$${avgCost.toFixed(2)}`, color: 'text-yellow-400' },
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
            className="w-full bg-gray-900 border border-gray-800 rounded-lg pl-9 pr-4 py-2 text-sm text-gray-200 focus:outline-none focus:border-green-500 transition"
            placeholder="Search by SKU, brand, series, sport…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-40 text-gray-500 text-sm">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 text-gray-500 gap-2">
            <p className="text-4xl">🛒</p>
            <p className="text-sm">No purchases yet. Add one or import from CSV.</p>
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 bg-gray-900/95 backdrop-blur z-10">
              <tr className="text-[11px] text-gray-500 uppercase tracking-wider border-b border-gray-800">
                <th className="px-4 py-3 w-6" />
                <th className="px-3 py-3">Date</th>
                <th className="px-3 py-3">Year</th>
                <th className="px-3 py-3">Brand</th>
                <th className="px-3 py-3">Series</th>
                <th className="px-3 py-3">Sport</th>
                <th className="px-3 py-3">Box Size</th>
                <th className="px-3 py-3">Cost</th>
                <th className="px-3 py-3" title={ROI_HELP.sellableQty}>Sellable</th>
                <th className="px-3 py-3">Sold</th>
                <th className="px-3 py-3">Sales (net)</th>
                <th className="px-3 py-3" title={ROI_HELP.realized}>Realized</th>
                <th className="px-3 py-3" title={ROI_HELP.lotToDate}>Lot-to-date</th>
                <th className="px-3 py-3" title="Sales / purchase cost">Recov.</th>
                <th className="px-3 py-3" title="Allocated cost of cards sold">Sold cost</th>
                <th className="px-3 py-3" title="Purchase cost still sitting in unsold cards">Left</th>
                <th className="px-3 py-3">SKU</th>
                <th className="px-3 py-3">Source</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => (
                <SkuGroupRow
                  key={g.sku ?? g.purchases[0].id}
                  group={g}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onAddSub={handleAddSub}
                  onCopySkU={handleCopySku}
                  onRefresh={() => load(search)}
                  onViewSales={handleViewSales}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Modals */}
      {showModal && (
        <PurchaseModal
          initial={editPurchase ?? (preFillSku ? ({
            id: '',
            purchase_date: new Date().toISOString().split('T')[0],
            year: null,
            brand: null,
            series: null,
            sport: null,
            team: null,
            box_size: null,
            cost: 0,
            quantity: 1,
            sku: preFillSku,
            bought_from: 'eBay',
            notes: null,
            created_at: '',
            allocation_mode: 'equal',
            expected_bulk_recovery: 0,
            items: [],
          } as Purchase) : null)}
          onClose={() => { setShowModal(false); setEditPurchase(null); setPreFillSku(null); }}
          onSaved={() => load(search)}
        />
      )}
      {showCsv && (
        <CsvImportModal
          onClose={() => setShowCsv(false)}
          onImported={() => load(search)}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

export default function PurchasesPage() {
  return (
    <Suspense fallback={<div className="h-full flex items-center justify-center bg-gray-950 text-gray-500 text-sm">Loading…</div>}>
      <PurchasesPageContent />
    </Suspense>
  );
}
