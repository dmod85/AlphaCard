'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

interface NameValuePair {
  name: string;
  value: string;
}

interface ActiveListing {
  itemId: string;
  title: string;
  price: number;
  url: string;
  pictureUrl?: string;
  quantity: number;
  quantityAvailable: number;
  startTime: string;
  isSeoFriendly: boolean;
  sku?: string;
}

const PRIORITY_COLS = [
  'Sport',
  'Player/Athlete',
  'Team',
  'Manufacturer',
  'Set',
  'Parallel/Variety',
  'Card Number',
  'League',
];

// How many rows to render up front, growing as the user scrolls — keeps the
// initial paint fast even once every listing has been fetched into memory.
const ROW_BATCH = 50;
// eBay's GetSellerList call (used to list active listings) does NOT return
// item specifics, so they're fetched separately via GetItem, batched and
// cached server-side (see /api/ebay/listing-details) to avoid burning
// through eBay's daily call limit on every page load.
const SPEC_BATCH = 20;
const SPEC_CONCURRENCY = 4;

type SpecificMap = Record<string, NameValuePair[] | 'loading' | 'error'>;
type SortDir = 'asc' | 'desc';
// edits[itemId][colName] = new value
type EditMap = Record<string, Record<string, string>>;
// submitResult[itemId] = 'pending' | 'success' | 'error' | string (error msg)
type SubmitResultMap = Record<string, 'pending' | 'success' | string>;

function getSpecificValue(specifics: NameValuePair[], colName: string): string {
  const lower = colName.toLowerCase().trim();
  const pair = specifics.find((s) => s.name.toLowerCase().trim() === lower);
  return pair?.value ?? '';
}

function buildColumns(specificMap: SpecificMap): string[] {
  const seen = new Set<string>(PRIORITY_COLS.map((c) => c.toLowerCase().trim()));
  const extras: string[] = [];
  for (const val of Object.values(specificMap)) {
    if (Array.isArray(val)) {
      for (const s of val) {
        const k = s.name.toLowerCase().trim();
        if (!seen.has(k)) { seen.add(k); extras.push(s.name); }
      }
    }
  }
  return [...PRIORITY_COLS, ...extras];
}

/** Formats an ISO timestamp as e.g. "12:00 AM PT (in 6h 12m)" */
function formatResetTime(iso: string): string {
  const target = new Date(iso);
  const clock = target.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles', timeZoneName: 'short' });
  const diffMs = target.getTime() - Date.now();
  if (diffMs <= 0) return clock;
  const hours = Math.floor(diffMs / 3_600_000);
  const minutes = Math.round((diffMs % 3_600_000) / 60_000);
  return `${clock} (in ${hours}h ${minutes}m)`;
}

/** Replace all occurrences of `find` in `str` with `replace` */
function replaceOccurrences(str: string, find: string, replace: string, caseSensitive: boolean): string {
  if (!find) return str;
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return str.replace(new RegExp(escaped, caseSensitive ? 'g' : 'gi'), replace);
}

function SortIndicator({ col, sortCol, sortDir }: { col: string; sortCol: string | null; sortDir: SortDir }) {
  const active = sortCol === col;
  return (
    <span className={`ml-1 inline-block ${active ? 'text-green-400' : 'text-gray-700'}`}>
      {active ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
    </span>
  );
}

function SkeletonRow({ cols }: { cols: number }) {
  return (
    <tr className="border-b border-gray-800/50 animate-pulse">
      <td className="px-3 py-2 min-w-[260px] max-w-[340px]">
        <div className="h-3 bg-gray-800 rounded w-5/6 mb-1.5" />
      </td>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-3 py-2">
          <div className="h-3 bg-gray-800 rounded w-14" />
        </td>
      ))}
    </tr>
  );
}

/** Inline editable cell */
function EditableCell({
  value,
  edited,
  isEditing,
  submitResult,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  value: string;
  edited: boolean;
  isEditing: boolean;
  submitResult?: 'pending' | 'success' | string;
  onStartEdit: () => void;
  onCommit: (val: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing) {
      setDraft(value);
      setTimeout(() => inputRef.current?.select(), 0);
    }
  }, [isEditing, value]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => onCommit(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); onCommit(draft); }
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        }}
        className="w-full min-w-[80px] max-w-[200px] bg-gray-800 border border-green-500/60 rounded px-2 py-0.5 text-xs text-white outline-none focus:border-green-400"
        autoFocus
      />
    );
  }

  const isPending = submitResult === 'pending';
  const isSuccess = submitResult === 'success';
  const isError = submitResult && submitResult !== 'pending' && submitResult !== 'success';

  return (
    <div
      onClick={isPending ? undefined : onStartEdit}
      className={`
        group relative min-w-[60px] rounded px-1.5 py-0.5 text-xs cursor-text transition-all
        ${isPending ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-700/60'}
        ${edited && !isSuccess && !isError ? 'bg-amber-500/10 border border-amber-500/30' : ''}
        ${isSuccess ? 'bg-green-500/10 border border-green-500/30' : ''}
        ${isError ? 'bg-red-500/10 border border-red-500/30' : ''}
      `}
      title={isError ? String(submitResult) : edited ? 'Edited — click to change' : 'Click to edit'}
    >
      {value ? (
        <span className={isSuccess ? 'text-green-300' : isError ? 'text-red-300' : edited ? 'text-amber-200' : 'text-gray-200'}>
          {value}
        </span>
      ) : (
        <span className="text-gray-700 group-hover:text-gray-500 transition-colors">—</span>
      )}
      {isSuccess && <span className="ml-1 text-green-400 text-[9px]">✓</span>}
      {isError && <span className="ml-1 text-red-400 text-[9px]" title={String(submitResult)}>✗</span>}
      {edited && !isSuccess && !isError && (
        <span className="absolute -top-1 -right-1 w-1.5 h-1.5 bg-amber-400 rounded-full" />
      )}
    </div>
  );
}

export default function ListingDetailsPage() {
  const [allListings, setAllListings] = useState<ActiveListing[]>([]);
  const [visibleCount, setVisibleCount] = useState(ROW_BATCH);
  const [loading, setLoading] = useState(true);
  const [pagesLoading, setPagesLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const [specificMap, setSpecificMap] = useState<SpecificMap>({});
  const [edits, setEdits] = useState<EditMap>({});
  const [editingCell, setEditingCell] = useState<{ itemId: string; col: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResults, setSubmitResults] = useState<SubmitResultMap>({});

  // ── Search & Replace state ─────────────────────────────────────────────────
  const [srCol, setSrCol] = useState<string | null>(null);
  const [srFind, setSrFind] = useState('');
  const [srReplace, setSrReplace] = useState('');
  const [srCase, setSrCase] = useState(false);
  const srFindRef = useRef<HTMLInputElement>(null);

  // ── eBay API usage panel ──────────────────────────────────────────────────
  const [usageOpen, setUsageOpen] = useState(false);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageData, setUsageData] = useState<{
    resetsAt: string;
    aggregate: { used: number; limit: number; percent: number; status: string } | null;
    rules: { callName: string; used: number; limit: number; percent: number; status: string }[];
  } | null>(null);

  const checkApiUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      const res = await fetch('/api/ebay/api-usage');
      const data = await res.json();
      if (res.status === 401 || data.error === 'EBAY_AUTH_REQUIRED') {
        setUsageError('eBay auth required — please reconnect your account.');
        return;
      }
      if (!res.ok || data.error) throw new Error(data.error || 'Failed to check usage');
      setUsageData(data);
    } catch (err: any) {
      setUsageError(err.message || 'Failed to check usage');
    } finally {
      setUsageLoading(false);
    }
  }, []);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const fetchingRef = useRef<Set<string>>(new Set());
  // Queue that listing pages push their item IDs into as soon as they arrive,
  // drained continuously by the specifics workers below — lets specifics
  // fetching run *at the same time* as later listing pages, instead of
  // waiting for every page to finish first.
  const specQueueRef = useRef<string[]>([]);
  const pagesDoneRef = useRef(false);

  // ── Fetch a batch of item specifics (server caches these in Supabase) ────
  const fetchSpecifics = useCallback(async (itemIds: string[]) => {
    const toFetch = itemIds.filter((id) => !fetchingRef.current.has(id));
    if (toFetch.length === 0) return;
    toFetch.forEach((id) => fetchingRef.current.add(id));
    setSpecificMap((prev) => {
      const next = { ...prev };
      toFetch.forEach((id) => { next[id] = 'loading'; });
      return next;
    });
    try {
      const res = await fetch(`/api/ebay/listing-details?itemIds=${toFetch.join(',')}`);
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Failed');
      setSpecificMap((prev) => {
        const next = { ...prev };
        for (const r of data.results as { itemId: string; specifics: NameValuePair[] }[]) {
          next[r.itemId] = r.specifics;
          fetchingRef.current.delete(r.itemId);
        }
        return next;
      });
    } catch {
      setSpecificMap((prev) => {
        const next = { ...prev };
        toFetch.forEach((id) => { next[id] = 'error'; fetchingRef.current.delete(id); });
        return next;
      });
    }
  }, []);

  // Persistent pool of workers that drain specQueueRef as items land in it —
  // started once per load, they keep pulling batches until every page has
  // been fetched *and* the queue is empty.
  const runSpecificsWorkers = useCallback(async () => {
    async function worker() {
      while (true) {
        const batch = specQueueRef.current.splice(0, SPEC_BATCH);
        if (batch.length > 0) {
          await fetchSpecifics(batch);
        } else if (pagesDoneRef.current) {
          return;
        } else {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
    await Promise.all(Array.from({ length: SPEC_CONCURRENCY }, worker));
  }, [fetchSpecifics]);

  // ── Load listing pages and their specifics concurrently ──────────────────
  const loadEverything = useCallback(async () => {
    setLoading(true);
    setPagesLoading(true);
    setError(null);
    setAllListings([]);
    setSpecificMap({});
    setVisibleCount(ROW_BATCH);
    fetchingRef.current.clear();
    specQueueRef.current = [];
    pagesDoneRef.current = false;

    const specificsDone = runSpecificsWorkers();

    try {
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        const res = await fetch(`/api/ebay/active-listings?page=${page}`);
        const data = await res.json();
        if (res.status === 401 || data.error === 'EBAY_AUTH_REQUIRED') {
          setError('eBay auth required — please reconnect your account.');
          return;
        }
        if (!res.ok) throw new Error(data.error || 'Failed to fetch listings');
        setAllListings((prev) => [...prev, ...data.listings]);
        // Queue this page's items for specifics immediately — the worker
        // pool above is already running and will pick them up right away,
        // in parallel with fetching the next page.
        specQueueRef.current.push(...data.listings.map((l: ActiveListing) => l.itemId));
        totalPages = data.totalPages || 1;
        setTotal(data.total || 0);
        setLoading(false); // reveal rows as soon as the first page is in
        page += 1;
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      setPagesLoading(false);
      pagesDoneRef.current = true;
      await specificsDone;
    }
  }, [runSpecificsWorkers]);

  useEffect(() => { loadEverything(); }, [loadEverything]);

  // ── Bottom sentinel — reveals more already-loaded rows as you scroll ─────
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setVisibleCount((v) => v + ROW_BATCH);
    }, { rootMargin: '400px' });
    if (sentinelRef.current) observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, []);

  // ── Sort ──────────────────────────────────────────────────────────────────
  const handleSort = useCallback((col: string) => {
    if (sortCol === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortCol(col);
      setSortDir('asc');
    }
  }, [sortCol]);

  // ── Clear all values in a column ──────────────────────────────────────────
  const handleClearColumn = useCallback((col: string) => {
    const newEdits: EditMap = { ...edits };
    let affected = 0;

    for (const listing of allListings) {
      const specs = specificMap[listing.itemId];
      if (!Array.isArray(specs)) continue;
      const original = getSpecificValue(specs, col);
      const current = newEdits[listing.itemId]?.[col] ?? original;
      if (current === '') continue;
      affected++;
      newEdits[listing.itemId] = { ...(newEdits[listing.itemId] || {}), [col]: '' };
    }

    if (affected > 0) {
      setEdits(newEdits);
      setSubmitResults({});
    }
  }, [allListings, specificMap, edits]);

  // ── Open S&R for a column ─────────────────────────────────────────────────
  const openSr = useCallback((col: string) => {
    setSrCol(col);
    setSrFind('');
    setSrReplace('');
    setTimeout(() => srFindRef.current?.focus(), 50);
  }, []);

  // ── S&R match count (across all loaded data) ──────────────────────────────
  const srMatchCount = useMemo(() => {
    if (!srCol || !srFind) return 0;
    let count = 0;
    for (const listing of allListings) {
      let current = '';
      if (srCol === '__title__') {
        current = edits[listing.itemId]?.['__title__'] ?? listing.title;
      } else {
        const specs = specificMap[listing.itemId];
        if (!Array.isArray(specs)) continue;
        current = edits[listing.itemId]?.[srCol] ?? getSpecificValue(specs, srCol);
      }
      const regex = new RegExp(
        srFind.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        srCase ? '' : 'i'
      );
      if (regex.test(current)) count++;
    }
    return count;
  }, [srCol, srFind, srCase, allListings, specificMap, edits]);

  // ── Replace All ───────────────────────────────────────────────────────────
  const handleReplaceAll = useCallback(() => {
    if (!srCol || !srFind) return;
    const newEdits: EditMap = { ...edits };
    let affected = 0;

    for (const listing of allListings) {
      let current = '';
      let original = '';

      if (srCol === '__title__') {
        original = listing.title;
        current = newEdits[listing.itemId]?.['__title__'] ?? original;
      } else {
        const specs = specificMap[listing.itemId];
        if (!Array.isArray(specs)) continue;
        original = getSpecificValue(specs, srCol);
        current = newEdits[listing.itemId]?.[srCol] ?? original;
      }

      const replaced = replaceOccurrences(current, srFind, srReplace, srCase);
      if (replaced === current) continue;
      affected++;

      if (replaced.trim() === original.trim()) {
        // Reverted to original — clean up the edit key
        if (newEdits[listing.itemId]) {
          const { [srCol]: _, ...rest } = newEdits[listing.itemId];
          if (Object.keys(rest).length === 0) delete newEdits[listing.itemId];
          else newEdits[listing.itemId] = rest;
        }
      } else {
        newEdits[listing.itemId] = { ...(newEdits[listing.itemId] || {}), [srCol]: replaced.trim() };
      }
    }

    if (affected > 0) {
      setEdits(newEdits);
      setSubmitResults({});
    }
  }, [srCol, srFind, srReplace, srCase, allListings, specificMap, edits]);

  // ── Cell edit handlers ────────────────────────────────────────────────────
  const startEdit = useCallback((itemId: string, col: string) => {
    setEditingCell({ itemId, col });
  }, []);

  const commitEdit = useCallback((itemId: string, col: string, newVal: string) => {
    setEditingCell(null);
    // Determine the original value — title comes from allListings, specifics from specificMap
    let originalVal = '';
    if (col === '__title__') {
      originalVal = allListings.find((l) => l.itemId === itemId)?.title ?? '';
    } else {
      const specs = specificMap[itemId];
      originalVal = Array.isArray(specs) ? getSpecificValue(specs, col) : '';
    }
    if (newVal.trim() === originalVal.trim()) {
      // No change — remove any stale edit for this col
      setEdits((prev) => {
        const next = { ...prev };
        if (next[itemId]) {
          const { [col]: _, ...rest } = next[itemId];
          if (Object.keys(rest).length === 0) delete next[itemId];
          else next[itemId] = rest;
        }
        return next;
      });
      return;
    }
    setEdits((prev) => ({
      ...prev,
      [itemId]: { ...(prev[itemId] || {}), [col]: newVal.trim() },
    }));
    // Clear any stale submit result for this item
    setSubmitResults((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }, [specificMap, allListings]);

  const cancelEdit = useCallback(() => {
    setEditingCell(null);
  }, []);

  // ── Submit changes ────────────────────────────────────────────────────────
  const changedItemIds = Object.keys(edits);
  const changedCount = changedItemIds.length;

  const submitChanges = useCallback(async () => {
    if (changedCount === 0 || submitting) return;
    setSubmitting(true);

    // Mark all changed items as pending
    setSubmitResults((prev) => {
      const next = { ...prev };
      changedItemIds.forEach((id) => { next[id] = 'pending'; });
      return next;
    });

    const items = changedItemIds.map((itemId) => {
      const baseSpecs = Array.isArray(specificMap[itemId]) ? (specificMap[itemId] as NameValuePair[]) : [];
      const itemEdits = edits[itemId];

      // Pull out title edit if present
      const newTitle = itemEdits['__title__'] ?? undefined;

      // Merge specifics edits (exclude the __title__ key)
      const mergedMap = new Map<string, string>(baseSpecs.map((s) => [s.name.toLowerCase().trim(), s.value]));
      const displayNames = new Map<string, string>(baseSpecs.map((s) => [s.name.toLowerCase().trim(), s.name]));

      for (const [col, val] of Object.entries(itemEdits)) {
        if (col === '__title__') continue;
        const key = col.toLowerCase().trim();
        mergedMap.set(key, val);
        if (!displayNames.has(key)) displayNames.set(key, col);
      }

      const specifics: NameValuePair[] = Array.from(mergedMap.entries())
        .filter(([, v]) => v.trim())
        .map(([key, value]) => ({ name: displayNames.get(key) || key, value }));

      return { itemId, specifics, title: newTitle };
    });

    try {
      const res = await fetch('/api/ebay/revise-specifics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();

      if (!res.ok || data.error) throw new Error(data.error || 'Request failed');

      const successIds = new Set<string>();
      const newResults: SubmitResultMap = {};

      for (const r of data.results as { itemId: string; success: boolean; error?: string }[]) {
        newResults[r.itemId] = r.success ? 'success' : (r.error || 'Error');
        if (r.success) successIds.add(r.itemId);
      }

      setSubmitResults(newResults);

      // Apply successful edits into specificMap / allListings and clear those edits
      if (successIds.size > 0) {
        setSpecificMap((prev) => {
          const next = { ...prev };
          for (const item of items) {
            if (successIds.has(item.itemId)) next[item.itemId] = item.specifics;
          }
          return next;
        });
        // Sync updated titles back into allListings
        setAllListings((prev) =>
          prev.map((l) => {
            if (!successIds.has(l.itemId)) return l;
            const item = items.find((i) => i.itemId === l.itemId);
            return item?.title ? { ...l, title: item.title } : l;
          })
        );
        setEdits((prev) => {
          const next = { ...prev };
          successIds.forEach((id) => delete next[id]);
          return next;
        });
      }
    } catch (err: any) {
      const errResult: SubmitResultMap = {};
      changedItemIds.forEach((id) => { errResult[id] = err.message || 'Failed'; });
      setSubmitResults(errResult);
    } finally {
      setSubmitting(false);
    }
  }, [changedCount, changedItemIds, submitting, edits, specificMap]);

  // ── Filter + sort ─────────────────────────────────────────────────────────
  const filtered = useMemo(
    () => search.trim()
      ? allListings.filter((l) => l.title.toLowerCase().includes(search.toLowerCase()))
      : allListings,
    [allListings, search]
  );

  const sortedFiltered = useMemo(() => {
    if (!sortCol) return filtered;
    return [...filtered].sort((a, b) => {
      let aVal = '', bVal = '';
      if (sortCol === '__title__') { aVal = a.title; bVal = b.title; }
      else {
        const aSpecs = specificMap[a.itemId];
        const bSpecs = specificMap[b.itemId];
        aVal = Array.isArray(aSpecs) ? getSpecificValue(aSpecs, sortCol) : '￿';
        bVal = Array.isArray(bSpecs) ? getSpecificValue(bSpecs, sortCol) : '￿';
      }
      const cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir, specificMap]);

  const visible = sortedFiltered.slice(0, visibleCount);
  const columns = buildColumns(specificMap);

  const specificsLoadedCount = useMemo(
    () => allListings.reduce((n, l) => n + (Array.isArray(specificMap[l.itemId]) ? 1 : 0), 0),
    [allListings, specificMap]
  );
  const specificsPending = allListings.length > 0 && specificsLoadedCount < allListings.length;

  return (
    <div className="h-full bg-gray-950 text-white flex flex-col">
      {/* ── Header ── */}
      <div className="sticky top-0 z-20 bg-gray-950/95 backdrop-blur border-b border-gray-800 px-6 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-white tracking-tight">Listing Details</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            {loading
              ? 'Loading…'
              : `${sortedFiltered.length.toLocaleString()} of ${total.toLocaleString()} listings`}
            {sortCol && (
              <span className="ml-2 text-green-400/80">
                sorted by {sortCol === '__title__' ? 'Title' : sortCol} {sortDir === 'asc' ? '↑' : '↓'}
              </span>
            )}
            {!loading && (pagesLoading || specificsPending) && (
              <span className="ml-2 text-amber-400/70">
                loading details… ({specificsLoadedCount.toLocaleString()}/{allListings.length.toLocaleString()})
              </span>
            )}
          </p>
        </div>

        {/* Search */}
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">🔍</span>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search titles…"
            className="bg-gray-900 border border-gray-700 rounded-lg pl-8 pr-4 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-500 w-56"
          />
        </div>

        {/* Clear sort */}
        {sortCol && (
          <button
            onClick={() => { setSortCol(null); setSortDir('asc'); }}
            className="px-3 py-1.5 bg-green-500/10 hover:bg-green-500/20 border border-green-500/30 text-green-400 text-xs rounded-lg transition"
          >
            ✕ Clear sort
          </button>
        )}

        {/* Submit Changes */}
        {changedCount > 0 && (
          <button
            onClick={submitChanges}
            disabled={submitting}
            className={`
              flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-semibold border transition
              ${submitting
                ? 'bg-gray-700 border-gray-600 text-gray-400 cursor-not-allowed'
                : 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25 hover:border-amber-400/60'}
            `}
          >
            {submitting ? (
              <>
                <div className="w-3 h-3 border border-gray-500 border-t-amber-400 rounded-full animate-spin" />
                Submitting…
              </>
            ) : (
              <>
                <span className="inline-flex items-center justify-center w-4 h-4 bg-amber-500/30 text-amber-300 rounded-full text-[10px] font-bold">
                  {changedCount}
                </span>
                Submit Changes
              </>
            )}
          </button>
        )}

        {/* Discard */}
        {changedCount > 0 && !submitting && (
          <button
            onClick={() => { setEdits({}); setSubmitResults({}); }}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-400 text-xs rounded-lg transition"
          >
            Discard
          </button>
        )}

        {/* Refresh */}
        <button
          onClick={() => { setEdits({}); setSubmitResults({}); setSortCol(null); loadEverything(); }}
          className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs rounded-lg transition"
        >
          ↺ Refresh
        </button>

        {/* API usage */}
        <div className="relative">
          <button
            onClick={() => {
              const next = !usageOpen;
              setUsageOpen(next);
              if (next && !usageData && !usageLoading) checkApiUsage();
            }}
            className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-xs rounded-lg transition"
          >
            📊 API Usage
          </button>

          {usageOpen && (
            <div className="absolute right-0 top-full mt-2 w-72 bg-gray-900 border border-gray-700 rounded-xl shadow-xl p-4 z-30 text-xs">
              <div className="flex items-center justify-between mb-2">
                <span className="text-gray-400 font-semibold uppercase tracking-widest text-[10px]">eBay API Usage</span>
                <button
                  onClick={checkApiUsage}
                  disabled={usageLoading}
                  className="text-gray-500 hover:text-gray-300 transition disabled:opacity-40"
                  title="Refresh usage (diagnostic call — avoid checking too often)"
                >
                  ↺
                </button>
              </div>

              {usageLoading && (
                <div className="flex items-center gap-2 text-gray-500 py-2">
                  <div className="w-3 h-3 border border-gray-600 border-t-green-500 rounded-full animate-spin" />
                  Checking usage…
                </div>
              )}

              {!usageLoading && usageError && (
                <p className="text-red-400 py-1">{usageError}</p>
              )}

              {!usageLoading && !usageError && usageData && (
                <div className="space-y-3">
                  {usageData.aggregate ? (
                    <div>
                      <div className="flex items-center justify-between text-gray-300 mb-1">
                        <span>Daily calls used</span>
                        <span className="font-semibold">
                          {usageData.aggregate.used.toLocaleString()} / {usageData.aggregate.limit.toLocaleString()}
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            usageData.aggregate.percent >= 85 ? 'bg-red-500' : usageData.aggregate.percent >= 60 ? 'bg-amber-500' : 'bg-green-500'
                          }`}
                          style={{ width: `${Math.min(100, usageData.aggregate.percent)}%` }}
                        />
                      </div>
                      <p className="text-gray-500 mt-1">{usageData.aggregate.percent}% used</p>
                    </div>
                  ) : (
                    <p className="text-gray-500">No application-wide usage rule returned.</p>
                  )}

                  <p className="text-gray-400">Resets at {formatResetTime(usageData.resetsAt)}</p>

                  {usageData.rules.filter((r) => r.used > 0).length > 0 && (
                    <div className="pt-2 border-t border-gray-800">
                      <p className="text-gray-500 mb-1">By call:</p>
                      {usageData.rules
                        .filter((r) => r.used > 0)
                        .sort((a, b) => b.percent - a.percent)
                        .slice(0, 5)
                        .map((r) => (
                          <div key={r.callName} className="flex items-center justify-between text-gray-400">
                            <span>{r.callName}</span>
                            <span>{r.used.toLocaleString()} / {r.limit.toLocaleString()}</span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Search & Replace Panel ── */}
      {srCol && (
        <div className="bg-gray-900/98 border-b border-purple-500/40 px-5 py-3 flex items-center gap-3 flex-wrap">
          {/* Column badge */}
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] text-purple-400/70 uppercase tracking-widest font-semibold">Find & Replace</span>
            <span className="px-2 py-0.5 bg-purple-500/20 border border-purple-500/40 text-purple-300 text-xs rounded font-medium">
              {srCol === '__title__' ? 'Title' : srCol}
            </span>
          </div>

          <span className="text-gray-700 text-xs hidden sm:block">in</span>

          {/* Find input */}
          <div className="relative">
            <input
              ref={srFindRef}
              type="text"
              value={srFind}
              onChange={(e) => setSrFind(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleReplaceAll(); if (e.key === 'Escape') setSrCol(null); }}
              placeholder="Find…"
              className="bg-gray-800 border border-gray-700 focus:border-purple-500/60 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none w-48 transition"
            />
          </div>

          <span className="text-gray-600 text-xs">→</span>

          {/* Replace input */}
          <input
            type="text"
            value={srReplace}
            onChange={(e) => setSrReplace(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleReplaceAll(); if (e.key === 'Escape') setSrCol(null); }}
            placeholder="Replace with…"
            className="bg-gray-800 border border-gray-700 focus:border-purple-500/60 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none w-48 transition"
          />

          {/* Case sensitive toggle */}
          <label className="flex items-center gap-1.5 cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={srCase}
              onChange={(e) => setSrCase(e.target.checked)}
              className="w-3 h-3 accent-purple-500"
            />
            <span className="text-[11px] text-gray-500">Aa</span>
          </label>

          {/* Match count */}
          {srFind && (
            <span className="text-[11px] text-gray-500 shrink-0">
              {srMatchCount === 0
                ? 'No matches'
                : `${srMatchCount.toLocaleString()} match${srMatchCount === 1 ? '' : 'es'}`}
              {allListings.length < total && (
                <span className="text-gray-700"> (in {allListings.length.toLocaleString()} loaded)</span>
              )}
            </span>
          )}

          {/* Replace All button */}
          <button
            onClick={handleReplaceAll}
            disabled={!srFind || srMatchCount === 0}
            className="px-3 py-1.5 bg-purple-500/15 hover:bg-purple-500/25 border border-purple-500/40 hover:border-purple-400/60 text-purple-300 text-xs rounded-lg font-medium transition disabled:opacity-30 disabled:cursor-not-allowed shrink-0"
          >
            Replace All
          </button>

          {/* Close */}
          <button
            onClick={() => setSrCol(null)}
            className="ml-auto px-2 py-1.5 text-gray-600 hover:text-gray-400 text-xs rounded transition"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
      )}

      {/* Legend */}
      {changedCount > 0 && (
        <div className="px-6 py-2 bg-amber-500/5 border-b border-amber-500/20 flex items-center gap-4 text-[11px] text-amber-400/80">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 bg-amber-400 rounded-full" />
            Unsaved edit
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 bg-green-400 rounded-full" />
            Saved to eBay
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 bg-red-400 rounded-full" />
            Error
          </span>
          <span className="text-gray-600">Press Enter to confirm · Esc to cancel</span>
        </div>
      )}

      {error && (
        <div className="m-6 p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* ── Table ── */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-sm border-collapse min-w-max">
          <thead className="sticky top-0 z-10">
            <tr className="bg-gray-900 border-b border-gray-700">
              {/* Title header */}
              <th className="px-3 py-3 text-left text-xs uppercase tracking-widest font-semibold min-w-[260px] max-w-[340px] whitespace-nowrap">
                <div className="flex items-center gap-1 group/hdr">
                  <span
                    className={`cursor-pointer select-none hover:text-gray-200 transition-colors ${sortCol === '__title__' ? 'text-green-400' : 'text-gray-500'}`}
                    onClick={() => handleSort('__title__')}
                  >
                    Title
                    <SortIndicator col="__title__" sortCol={sortCol} sortDir={sortDir} />
                  </span>
                  <button
                    onClick={(e) => { e.stopPropagation(); openSr('__title__'); }}
                    className={`ml-1 px-1 py-0.5 rounded text-[10px] transition-all select-none ${
                      srCol === '__title__'
                        ? 'opacity-100 text-purple-300 bg-purple-500/25 border border-purple-500/40'
                        : 'opacity-0 group-hover/hdr:opacity-100 text-gray-600 hover:text-purple-400 hover:bg-purple-500/10'
                    }`}
                    title="Search & Replace in Title"
                  >
                    ⇄
                  </button>
                </div>
              </th>
              {/* Specifics headers */}
              {columns.map((col) => (
                <th key={col} className="px-3 py-3 text-left text-xs uppercase tracking-widest font-semibold whitespace-nowrap">
                  <div className="flex items-center gap-1 group/hdr">
                    <span
                      className={`cursor-pointer select-none hover:text-gray-200 transition-colors ${sortCol === col ? 'text-green-400' : 'text-gray-500'}`}
                      onClick={() => handleSort(col)}
                    >
                      {col}
                      <SortIndicator col={col} sortCol={sortCol} sortDir={sortDir} />
                    </span>
                    <button
                      onClick={(e) => { e.stopPropagation(); openSr(col); }}
                      className={`ml-1 px-1 py-0.5 rounded text-[10px] transition-all select-none ${
                        srCol === col
                          ? 'opacity-100 text-purple-300 bg-purple-500/25 border border-purple-500/40'
                          : 'opacity-0 group-hover/hdr:opacity-100 text-gray-600 hover:text-purple-400 hover:bg-purple-500/10'
                      }`}
                      title={`Search & Replace in ${col}`}
                    >
                      ⇄
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`Clear "${col}" for all ${allListings.length.toLocaleString()} loaded listings?`)) {
                          handleClearColumn(col);
                        }
                      }}
                      className="ml-0.5 px-1 py-0.5 rounded text-[10px] transition-all select-none opacity-0 group-hover/hdr:opacity-100 text-gray-600 hover:text-red-400 hover:bg-red-500/10"
                      title={`Clear all values in ${col}`}
                    >
                      🗑
                    </button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 20 }).map((_, i) => <SkeletonRow key={i} cols={PRIORITY_COLS.length} />)
              : visible.map((listing) => {
                  const specs = specificMap[listing.itemId];
                  const specsLoaded = Array.isArray(specs);
                  const specsError = specs === 'error';
                  const itemEdits = edits[listing.itemId] || {};
                  const submitResult = submitResults[listing.itemId];
                  const isItemPending = submitResult === 'pending';

                  return (
                    <tr
                      key={listing.itemId}
                      className={`border-b border-gray-800/50 transition-colors ${
                        isItemPending ? 'opacity-60' : 'hover:bg-gray-800/20'
                      }`}
                    >
                      {/* Title (editable) */}
                      <td className="px-2 py-1.5 min-w-[260px] max-w-[400px] relative">
                        {(() => {
                          const originalTitle = listing.title;
                          const editedTitle = '__title__' in itemEdits ? itemEdits['__title__'] : originalTitle;
                          const isTitleEdited = '__title__' in itemEdits;
                          const isTitleEditing = editingCell?.itemId === listing.itemId && editingCell?.col === '__title__';
                          return (
                            <EditableCell
                              value={editedTitle}
                              edited={isTitleEdited}
                              isEditing={isTitleEditing}
                              submitResult={isItemPending ? 'pending' : submitResult}
                              onStartEdit={() => !isItemPending && startEdit(listing.itemId, '__title__')}
                              onCommit={(v) => commitEdit(listing.itemId, '__title__', v)}
                              onCancel={cancelEdit}
                            />
                          );
                        })()}
                      </td>

                      {/* Specifics (editable) */}
                      {columns.map((col) => {
                        if (!specsLoaded) {
                          return (
                            <td key={col} className="px-3 py-2">
                              {specs === 'loading' || specs === undefined
                                ? <div className="h-2.5 w-12 bg-gray-800 rounded animate-pulse" />
                                : specsError
                                  ? <span className="text-[10px] text-red-700">err</span>
                                  : <span className="text-xs text-gray-800">—</span>
                              }
                            </td>
                          );
                        }

                        const originalVal = getSpecificValue(specs as NameValuePair[], col);
                        const editedVal = col in itemEdits ? itemEdits[col] : originalVal;
                        const isEdited = col in itemEdits;
                        const isEditing =
                          editingCell?.itemId === listing.itemId && editingCell?.col === col;

                        return (
                          <td key={col} className="px-2 py-1.5 whitespace-nowrap">
                            <EditableCell
                              value={editedVal}
                              edited={isEdited}
                              isEditing={isEditing}
                              submitResult={isItemPending ? 'pending' : submitResult}
                              onStartEdit={() => !isItemPending && startEdit(listing.itemId, col)}
                              onCommit={(v) => commitEdit(listing.itemId, col, v)}
                              onCancel={cancelEdit}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
          </tbody>
        </table>

        {/* Reveal-more sentinel */}
        <div ref={sentinelRef} className="h-16 flex items-center justify-center">
          {!loading && visibleCount < sortedFiltered.length && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <div className="w-4 h-4 border-2 border-gray-700 border-t-green-500 rounded-full animate-spin" />
              Showing more…
            </div>
          )}
          {!loading && sortedFiltered.length === 0 && !error && (
            <p className="text-xs text-gray-600">No listings found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
