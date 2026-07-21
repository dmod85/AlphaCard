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
  description: string;
}

const PRIORITY_COLS = [
  'Sport',
  'Player/Athlete',
  'Team',
  'Manufacturer',
  'Set',
  'Parallel/Variety',
  'Insert',
  'Card Number',
  'League',
  'Season',
  'Year Manufactured',
];

// Columns that should be flagged when left blank on a listing
const HIGHLIGHT_EMPTY_COLS = new Set(['Sport', 'Player/Athlete', 'Team', 'Manufacturer', 'Set']);

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

// ── Advanced field filtering ──────────────────────────────────────────────
type FilterOperator =
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'starts_with' | 'ends_with'
  | 'is_empty' | 'is_not_empty';

interface FilterCondition {
  id: string;
  column: string; // '__title__' or a specifics column name
  operator: FilterOperator;
  value: string;
  joiner: 'AND' | 'OR'; // how this condition combines with the accumulated result so far (ignored for the first row)
}

const FILTER_OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: 'equals', label: 'is' },
  { value: 'not_equals', label: 'is not' },
  { value: 'contains', label: 'contains' },
  { value: 'not_contains', label: 'does not contain' },
  { value: 'starts_with', label: 'starts with' },
  { value: 'ends_with', label: 'ends with' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

function isValuelessOperator(op: FilterOperator): boolean {
  return op === 'is_empty' || op === 'is_not_empty';
}

function getSpecificValue(specifics: NameValuePair[], colName: string): string {
  const lower = colName.toLowerCase().trim();
  const pair = specifics.find((s) => s.name.toLowerCase().trim() === lower);
  return pair?.value ?? '';
}

// Builds the listing title strictly from eBay item specifics — mirrors
// buildSeoTitle() in app/api/ebay/active-listings/route.ts:
//   [Set] - [Player/Athlete] [Card Number] - [Parallel/Variety] [Team]
// The Set field is used as-is for Year/Brand/Set (eBay's Set value already
// carries all three, e.g. "2024 Topps Chrome"). Parallel/Variety is omitted
// when it's just "Base". Team is only appended if it fits under MAX_LENGTH.
const TITLE_MAX_LENGTH = 80;

function buildTitleFromSpecifics(fields: {
  set: string;
  player: string;
  cardNumber: string;
  parallel: string;
  insert: string;
  team: string;
}): string {
  const na = (v: string) => v.trim().toLowerCase() === 'n/a' ? '' : v.trim();
  const notBase = (v: string) => v.replace(/[[\]]/g, '').trim().toLowerCase() === 'base' ? '' : v;

  const set = na(fields.set);
  const player = na(fields.player);

  const cardNumberRaw = na(fields.cardNumber);
  const cardNumber = cardNumberRaw
    ? (cardNumberRaw.startsWith('#') ? cardNumberRaw.toUpperCase() : `#${cardNumberRaw.toUpperCase()}`)
    : '';

  const parallel = notBase(na(fields.parallel));
  const insert = notBase(na(fields.insert));

  const team = na(fields.team);

  const parts: string[] = [];
  if (set) parts.push(set);

  if (player) {
    if (set) parts.push('-');
    parts.push(player);
  }

  if (cardNumber) parts.push(cardNumber);

  if (parallel || insert) {
    if (set || player) parts.push('-');
    if (parallel) parts.push(parallel);
    if (insert) parts.push(insert);
  }

  let title = parts.join(' ').replace(/\s{2,}/g, ' ').trim();

  // Attributes: only add the full team name if there's room within the title limit
  if (team) {
    const withTeam = `${title} ${team}`.replace(/\s{2,}/g, ' ').trim();
    if (withTeam.length <= TITLE_MAX_LENGTH) {
      title = withTeam;
    }
  }

  // Truncate to eBay's 80-character hard limit without splitting words
  if (title.length > TITLE_MAX_LENGTH) {
    const cut = title.lastIndexOf(' ', TITLE_MAX_LENGTH);
    title = title.substring(0, cut > TITLE_MAX_LENGTH - 15 ? cut : TITLE_MAX_LENGTH).trim();
  }

  return title;
}

// Builds the listing description from its title — mirrors buildDescription()
// in app/api/ebay/active-listings/route.ts. Kept in sync with whatever title
// is currently in effect (auto-generated or manually locked).
function buildDescriptionFromTitle(title: string): string {
  return `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.8;color:#222;max-width:700px">
  <p><b>Card Details:</b> &gt; ${title}.</p>
  <p><b>Condition:</b> &gt; Pack fresh, placed directly into a penny sleeve and toploader. Card is Near Mint or Better. Please see high-resolution photos for exact condition.</p>
  <p><b>Shipping:</b> &gt; Shipped securely via eBay Standard Envelope in a reinforced mailer to ensure it arrives safely.</p>
</div>`;
}

// Whitespace-insensitive comparison — mirrors normalizeDesc() server-side
function normalizeDescription(html: string): string {
  return html.replace(/[\s\r\n]+/g, ' ').trim();
}

/** Strips HTML tags down to a compact plain-text preview for the Description Check panel */
function stripHtmlPreview(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Current value shown for a listing's column, accounting for unsaved edits */
function getFieldValue(listing: ActiveListing, col: string, specificMap: SpecificMap, edits: EditMap): string {
  if (col === '__title__') {
    return edits[listing.itemId]?.['__title__'] ?? listing.title;
  }
  const specs = specificMap[listing.itemId];
  const original = Array.isArray(specs) ? getSpecificValue(specs, col) : '';
  return edits[listing.itemId]?.[col] ?? original;
}

function matchesCondition(value: string, operator: FilterOperator, condValue: string): boolean {
  const v = value.trim().toLowerCase();
  const c = condValue.trim().toLowerCase();
  switch (operator) {
    case 'equals': return v === c;
    case 'not_equals': return v !== c;
    case 'contains': return v.includes(c);
    case 'not_contains': return !v.includes(c);
    case 'starts_with': return v.startsWith(c);
    case 'ends_with': return v.endsWith(c);
    case 'is_empty': return v === '';
    case 'is_not_empty': return v !== '';
  }
}

/** Evaluates a sequence of conditions left-to-right, combining with each row's own AND/OR joiner */
function evaluateConditions(
  listing: ActiveListing,
  conditions: FilterCondition[],
  specificMap: SpecificMap,
  edits: EditMap
): boolean {
  let result: boolean | null = null;
  for (const cond of conditions) {
    const value = getFieldValue(listing, cond.column, specificMap, edits);
    const match = matchesCondition(value, cond.operator, cond.value);
    result = result === null ? match : (cond.joiner === 'AND' ? result && match : result || match);
  }
  return result ?? true;
}

// MMA is an individual sport — there's no Team to report, so eBay's
// required "Team" specific gets auto-filled with N/A instead of being left
// blank (which would otherwise need a manual edit on every MMA listing).
function isMma(sportValue: string): boolean {
  return sportValue.trim().toUpperCase().includes('MMA');
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
      <td className="px-3 py-2 w-14">
        <div className="h-10 w-10 bg-gray-800 rounded" />
      </td>
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
  highlightEmpty,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  value: string;
  edited: boolean;
  isEditing: boolean;
  submitResult?: 'pending' | 'success' | string;
  highlightEmpty?: boolean;
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
  const isFlaggedEmpty = highlightEmpty && !value && !edited && !isSuccess && !isError;

  return (
    <div
      onClick={isPending ? undefined : onStartEdit}
      className={`
        group relative min-w-[60px] rounded px-1.5 py-0.5 text-xs cursor-text transition-all
        ${isPending ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-700/60'}
        ${edited && !isSuccess && !isError ? 'bg-amber-500/10 border border-amber-500/30' : ''}
        ${isSuccess ? 'bg-green-500/10 border border-green-500/30' : ''}
        ${isError ? 'bg-red-500/10 border border-red-500/30' : ''}
        ${isFlaggedEmpty ? 'bg-red-500/20 border border-red-500/40' : ''}
      `}
      title={isError ? String(submitResult) : edited ? 'Edited — click to change' : isFlaggedEmpty ? 'Missing required field — click to fill in' : 'Click to edit'}
    >
      {value ? (
        <span className={isSuccess ? 'text-green-300' : isError ? 'text-red-300' : edited ? 'text-amber-200' : 'text-gray-200'}>
          {value}
        </span>
      ) : (
        <span className={isFlaggedEmpty ? 'text-red-400' : 'text-gray-700 group-hover:text-gray-500 transition-colors'}>—</span>
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

  // ── Title sync state ────────────────────────────────────────────────────────
  const [titleSyncOpen, setTitleSyncOpen] = useState(false);
  const [titleSyncSelected, setTitleSyncSelected] = useState<Set<string>>(new Set());
  // itemId -> true once the title has been manually locked against the
  // auto-template (persisted in Supabase — see /api/ebay/title-locks)
  const [titleLocked, setTitleLockedMap] = useState<Record<string, boolean>>({});

  // ── Description sync state ──────────────────────────────────────────────────
  const [descSyncOpen, setDescSyncOpen] = useState(false);
  const [descSyncSelected, setDescSyncSelected] = useState<Set<string>>(new Set());

  // ── Duplicate check state ───────────────────────────────────────────────────
  const [dupCheckOpen, setDupCheckOpen] = useState(false);

  // ── Advanced filter state ───────────────────────────────────────────────────
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);

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
  // Bumped on every loadEverything() call. All shared refs above (fetchingRef,
  // specQueueRef, pagesDoneRef) and the async work below are keyed off this —
  // without it, a second call (StrictMode's double-invoke on mount, or hitting
  // Refresh while a load is still in flight) races the first one on the same
  // refs/state, double-counting listings and leaving the "loading…" indicator
  // stuck since one call's finally block can clobber the other's flags.
  const loadGenRef = useRef(0);

  // ── Fetch a batch of item specifics (server caches these in Supabase) ────
  const fetchSpecifics = useCallback(async (itemIds: string[], gen: number) => {
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
      if (gen !== loadGenRef.current) return; // superseded by a newer load — drop the result
      const results = data.results as { itemId: string; specifics: NameValuePair[]; titleLocked: boolean }[];
      setSpecificMap((prev) => {
        const next = { ...prev };
        for (const r of results) {
          next[r.itemId] = r.specifics;
          fetchingRef.current.delete(r.itemId);
        }
        return next;
      });
      setTitleLockedMap((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.itemId] = r.titleLocked;
        return next;
      });
      // Auto-fill Team = N/A for MMA listings that don't already have one
      setEdits((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const r of results) {
          if (!isMma(getSpecificValue(r.specifics, 'Sport'))) continue;
          if (getSpecificValue(r.specifics, 'Team').trim()) continue;
          if (next[r.itemId]?.Team) continue;
          next[r.itemId] = { ...(next[r.itemId] || {}), Team: 'N/A' };
          changed = true;
        }
        return changed ? next : prev;
      });
    } catch {
      if (gen !== loadGenRef.current) return; // superseded — nothing to reconcile
      setSpecificMap((prev) => {
        const next = { ...prev };
        toFetch.forEach((id) => { next[id] = 'error'; fetchingRef.current.delete(id); });
        return next;
      });
    }
  }, []);

  // Persistent pool of workers that drain specQueueRef as items land in it —
  // started once per load, they keep pulling batches until every page has
  // been fetched *and* the queue is empty. Each worker bails immediately once
  // a newer load has started (gen mismatch), instead of continuing to drain
  // a queue/ref set that the new load has already reset out from under it.
  const runSpecificsWorkers = useCallback(async (gen: number) => {
    async function worker() {
      while (gen === loadGenRef.current) {
        const batch = specQueueRef.current.splice(0, SPEC_BATCH);
        if (batch.length > 0) {
          await fetchSpecifics(batch, gen);
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
    const gen = ++loadGenRef.current;

    setLoading(true);
    setPagesLoading(true);
    setError(null);
    setAllListings([]);
    setSpecificMap({});
    setTitleLockedMap({});
    setVisibleCount(ROW_BATCH);
    fetchingRef.current.clear();
    specQueueRef.current = [];
    pagesDoneRef.current = false;

    const specificsDone = runSpecificsWorkers(gen);

    try {
      let page = 1;
      let totalPages = 1;
      while (page <= totalPages) {
        if (gen !== loadGenRef.current) return; // superseded by a newer load — stop paging
        const res = await fetch(`/api/ebay/active-listings?page=${page}`);
        const data = await res.json();
        if (gen !== loadGenRef.current) return; // superseded while the request was in flight
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
      if (gen === loadGenRef.current) setError(err.message);
    } finally {
      if (gen === loadGenRef.current) {
        setLoading(false);
        setPagesLoading(false);
      }
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

  // ── Title sync: listings whose title doesn't match the generated template ──
  const titleMismatches = useMemo(() => {
    const results: { itemId: string; currentTitle: string; suggestedTitle: string }[] = [];
    for (const listing of allListings) {
      if (titleLocked[listing.itemId]) continue;
      const specs = specificMap[listing.itemId];
      if (!Array.isArray(specs)) continue;
      const itemEdits = edits[listing.itemId] || {};
      const effective = (col: string) => itemEdits[col] ?? getSpecificValue(specs, col);
      const currentTitle = (itemEdits['__title__'] ?? listing.title).trim();
      const suggestedTitle = buildTitleFromSpecifics({
        set: effective('Set'),
        player: effective('Player/Athlete'),
        cardNumber: effective('Card Number'),
        parallel: effective('Parallel/Variety'),
        insert: effective('Insert'),
        team: effective('Team'),
      });
      if (suggestedTitle && suggestedTitle !== currentTitle) {
        results.push({ itemId: listing.itemId, currentTitle, suggestedTitle });
      }
    }
    return results;
  }, [allListings, specificMap, edits, titleLocked]);

  const titleSyncMismatchIds = useMemo(() => new Set(titleMismatches.map((m) => m.itemId)), [titleMismatches]);
  const lockedCount = useMemo(() => Object.values(titleLocked).filter(Boolean).length, [titleLocked]);

  const toggleTitleSyncSelected = useCallback((itemId: string) => {
    setTitleSyncSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

  const toggleTitleSyncSelectAll = useCallback(() => {
    setTitleSyncSelected((prev) =>
      prev.size === titleMismatches.length ? new Set() : new Set(titleMismatches.map((m) => m.itemId))
    );
  }, [titleMismatches]);

  const applyTitleSync = useCallback(() => {
    const toApply = titleMismatches.filter((m) => titleSyncSelected.has(m.itemId));
    if (toApply.length === 0) return;
    setEdits((prev) => {
      const next = { ...prev };
      for (const m of toApply) {
        next[m.itemId] = { ...(next[m.itemId] || {}), __title__: m.suggestedTitle };
      }
      return next;
    });
    setSubmitResults((prev) => {
      const next = { ...prev };
      for (const m of toApply) delete next[m.itemId];
      return next;
    });
    setTitleSyncSelected(new Set());
  }, [titleMismatches, titleSyncSelected]);

  // Lock (or unlock) a listing's title against the auto-template — persisted
  // in Supabase so it stays skipped across reloads. Optimistic with rollback.
  const toggleTitleLock = useCallback(async (itemId: string, locked: boolean) => {
    setTitleLockedMap((prev) => ({ ...prev, [itemId]: locked }));
    setTitleSyncSelected((prev) => {
      if (!prev.has(itemId)) return prev;
      const next = new Set(prev);
      next.delete(itemId);
      return next;
    });
    try {
      const res = await fetch('/api/ebay/title-locks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, locked }),
      });
      if (!res.ok) throw new Error('Failed to update title lock');
    } catch {
      setTitleLockedMap((prev) => ({ ...prev, [itemId]: !locked }));
    }
  }, []);

  // ── Description sync: listings whose description doesn't match the template
  // built from whatever title is currently in effect (auto-generated, edited,
  // or locked) — independent of Title Check, so a locked custom title still
  // gets a properly formatted description.
  const descriptionMismatches = useMemo(() => {
    const results: { itemId: string; currentDescription: string; suggestedDescription: string }[] = [];
    for (const listing of allListings) {
      const itemEdits = edits[listing.itemId] || {};
      const currentTitle = (itemEdits['__title__'] ?? listing.title).trim();
      if (!currentTitle) continue;
      const currentDescription = itemEdits['__description__'] ?? listing.description ?? '';
      const suggestedDescription = buildDescriptionFromTitle(currentTitle);
      if (normalizeDescription(currentDescription) !== normalizeDescription(suggestedDescription)) {
        results.push({ itemId: listing.itemId, currentDescription, suggestedDescription });
      }
    }
    return results;
  }, [allListings, edits]);

  const descSyncMismatchIds = useMemo(() => new Set(descriptionMismatches.map((m) => m.itemId)), [descriptionMismatches]);

  // ── Duplicate check: group listings by Set+Player+CardNumber+Parallel+Insert ──
  // Only considers listings whose specifics have fully loaded.
  const duplicateGroups = useMemo(() => {
    // Build a fingerprint for each listing
    const grouped = new Map<string, { itemId: string; title: string; url: string }[]>();
    for (const listing of allListings) {
      const specs = specificMap[listing.itemId];
      if (!Array.isArray(specs)) continue;
      const itemEdits = edits[listing.itemId] || {};
      const effective = (col: string) => itemEdits[col] ?? getSpecificValue(specs, col);
      const key = [
        effective('Set').trim().toLowerCase(),
        effective('Player/Athlete').trim().toLowerCase(),
        effective('Card Number').trim().replace(/^#/, '').toLowerCase(),
        effective('Parallel/Variety').trim().toLowerCase(),
        effective('Insert').trim().toLowerCase(),
      ].join('|');
      // Skip listings with an empty key (all five specifics are blank)
      if (key === '||||') continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push({ itemId: listing.itemId, title: listing.title, url: listing.url });
    }
    // Return only groups with more than one listing
    return Array.from(grouped.values()).filter((g) => g.length > 1);
  }, [allListings, specificMap, edits]);

  const duplicateItemIds = useMemo(
    () => new Set(duplicateGroups.flatMap((g) => g.map((l) => l.itemId))),
    [duplicateGroups]
  );

  const toggleDescSyncSelected = useCallback((itemId: string) => {
    setDescSyncSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

  const toggleDescSyncSelectAll = useCallback(() => {
    setDescSyncSelected((prev) =>
      prev.size === descriptionMismatches.length ? new Set() : new Set(descriptionMismatches.map((m) => m.itemId))
    );
  }, [descriptionMismatches]);

  const applyDescSync = useCallback(() => {
    const toApply = descriptionMismatches.filter((m) => descSyncSelected.has(m.itemId));
    if (toApply.length === 0) return;
    setEdits((prev) => {
      const next = { ...prev };
      for (const m of toApply) {
        next[m.itemId] = { ...(next[m.itemId] || {}), __description__: m.suggestedDescription };
      }
      return next;
    });
    setSubmitResults((prev) => {
      const next = { ...prev };
      for (const m of toApply) delete next[m.itemId];
      return next;
    });
    setDescSyncSelected(new Set());
  }, [descriptionMismatches, descSyncSelected]);

  // ── Advanced filter handlers ────────────────────────────────────────────────
  const addFilterCondition = useCallback(() => {
    setFilterConditions((prev) => [
      ...prev,
      { id: crypto.randomUUID(), column: '__title__', operator: 'equals', value: '', joiner: 'AND' },
    ]);
    setFilterPanelOpen(true);
  }, []);

  const updateFilterCondition = useCallback((id: string, patch: Partial<FilterCondition>) => {
    setFilterConditions((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const removeFilterCondition = useCallback((id: string) => {
    setFilterConditions((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const clearFilters = useCallback(() => {
    setFilterConditions([]);
  }, []);

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

    // MMA has no Team — auto-fill it with N/A when Sport is set to MMA
    if (col === 'Sport' && isMma(newVal)) {
      const specs = specificMap[itemId];
      const existingTeam = Array.isArray(specs) ? getSpecificValue(specs, 'Team') : '';
      setEdits((prev) => {
        const currentTeam = prev[itemId]?.Team ?? existingTeam;
        if (currentTeam.trim()) return prev;
        return { ...prev, [itemId]: { ...(prev[itemId] || {}), Team: 'N/A' } };
      });
    }

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

      // Pull out title/description edits if present
      const newTitle = itemEdits['__title__'] ?? undefined;
      const newDescription = itemEdits['__description__'] ?? undefined;

      // Merge specifics edits (exclude the __title__/__description__ keys)
      const mergedMap = new Map<string, string>(baseSpecs.map((s) => [s.name.toLowerCase().trim(), s.value]));
      const displayNames = new Map<string, string>(baseSpecs.map((s) => [s.name.toLowerCase().trim(), s.name]));

      for (const [col, val] of Object.entries(itemEdits)) {
        if (col === '__title__' || col === '__description__') continue;
        const key = col.toLowerCase().trim();
        mergedMap.set(key, val);
        if (!displayNames.has(key)) displayNames.set(key, col);
      }

      const specifics: NameValuePair[] = Array.from(mergedMap.entries())
        .filter(([, v]) => v.trim())
        .map(([key, value]) => ({ name: displayNames.get(key) || key, value }));

      return { itemId, specifics, title: newTitle, description: newDescription };
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
        // Sync updated titles/descriptions back into allListings
        setAllListings((prev) =>
          prev.map((l) => {
            if (!successIds.has(l.itemId)) return l;
            const item = items.find((i) => i.itemId === l.itemId);
            if (!item) return l;
            return {
              ...l,
              ...(item.title ? { title: item.title } : {}),
              ...(item.description ? { description: item.description } : {}),
            };
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
  // Only conditions with a usable value (or a valueless operator) actually filter anything
  const activeFilterConditions = useMemo(
    () => filterConditions.filter((c) => isValuelessOperator(c.operator) || c.value.trim() !== ''),
    [filterConditions]
  );

  const filtered = useMemo(() => {
    let result = search.trim()
      ? allListings.filter((l) => l.title.toLowerCase().includes(search.toLowerCase()))
      : allListings;

    if (activeFilterConditions.length > 0) {
      result = result.filter((l) => evaluateConditions(l, activeFilterConditions, specificMap, edits));
    }

    return result;
  }, [allListings, search, activeFilterConditions, specificMap, edits]);

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

        {/* Advanced filter toggle */}
        <button
          onClick={() => setFilterPanelOpen((v) => !v)}
          className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs rounded-lg transition ${
            filterPanelOpen || activeFilterConditions.length > 0
              ? 'bg-blue-500/15 border-blue-500/40 text-blue-300 hover:bg-blue-500/25'
              : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-300'
          }`}
        >
          ⚗ Filter
          {activeFilterConditions.length > 0 && (
            <span className="inline-flex items-center justify-center w-4 h-4 bg-blue-500/30 text-blue-300 rounded-full text-[10px] font-bold">
              {activeFilterConditions.length}
            </span>
          )}
        </button>

        {/* Clear filters */}
        {filterConditions.length > 0 && (
          <button
            onClick={clearFilters}
            className="px-3 py-1.5 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/30 text-blue-400 text-xs rounded-lg transition"
          >
            ✕ Clear filters
          </button>
        )}

        {/* Title sync toggle */}
        <button
          onClick={() => setTitleSyncOpen((v) => !v)}
          title="Find listings whose title doesn't match the generated template (Set - Player # - Parallel Team)"
          className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs rounded-lg transition ${
            titleSyncOpen
              ? 'bg-teal-500/15 border-teal-500/40 text-teal-300 hover:bg-teal-500/25'
              : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-300'
          }`}
        >
          🏷 Title Check
          {titleMismatches.length > 0 && (
            <span className="inline-flex items-center justify-center w-4 h-4 bg-teal-500/30 text-teal-300 rounded-full text-[10px] font-bold">
              {titleMismatches.length}
            </span>
          )}
        </button>

        {/* Description sync toggle */}
        <button
          onClick={() => setDescSyncOpen((v) => !v)}
          title="Find listings whose description doesn't match the generated template built from the current title"
          className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs rounded-lg transition ${
            descSyncOpen
              ? 'bg-indigo-500/15 border-indigo-500/40 text-indigo-300 hover:bg-indigo-500/25'
              : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-300'
          }`}
        >
          📝 Description Check
          {descriptionMismatches.length > 0 && (
            <span className="inline-flex items-center justify-center w-4 h-4 bg-indigo-500/30 text-indigo-300 rounded-full text-[10px] font-bold">
              {descriptionMismatches.length}
            </span>
          )}
        </button>

        {/* Duplicate listing check toggle */}
        <button
          onClick={() => setDupCheckOpen((v) => !v)}
          title="Find listings that appear to be duplicates (same Set, Player, Card Number, and Parallel/Variety)"
          className={`flex items-center gap-1.5 px-3 py-1.5 border text-xs rounded-lg transition ${
            dupCheckOpen
              ? 'bg-orange-500/15 border-orange-500/40 text-orange-300 hover:bg-orange-500/25'
              : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-300'
          }`}
        >
          🔎 Duplicate Check
          {duplicateGroups.length > 0 && (
            <span className="inline-flex items-center justify-center w-4 h-4 bg-orange-500/30 text-orange-300 rounded-full text-[10px] font-bold">
              {duplicateGroups.length}
            </span>
          )}
        </button>

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

      {/* ── Advanced Filter Panel ── */}
      {filterPanelOpen && (
        <div className="bg-gray-900/98 border-b border-blue-500/40 px-5 py-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-blue-400/70 uppercase tracking-widest font-semibold">Filter listings</span>
            <button
              onClick={() => setFilterPanelOpen(false)}
              className="px-2 py-1 text-gray-600 hover:text-gray-400 text-xs rounded transition"
              title="Close"
            >
              ✕
            </button>
          </div>

          {filterConditions.length === 0 && (
            <p className="text-xs text-gray-600">No conditions yet — add one to filter by any field (e.g. Sport is Soccer).</p>
          )}

          {filterConditions.map((cond, idx) => (
            <div key={cond.id} className="flex items-center gap-2 flex-wrap">
              {idx === 0 ? (
                <span className="w-14 shrink-0 text-[10px] text-gray-600 uppercase tracking-wide">Where</span>
              ) : (
                <select
                  value={cond.joiner}
                  onChange={(e) => updateFilterCondition(cond.id, { joiner: e.target.value as 'AND' | 'OR' })}
                  className="w-14 shrink-0 bg-gray-800 border border-gray-700 rounded-lg px-1.5 py-1.5 text-xs text-blue-300 font-semibold outline-none focus:border-blue-500/60"
                >
                  <option value="AND">AND</option>
                  <option value="OR">OR</option>
                </select>
              )}

              <select
                value={cond.column}
                onChange={(e) => updateFilterCondition(cond.id, { column: e.target.value })}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500/60 max-w-[180px]"
              >
                <option value="__title__">Title</option>
                {columns.map((col) => (
                  <option key={col} value={col}>{col}</option>
                ))}
              </select>

              <select
                value={cond.operator}
                onChange={(e) => updateFilterCondition(cond.id, { operator: e.target.value as FilterOperator })}
                className="bg-gray-800 border border-gray-700 rounded-lg px-2 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500/60"
              >
                {FILTER_OPERATORS.map((op) => (
                  <option key={op.value} value={op.value}>{op.label}</option>
                ))}
              </select>

              {!isValuelessOperator(cond.operator) && (
                <input
                  type="text"
                  value={cond.value}
                  onChange={(e) => updateFilterCondition(cond.id, { value: e.target.value })}
                  placeholder="Value…"
                  className="bg-gray-800 border border-gray-700 focus:border-blue-500/60 rounded-lg px-3 py-1.5 text-xs text-gray-200 placeholder-gray-600 outline-none w-40 transition"
                />
              )}

              <button
                onClick={() => removeFilterCondition(cond.id)}
                className="px-2 py-1.5 text-gray-600 hover:text-red-400 text-xs rounded transition"
                title="Remove condition"
              >
                🗑
              </button>
            </div>
          ))}

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={addFilterCondition}
              className="px-3 py-1.5 bg-blue-500/15 hover:bg-blue-500/25 border border-blue-500/40 hover:border-blue-400/60 text-blue-300 text-xs rounded-lg font-medium transition"
            >
              + Add condition
            </button>
            {activeFilterConditions.length > 0 && (
              <span className="text-[11px] text-gray-500">
                {sortedFiltered.length.toLocaleString()} match{sortedFiltered.length === 1 ? '' : 'es'}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── Title Sync Panel ── */}
      {titleSyncOpen && (
        <div className="bg-gray-900/98 border-b border-teal-500/40 px-5 py-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-teal-400/70 uppercase tracking-widest font-semibold">
                Titles not matching template
              </span>
              {lockedCount > 0 && (
                <span className="text-[11px] text-gray-600">
                  🔒 {lockedCount.toLocaleString()} title{lockedCount === 1 ? '' : 's'} locked (skipped)
                </span>
              )}
            </div>
            <button
              onClick={() => setTitleSyncOpen(false)}
              className="px-2 py-1 text-gray-600 hover:text-gray-400 text-xs rounded transition"
              title="Close"
            >
              ✕
            </button>
          </div>

          {titleMismatches.length === 0 ? (
            <p className="text-xs text-gray-600">
              {specificsPending
                ? 'Still loading item specifics — checking as they come in…'
                : lockedCount > 0
                  ? `Every unlocked listing's title matches its template. ${lockedCount.toLocaleString()} title${lockedCount === 1 ? ' is' : 's are'} locked and skipped.`
                  : 'Every loaded listing’s title matches its template. Nice.'}
            </p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-gray-400">
                  <input
                    type="checkbox"
                    checked={titleSyncSelected.size === titleMismatches.length}
                    ref={(el) => {
                      if (el) el.indeterminate = titleSyncSelected.size > 0 && titleSyncSelected.size < titleMismatches.length;
                    }}
                    onChange={toggleTitleSyncSelectAll}
                    className="w-3.5 h-3.5 accent-teal-500"
                  />
                  Select all ({titleMismatches.length.toLocaleString()})
                  {allListings.length < total && (
                    <span className="text-gray-700"> (in {allListings.length.toLocaleString()} loaded)</span>
                  )}
                </label>

                <button
                  onClick={applyTitleSync}
                  disabled={titleSyncSelected.size === 0}
                  className="ml-auto px-3 py-1.5 bg-teal-500/15 hover:bg-teal-500/25 border border-teal-500/40 hover:border-teal-400/60 text-teal-300 text-xs rounded-lg font-medium transition disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Update selected ({titleSyncSelected.size})
                </button>
              </div>

              <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800/70">
                {titleMismatches.map((m) => (
                  <div
                    key={m.itemId}
                    className="flex items-start gap-2.5 px-3 py-2 hover:bg-gray-800/40"
                  >
                    <label className="flex items-start gap-2.5 flex-1 min-w-0 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={titleSyncSelected.has(m.itemId)}
                        onChange={() => toggleTitleSyncSelected(m.itemId)}
                        className="mt-0.5 w-3.5 h-3.5 accent-teal-500 shrink-0"
                      />
                      <div className="min-w-0 flex-1 text-xs">
                        <p className="text-gray-500 truncate" title={m.currentTitle}>
                          <span className="text-gray-700">was</span> {m.currentTitle || <em className="text-gray-700">(empty)</em>}
                        </p>
                        <p className="text-teal-300 truncate" title={m.suggestedTitle}>
                          <span className="text-teal-600">→</span> {m.suggestedTitle}
                        </p>
                      </div>
                    </label>
                    <button
                      onClick={() => toggleTitleLock(m.itemId, true)}
                      title="This title is fine as-is — lock it so Title Check stops flagging it"
                      className="shrink-0 px-2 py-1 bg-gray-800 hover:bg-amber-500/15 border border-gray-700 hover:border-amber-500/40 text-gray-400 hover:text-amber-300 text-[11px] rounded transition"
                    >
                      🔒 Skip
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Description Sync Panel ── */}
      {descSyncOpen && (
        <div className="bg-gray-900/98 border-b border-indigo-500/40 px-5 py-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-indigo-400/70 uppercase tracking-widest font-semibold">
              Descriptions not matching template
            </span>
            <button
              onClick={() => setDescSyncOpen(false)}
              className="px-2 py-1 text-gray-600 hover:text-gray-400 text-xs rounded transition"
              title="Close"
            >
              ✕
            </button>
          </div>

          {descriptionMismatches.length === 0 ? (
            <p className="text-xs text-gray-600">Every loaded listing’s description matches its template. Nice.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-1.5 cursor-pointer select-none text-xs text-gray-400">
                  <input
                    type="checkbox"
                    checked={descSyncSelected.size === descriptionMismatches.length}
                    ref={(el) => {
                      if (el) el.indeterminate = descSyncSelected.size > 0 && descSyncSelected.size < descriptionMismatches.length;
                    }}
                    onChange={toggleDescSyncSelectAll}
                    className="w-3.5 h-3.5 accent-indigo-500"
                  />
                  Select all ({descriptionMismatches.length.toLocaleString()})
                  {allListings.length < total && (
                    <span className="text-gray-700"> (in {allListings.length.toLocaleString()} loaded)</span>
                  )}
                </label>

                <button
                  onClick={applyDescSync}
                  disabled={descSyncSelected.size === 0}
                  className="ml-auto px-3 py-1.5 bg-indigo-500/15 hover:bg-indigo-500/25 border border-indigo-500/40 hover:border-indigo-400/60 text-indigo-300 text-xs rounded-lg font-medium transition disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Rewrite selected ({descSyncSelected.size})
                </button>
              </div>

              <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800/70">
                {descriptionMismatches.map((m) => (
                  <label
                    key={m.itemId}
                    className="flex items-start gap-2.5 px-3 py-2 hover:bg-gray-800/40 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={descSyncSelected.has(m.itemId)}
                      onChange={() => toggleDescSyncSelected(m.itemId)}
                      className="mt-0.5 w-3.5 h-3.5 accent-indigo-500 shrink-0"
                    />
                    <div className="min-w-0 flex-1 text-xs">
                      <p className="text-gray-500 truncate" title={stripHtmlPreview(m.currentDescription)}>
                        <span className="text-gray-700">was</span> {stripHtmlPreview(m.currentDescription) || <em className="text-gray-700">(empty)</em>}
                      </p>
                      <p className="text-indigo-300 truncate" title={stripHtmlPreview(m.suggestedDescription)}>
                        <span className="text-indigo-600">→</span> {stripHtmlPreview(m.suggestedDescription)}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Duplicate Check Panel ── */}
      {dupCheckOpen && (
        <div className="bg-gray-900/98 border-b border-orange-500/40 px-5 py-3 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-orange-400/70 uppercase tracking-widest font-semibold">
                Possible duplicate listings
              </span>
              <span className="text-[11px] text-gray-600">
                Grouped by Set · Player · Card # · Parallel
              </span>
            </div>
            <button
              onClick={() => setDupCheckOpen(false)}
              className="px-2 py-1 text-gray-600 hover:text-gray-400 text-xs rounded transition"
              title="Close"
            >
              ✕
            </button>
          </div>

          {specificsPending && duplicateGroups.length === 0 && (
            <p className="text-xs text-gray-600">Still loading item specifics — checking as they come in…</p>
          )}

          {!specificsPending && duplicateGroups.length === 0 && (
            <p className="text-xs text-gray-600">No duplicate listings detected. Nice.</p>
          )}

          {duplicateGroups.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-800 divide-y divide-gray-800/70">
              {duplicateGroups.map((group, gi) => (
                <div key={gi} className="px-3 py-2">
                  <p className="text-[10px] text-orange-400/70 uppercase tracking-widest font-semibold mb-1">
                    Group {gi + 1} — {group.length} listings
                  </p>
                  <div className="space-y-0.5">
                    {group.map((item) => (
                      <div key={item.itemId} className="flex items-center gap-2">
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-orange-300/80 hover:text-orange-200 truncate flex-1 min-w-0 underline underline-offset-2 decoration-orange-500/30 hover:decoration-orange-300/60 transition-colors"
                          title={`Open on eBay: ${item.title}`}
                        >
                          {item.title || <em className="text-gray-600">(no title)</em>}
                        </a>
                        <span className="text-[10px] text-gray-700 shrink-0">{item.itemId}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
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
              {/* Thumbnail header */}
              <th className="px-3 py-3 w-14"></th>
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
                      className={`group border-b border-gray-800/50 transition-colors ${
                        isItemPending ? 'opacity-60' : 'hover:bg-gray-800/20'
                      }`}
                    >
                      {/* Thumbnail — opens the listing on eBay in a new tab */}
                      <td className="px-2 py-1.5 w-14">
                        <a
                          href={listing.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open listing on eBay"
                          className="block w-10 h-10 rounded overflow-hidden bg-gray-800 border border-gray-800 hover:border-green-500/50 transition-colors shrink-0"
                        >
                          {listing.pictureUrl ? (
                            <img
                              src={listing.pictureUrl}
                              alt=""
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <span className="w-full h-full flex items-center justify-center text-gray-700 text-[9px]">—</span>
                          )}
                        </a>
                      </td>

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
                        {!('__title__' in itemEdits) && titleSyncMismatchIds.has(listing.itemId) && (
                          <span
                            className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-teal-400 rounded-full"
                            title="Title doesn't match the generated template — see Title Check"
                          />
                        )}
                        {!('__description__' in itemEdits) && descSyncMismatchIds.has(listing.itemId) && (
                          <span
                            className="absolute bottom-1.5 right-1.5 w-1.5 h-1.5 bg-indigo-400 rounded-full"
                            title="Description doesn't match the generated template — see Description Check"
                          />
                        )}
                        {duplicateItemIds.has(listing.itemId) && (
                          <span
                            className="absolute bottom-1.5 left-1.5 w-1.5 h-1.5 bg-orange-400 rounded-full"
                            title="Possible duplicate listing — see Duplicate Check"
                          />
                        )}
                        <button
                          onClick={() => toggleTitleLock(listing.itemId, !titleLocked[listing.itemId])}
                          title={
                            titleLocked[listing.itemId]
                              ? 'Title locked — excluded from Title Check. Click to unlock.'
                              : 'Lock this title so Title Check always skips it'
                          }
                          className={`absolute top-1.5 left-1.5 leading-none text-[11px] transition-opacity ${
                            titleLocked[listing.itemId]
                              ? 'opacity-100 text-amber-400'
                              : 'opacity-0 group-hover:opacity-60 hover:!opacity-100 text-gray-600 hover:text-gray-300'
                          }`}
                        >
                          {titleLocked[listing.itemId] ? '🔒' : '🔓'}
                        </button>
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
                              highlightEmpty={HIGHLIGHT_EMPTY_COLS.has(col)}
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
