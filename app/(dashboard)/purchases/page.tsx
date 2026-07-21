'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  sku: string | null;
  bought_from: string | null;
  notes: string | null;
  created_at: string;
}

interface SkuGroup {
  sku: string | null;
  purchases: Purchase[];
  totalCost: number;
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
  sku: '',
  bought_from: 'eBay',
  notes: '',
};

// ─── CSV Import Modal ─────────────────────────────────────────────────────────

function CsvImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<Record<string, string>[]>([]);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const HEADERS = ['purchase_date', 'year', 'brand', 'series', 'sport', 'team', 'box_size', 'cost', 'sku', 'bought_from'];

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
          sku: initial.sku ?? '',
          bought_from: initial.bought_from ?? 'eBay',
          notes: initial.notes ?? '',
        }
      : { ...EMPTY_FORM }
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Track whether the user has manually edited the SKU so we don't overwrite it.
  const [skuLocked, setSkuLocked] = useState(!!initial?.sku);

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
      const body = initial ? { id: initial.id, ...form } : form;
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

// ─── SKU Pill with copy ───────────────────────────────────────────────────────

function SkuPill({ sku, onCopy }: { sku: string | null; onCopy: (s: string) => void }) {
  if (!sku) return <span className="text-gray-700 text-xs italic">—</span>;
  return (
    <div className="flex items-center gap-1 group">
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
}: {
  group: SkuGroup;
  onEdit: (p: Purchase) => void;
  onDelete: (id: string) => void;
  onAddSub: (sku: string) => void;
  onCopySkU: (sku: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSubs = group.purchases.length > 1;
  const first = group.purchases[0];

  return (
    <>
      {/* Parent / summary row */}
      <tr
        className={`border-b border-gray-800/60 hover:bg-gray-800/30 transition cursor-pointer select-none ${expanded ? 'bg-gray-800/20' : ''}`}
        onClick={() => hasSubs && setExpanded(e => !e)}
      >
        <td className="px-4 py-3 text-gray-400 text-xs w-6">
          {hasSubs && (
            <span className={`inline-block transition-transform ${expanded ? 'rotate-90' : ''}`}>▶</span>
          )}
        </td>
        <td className="px-3 py-3 text-sm text-gray-300 whitespace-nowrap">
          {first.purchase_date}
          {hasSubs && (
            <span className="ml-2 text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded-full">
              ×{group.purchases.length}
            </span>
          )}
        </td>
        <td className="px-3 py-3 text-sm text-gray-300">{first.year ?? '—'}</td>
        <td className="px-3 py-3 text-sm text-gray-200">{first.brand ?? '—'}</td>
        <td className="px-3 py-3 text-sm text-blue-300">{first.series ?? '—'}</td>
        <td className="px-3 py-3 text-sm text-gray-300">{first.sport ?? '—'}</td>
        <td className="px-3 py-3 text-sm text-gray-400">{first.box_size ?? '—'}</td>
        <td className="px-3 py-3 text-sm text-green-400 font-medium tabular-nums">
          ${group.totalCost.toFixed(2)}
          {hasSubs && (
            <span className="ml-1 text-[10px] text-green-600">total</span>
          )}
        </td>
        <td className="px-3 py-3">
          <SkuPill sku={group.sku} onCopy={onCopySkU} />
        </td>
        <td className="px-3 py-3 text-sm text-gray-400">{first.bought_from ?? '—'}</td>
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
            {!hasSubs && (
              <button
                onClick={() => { if (confirm('Delete this purchase?')) onDelete(first.id); }}
                title="Delete"
                className="text-[11px] text-red-500 hover:text-red-400 transition px-2 py-1 rounded hover:bg-red-500/10"
              >✕</button>
            )}
          </div>
        </td>
      </tr>

      {/* Sub-purchase rows */}
      {expanded && group.purchases.map((p) => (
        <tr key={p.id} className="bg-gray-800/10 border-b border-gray-800/30 hover:bg-gray-800/25 transition">
          <td className="px-4 py-2 w-6" />
          <td className="px-3 py-2 text-xs text-gray-400 pl-8">{p.purchase_date}</td>
          <td className="px-3 py-2 text-xs text-gray-400">{p.year ?? '—'}</td>
          <td className="px-3 py-2 text-xs text-gray-300">{p.brand ?? '—'}</td>
          <td className="px-3 py-2 text-xs text-blue-300/70">{p.series ?? '—'}</td>
          <td className="px-3 py-2 text-xs text-gray-300">{p.sport ?? '—'}</td>
          <td className="px-3 py-2 text-xs text-gray-400">{p.box_size ?? '—'}</td>
          <td className="px-3 py-2 text-xs text-green-400 tabular-nums">${p.cost.toFixed(2)}</td>
          <td className="px-3 py-2">
            <SkuPill sku={p.sku} onCopy={onCopySkU} />
          </td>
          <td className="px-3 py-2 text-xs text-gray-400">{p.bought_from ?? '—'}</td>
          <td className="px-3 py-2">
            <div className="flex items-center gap-1">
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
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function PurchasesPage() {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editPurchase, setEditPurchase] = useState<Purchase | null>(null);
  const [showCsv, setShowCsv] = useState(false);
  const [preFillSku, setPreFillSku] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => load(search), 300);
  }, [search, load]);

  // Group by sku
  const groups: SkuGroup[] = (() => {
    const map = new Map<string, Purchase[]>();
    purchases.forEach(p => {
      const key = p.sku ?? `__no_sku__${p.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    });
    return Array.from(map.entries()).map(([, ps]) => ({
      sku: ps[0].sku,
      purchases: ps,
      totalCost: ps.reduce((s, p) => s + p.cost, 0),
    }));
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

  return (
    <div className="h-full flex flex-col bg-gray-950 overflow-hidden">
      {/* Header */}
      <div className="flex-none border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-bold text-white">Card Purchases</h1>
            <p className="text-xs text-gray-500 mt-0.5">Track every lot, box, and card you buy</p>
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
            sku: preFillSku,
            bought_from: 'eBay',
            notes: null,
            created_at: '',
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
