'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';

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

interface ComparableListing {
  itemId: string;
  title: string;
  price: number;
  url: string;
  pictureUrl?: string;
  condition?: string;
}

interface ComparableData {
  comparables: ComparableListing[];
  minPrice: number | null;
  maxPrice: number | null;
  avgPrice: number | null;
  medianPrice: number | null;
  count: number;
}

type ComparableState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'done'; data: ComparableData };

type SortKey = 'title' | 'price' | 'date' | 'seo';
type SortDir = 'asc' | 'desc';
type FilterMode = 'all' | 'dupes';
type ItemStatus = 'rewriting' | 'done' | 'error';

interface ItemState {
  status: ItemStatus;
  error?: string;
  generatedSku?: string;
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  return (
    <span className={`ml-1 text-[10px] ${active ? 'text-green-400' : 'text-gray-600'}`}>
      {active ? (dir === 'asc' ? '▲' : '▼') : '⇅'}
    </span>
  );
}

function LazyComparableLoader({ itemId, title, fetchComparablePrice, isFetched }: {
  itemId: string;
  title: string;
  fetchComparablePrice: (id: string, title: string) => void;
  isFetched: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isFetched) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        fetchComparablePrice(itemId, title);
        observer.disconnect();
      }
    }, { rootMargin: '500px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, [itemId, title, fetchComparablePrice, isFetched]);

  return <div ref={ref} className="absolute w-1 h-1 pointer-events-none" />;
}

export default function ActiveListingsPage() {
  const [listings, setListings] = useState<ActiveListing[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>({});
  const [rewriting, setRewriting] = useState(false);
  const [summary, setSummary] = useState<{ done: number; failed: number } | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [comparables, setComparables] = useState<Record<string, ComparableState>>({});
  const [openComparable, setOpenComparable] = useState<string | null>(null);

  // fetchDescriptions removed as requested by user

  const fetchComparablePrice = useCallback(async (itemId: string, title: string) => {
    setComparables(prev => ({ ...prev, [itemId]: { status: 'loading' } }));
    try {
      const res = await fetch(
        `/api/ebay/comparable-prices?${new URLSearchParams({ title, itemId })}`
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      setComparables(prev => ({ ...prev, [itemId]: { status: 'done', data } }));
    } catch (err: any) {
      setComparables(prev => ({ ...prev, [itemId]: { status: 'error', message: err.message } }));
    }
  }, []);

  const toggleComparableView = useCallback((itemId: string, title: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (openComparable === itemId) {
      setOpenComparable(null);
      return;
    }
    setOpenComparable(itemId);
    if (!comparables[itemId] || comparables[itemId].status === 'error') {
      fetchComparablePrice(itemId, title);
    }
  }, [openComparable, comparables, fetchComparablePrice]);

  const fetchListings = useCallback(async (pageNum = 1, append = false) => {
    if (append) setLoadingMore(true);
    else setLoading(true);
    
    if (!append) {
      setError(null);
      setNeedsAuth(false);
      setSelected(new Set());
      setItemStates({});
      setSummary(null);
      setDescriptions({});
    }

    try {
      const res = await fetch(`/api/ebay/active-listings?page=${pageNum}`);
      const data = await res.json();
      if (res.status === 401 || data.error === 'EBAY_AUTH_REQUIRED') {
        setNeedsAuth(true);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Failed to fetch listings');
      
      setListings(prev => append ? [...prev, ...data.listings] : data.listings);
      setTotal(data.total);
      setTotalPages(data.totalPages || 1);
      setPage(data.currentPage || 1);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('ebay_connected')) {
      window.history.replaceState({}, '', '/active-listings');
    }
    fetchListings(1, false);
  }, [fetchListings]);

  useEffect(() => {
    if (loading || loadingMore || page >= totalPages) return;
    
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        fetchListings(page + 1, true);
      }
    }, { rootMargin: '200px' });
    
    if (loadMoreRef.current) observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [loading, loadingMore, page, totalPages, fetchListings]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selected.size > 0 && selected.size < listings.length;
    }
  }, [selected, listings]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  // Detect duplicate titles (case-insensitive, punctuation-stripped)
  const duplicateItemIds = useMemo(() => {
    const normalizeTitle = (t: string) =>
      t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    const seen = new Map<string, string[]>();
    for (const l of listings) {
      const key = normalizeTitle(l.title);
      seen.set(key, [...(seen.get(key) ?? []), l.itemId]);
    }
    const dupeIds = new Set<string>();
    Array.from(seen.values()).forEach(ids => {
      if (ids.length > 1) ids.forEach(id => dupeIds.add(id));
    });
    return dupeIds;
  }, [listings]);

  const sortedListings = useMemo(() => {
    const base = filterMode === 'dupes'
      ? listings.filter(l => duplicateItemIds.has(l.itemId))
      : listings;
    return [...base].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'title') cmp = a.title.localeCompare(b.title);
      else if (sortKey === 'price') cmp = a.price - b.price;
      else if (sortKey === 'date') cmp = new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
      else if (sortKey === 'seo') cmp = (a.isSeoFriendly ? 1 : 0) - (b.isSeoFriendly ? 0 : 1);
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [listings, sortKey, sortDir, filterMode, duplicateItemIds]);

  const toggleAll = () => {
    if (selected.size === listings.length) setSelected(new Set());
    else setSelected(new Set(listings.map(l => l.itemId)));
  };

  const selectNeedsOptimization = () => {
    const unoptimized = listings.filter(l => !l.isSeoFriendly).map(l => l.itemId);
    setSelected(new Set(unoptimized));
  };

  const unoptimizedCount = listings.filter(l => !l.isSeoFriendly).length;

  const toggleItem = (itemId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  };

  const rewriteDescriptions = async () => {
    const items = listings
      .filter(l => selected.has(l.itemId))
      .map(l => ({ itemId: l.itemId, title: l.title }));
    if (items.length === 0) return;

    setRewriting(true);
    setSummary(null);

    const initial: Record<string, ItemState> = {};
    for (const item of items) initial[item.itemId] = { status: 'rewriting' };
    setItemStates(prev => ({ ...prev, ...initial }));

    try {
      const res = await fetch('/api/ebay/active-listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();

      const updates: Record<string, ItemState> = {};
      const successfulIds = new Set<string>();
      let done = 0, failed = 0;
      for (const result of (data.results || [])) {
        if (result.success) {
          updates[result.itemId] = { status: 'done', generatedSku: result.sku };
          successfulIds.add(result.itemId);
          done++;
        } else {
          updates[result.itemId] = { status: 'error', error: result.error };
          failed++;
        }
      }
      setItemStates(prev => ({ ...prev, ...updates }));
      if (successfulIds.size > 0) {
        setListings(prev => prev.map(l => 
          successfulIds.has(l.itemId) ? { ...l, isSeoFriendly: true } : l
        ));
      }
      setSummary({ done, failed });
    } catch {
      const errorUpdates: Record<string, ItemState> = {};
      for (const item of items) errorUpdates[item.itemId] = { status: 'error', error: 'Network error' };
      setItemStates(prev => ({ ...prev, ...errorUpdates }));
    } finally {
      setRewriting(false);
    }
  };

  const allSelected = listings.length > 0 && selected.size === listings.length;

  return (
    <div className="flex-1 p-6 bg-gray-900 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-white">Active eBay Listings</h1>
          {!loading && !error && (
            <p className="text-sm text-gray-500 mt-0.5">
              {listings.length} shown{total > listings.length ? ` of ${total} total` : ''}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => fetchListings(1, false)}
            disabled={loading || rewriting}
            className="px-3 py-1.5 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition disabled:opacity-50"
          >
            Refresh
          </button>
          {!loading && unoptimizedCount > 0 && (
            <button
              onClick={selectNeedsOptimization}
              disabled={rewriting}
              className="px-3 py-1.5 text-sm bg-gray-800 text-yellow-400 border border-yellow-500/30 rounded-lg hover:bg-yellow-500/10 transition disabled:opacity-50"
            >
              Select needs optimization ({unoptimizedCount})
            </button>
          )}
          <button
            onClick={rewriteDescriptions}
            disabled={selected.size === 0 || rewriting || loading}
            className="px-4 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-500 transition disabled:opacity-50 disabled:cursor-not-allowed font-medium"
          >
            {rewriting
              ? 'Rewriting...'
              : `Rewrite Descriptions${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>

      {/* eBay auth required */}
      {needsAuth && (
        <div className="mb-6 p-5 bg-yellow-500/10 border border-yellow-500/30 rounded-xl flex items-center justify-between">
          <div>
            <p className="text-yellow-300 font-semibold text-sm">eBay account not connected</p>
            <p className="text-yellow-400/70 text-xs mt-0.5">
              Authorize AlphaCard to access your eBay seller account to view and edit listings.
            </p>
          </div>
          <a
            href="/ebay-connect"
            className="px-4 py-2 bg-yellow-500 text-black text-sm font-semibold rounded-lg hover:bg-yellow-400 transition whitespace-nowrap ml-4"
          >
            Connect eBay
          </a>
        </div>
      )}

      {/* Duplicate listings banner */}
      {!loading && duplicateItemIds.size > 0 && (
        <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-amber-400 text-base leading-none">⚠</span>
            <div>
              <span className="text-amber-300 font-semibold text-sm">
                {duplicateItemIds.size} duplicate listing{duplicateItemIds.size !== 1 ? 's' : ''} detected
              </span>
              <span className="text-amber-400/60 text-xs ml-2">
                — titles that appear more than once
              </span>
            </div>
          </div>
          <button
            onClick={() => setFilterMode(m => m === 'dupes' ? 'all' : 'dupes')}
            className={`px-3 py-1 text-xs font-semibold rounded-lg border transition ${
              filterMode === 'dupes'
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-300 hover:bg-amber-500/30'
                : 'bg-gray-800 border-amber-500/30 text-amber-400 hover:bg-amber-500/10'
            }`}
          >
            {filterMode === 'dupes' ? 'Show all' : 'Show duplicates only'}
          </button>
        </div>
      )}

      {/* Summary banner */}
      {summary && (
        <div className="mb-4 p-3 bg-gray-800 border border-gray-700 rounded-lg flex items-center gap-4 text-sm">
          {summary.done > 0 && <span className="text-green-400 font-medium">{summary.done} updated successfully</span>}
          {summary.failed > 0 && <span className="text-red-400 font-medium">{summary.failed} failed</span>}
        </div>
      )}

      {/* Description format preview */}
      <div className="mb-5 p-4 bg-gray-800/50 border border-gray-700 rounded-xl">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 font-semibold">Description format that will be applied</p>
        <div className="text-sm text-gray-300 space-y-1.5">
          <p><span className="text-white font-bold">Card Details:</span><span className="text-gray-400"> &gt; [Listing title].</span></p>
          <p><span className="text-white font-bold">Condition:</span><span className="text-gray-400"> &gt; Pack fresh, placed directly into a penny sleeve and toploader. Card is Near Mint or Better. Please see high-resolution photos for exact condition.</span></p>
          <p><span className="text-white font-bold">Shipping:</span><span className="text-gray-400"> &gt; Shipped securely via eBay Standard Envelope in a reinforced mailer to ensure it arrives safely.</span></p>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">{error}</div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-24 text-gray-500">
          <div className="w-6 h-6 border-2 border-gray-700 border-t-green-500 rounded-full animate-spin mb-3" />
          <p className="text-sm">Fetching active listings from eBay...</p>
        </div>
      ) : !error && listings.length === 0 ? (
        <div className="text-center py-24 text-gray-500 text-sm">No active listings found.</div>
      ) : !error ? (
        <div className="bg-gray-800 rounded-xl border border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-700">
                <th className="px-4 py-3 w-10">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="w-4 h-4 rounded border-gray-600 bg-gray-700 accent-green-500 cursor-pointer"
                  />
                </th>
                <th className="px-4 py-3 text-left text-gray-400 font-medium w-14">Photo</th>
                <th
                  className="px-4 py-3 text-left text-gray-400 font-medium cursor-pointer select-none hover:text-gray-200 transition"
                  onClick={() => handleSort('title')}
                >
                  Title <SortIcon active={sortKey === 'title'} dir={sortDir} />
                </th>
                <th
                  className="px-4 py-3 text-right text-gray-400 font-medium w-24 cursor-pointer select-none hover:text-gray-200 transition"
                  onClick={() => handleSort('price')}
                >
                  Price <SortIcon active={sortKey === 'price'} dir={sortDir} />
                </th>
                <th
                  className="px-4 py-3 text-left text-gray-400 font-medium w-28 cursor-pointer select-none hover:text-gray-200 transition"
                  onClick={() => handleSort('date')}
                >
                  Listed <SortIcon active={sortKey === 'date'} dir={sortDir} />
                </th>
                <th className="px-4 py-3 text-center text-gray-400 font-medium w-24">Item ID</th>
                <th
                  className="px-4 py-3 text-center text-gray-400 font-medium w-24 cursor-pointer select-none hover:text-gray-200 transition"
                  onClick={() => handleSort('seo')}
                >
                  SEO <SortIcon active={sortKey === 'seo'} dir={sortDir} />
                </th>
                <th className="px-4 py-3 text-center text-gray-400 font-medium w-24">Status</th>
                <th className="px-4 py-3 text-center text-gray-400 font-medium w-28">Market</th>
              </tr>
            </thead>
            <tbody>
              {sortedListings.map(listing => {
                const state = itemStates[listing.itemId];
                const isSelected = selected.has(listing.itemId);
                const desc = descriptions[listing.itemId];
                const isDuplicate = duplicateItemIds.has(listing.itemId);
                const listedDate = listing.startTime
                  ? new Date(listing.startTime).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                  : '—';

                return (
                  <tr
                    key={listing.itemId}
                    className={`border-b border-gray-700/40 hover:bg-gray-700/30 transition cursor-pointer ${
                      isSelected ? 'bg-green-500/5' : isDuplicate ? 'bg-amber-500/5' : ''
                    }`}
                    style={isDuplicate ? { boxShadow: 'inset 3px 0 0 rgba(245,158,11,0.6)' } : undefined}
                    onClick={() => toggleItem(listing.itemId)}
                  >
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleItem(listing.itemId)}
                        className="w-4 h-4 rounded border-gray-600 bg-gray-700 accent-green-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-4 py-3" onClick={e => e.stopPropagation()}>
                      {listing.pictureUrl ? (
                        <img src={listing.pictureUrl} alt="" className="w-10 h-10 object-cover rounded bg-gray-700" />
                      ) : (
                        <div className="w-10 h-10 bg-gray-700 rounded flex items-center justify-center text-gray-600 text-xs">–</div>
                      )}
                    </td>
                    <td className="px-4 py-3 max-w-xs">
                      <div className="flex items-start gap-2">
                        <span className="text-gray-200 line-clamp-2 leading-snug flex-1">{listing.title}</span>
                        {isDuplicate && (
                          <span
                            title="This title appears in multiple listings"
                            className="shrink-0 mt-0.5 px-1.5 py-0.5 bg-amber-500/15 text-amber-400 border border-amber-500/30 rounded text-[9px] font-bold uppercase tracking-wider cursor-default"
                          >
                            Dupe
                          </span>
                        )}
                      </div>
                      {(() => {
                        const displaySku = itemStates[listing.itemId]?.generatedSku || listing.sku;
                        if (!displaySku) return null;
                        const isNew = !!itemStates[listing.itemId]?.generatedSku;
                        return (
                          <span className={`block text-[10px] font-mono mt-0.5 ${isNew ? 'text-green-400' : 'text-gray-500'}`}>
                            {displaySku}
                          </span>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right text-green-400 font-medium tabular-nums">
                      ${listing.price.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-gray-400 text-xs whitespace-nowrap">{listedDate}</td>
                    <td className="px-4 py-3 text-center">
                      <a
                        href={listing.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 text-xs font-mono"
                      >
                        {listing.itemId}
                      </a>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {listing.isSeoFriendly ? (
                        <span className="px-2 py-0.5 bg-green-500/10 text-green-400 border border-green-500/20 rounded-full text-[10px] font-bold uppercase tracking-wider">
                          Good
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 bg-yellow-500/10 text-yellow-400 border border-yellow-500/20 rounded-full text-[10px] font-bold uppercase tracking-wider">
                          Fix Me
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {!state && !listing.isSeoFriendly && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(new Set([listing.itemId]));
                            setTimeout(rewriteDescriptions, 10);
                          }}
                          className="text-[10px] bg-gray-700 hover:bg-blue-600 text-gray-300 hover:text-white px-2 py-1 rounded transition font-bold uppercase"
                        >
                          Optimize
                        </button>
                      )}
                      {!state && listing.isSeoFriendly && <span className="text-gray-700 text-xs">—</span>}
                      {state?.status === 'rewriting' && (
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="w-3 h-3 border border-gray-600 border-t-blue-400 rounded-full animate-spin" />
                          <span className="text-blue-400 text-[10px] font-bold uppercase">Rewriting</span>
                        </div>
                      )}
                      {state?.status === 'done' && (
                        <span className="px-2 py-0.5 bg-green-500/10 text-green-400 rounded-full text-[10px] font-bold uppercase">Updated</span>
                      )}
                      {state?.status === 'error' && (
                        <span className="px-2 py-0.5 bg-red-500/10 text-red-400 rounded-full text-[10px] font-bold uppercase cursor-help" title={state.error}>
                          Error
                        </span>
                      )}
                    </td>
                    {/* Market comparison cell */}
                    <td className="px-4 py-3 text-center relative" onClick={e => e.stopPropagation()}>
                      <LazyComparableLoader
                        itemId={listing.itemId}
                        title={listing.title}
                        fetchComparablePrice={fetchComparablePrice}
                        isFetched={!!comparables[listing.itemId]}
                      />
                      {(() => {
                        const cmp = comparables[listing.itemId];
                        const isOpen = openComparable === listing.itemId;

                        // Derive badge color when data is available
                        let badge: React.ReactNode = null;
                        if (cmp?.status === 'done' && cmp.data.medianPrice !== null) {
                          const diff = listing.price - cmp.data.medianPrice;
                          const pct = (diff / cmp.data.medianPrice) * 100;
                          const absPct = Math.abs(pct).toFixed(0);
                          if (pct > 5) {
                            badge = <span className="ml-1 text-red-400 text-[9px] font-bold">▲{absPct}%</span>;
                          } else if (pct < -5) {
                            badge = <span className="ml-1 text-green-400 text-[9px] font-bold">▼{absPct}%</span>;
                          } else {
                            badge = <span className="ml-1 text-gray-400 text-[9px]">≈mkt</span>;
                          }
                        }

                        return (
                          <>
                            <button
                              onClick={(e) => toggleComparableView(listing.itemId, listing.title, e)}
                              className={`inline-flex items-center gap-0.5 px-2 py-1 rounded text-[10px] font-bold uppercase transition ${
                                isOpen
                                  ? 'bg-blue-600 text-white'
                                  : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                              }`}
                            >
                              {cmp?.status === 'loading' ? (
                                <span className="flex items-center gap-1">
                                  <span className="w-2.5 h-2.5 border border-gray-500 border-t-blue-400 rounded-full animate-spin" />
                                  …
                                </span>
                              ) : (
                                <>Compare{badge}</>
                              )}
                            </button>

                            {/* Popover */}
                            {isOpen && cmp?.status === 'done' && (
                              <div
                                className="absolute right-0 top-full mt-1 z-50 w-80 bg-gray-900 border border-gray-700 rounded-xl shadow-2xl p-3 text-left"
                                onClick={e => e.stopPropagation()}
                              >
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-[10px] text-gray-500 uppercase tracking-wider font-semibold">Similar Active Listings ({cmp.data.count})</span>
                                  <button onClick={() => setOpenComparable(null)} className="text-gray-600 hover:text-gray-300 text-xs">✕</button>
                                </div>

                                {/* Stats row */}
                                {cmp.data.count > 0 ? (
                                  <>
                                    <div className="grid grid-cols-3 gap-2 mb-3">
                                      {[
                                        { label: 'Min', val: cmp.data.minPrice },
                                        { label: 'Median', val: cmp.data.medianPrice },
                                        { label: 'Avg', val: cmp.data.avgPrice },
                                      ].map(({ label, val }) => {
                                        const myPrice = listing.price;
                                        const diff = val !== null ? myPrice - val : null;
                                        const color = diff === null ? 'text-gray-400'
                                          : diff > 0.005 ? 'text-red-400'
                                          : diff < -0.005 ? 'text-green-400'
                                          : 'text-gray-300';
                                        return (
                                          <div key={label} className="bg-gray-800 rounded-lg p-2 text-center">
                                            <div className="text-[9px] text-gray-500 uppercase tracking-wider mb-0.5">{label}</div>
                                            <div className={`text-sm font-bold tabular-nums ${color}`}>
                                              {val !== null ? `$${val.toFixed(2)}` : '—'}
                                            </div>
                                            {diff !== null && (
                                              <div className={`text-[9px] mt-0.5 ${color}`}>
                                                {diff > 0 ? `+$${diff.toFixed(2)} you` : diff < 0 ? `-$${Math.abs(diff).toFixed(2)} you` : 'at market'}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>

                                    {/* Your price indicator */}
                                    {cmp.data.medianPrice !== null && (() => {
                                      const pct = ((listing.price - cmp.data.medianPrice) / cmp.data.medianPrice) * 100;
                                      const isHigh = pct > 5;
                                      const isLow = pct < -5;
                                      return (
                                        <div className={`mb-3 p-2 rounded-lg text-xs flex items-center gap-2 ${
                                          isHigh ? 'bg-red-500/10 border border-red-500/20 text-red-300'
                                          : isLow ? 'bg-green-500/10 border border-green-500/20 text-green-300'
                                          : 'bg-gray-800 border border-gray-700 text-gray-400'
                                        }`}>
                                          <span className="text-base">{isHigh ? '⚠️' : isLow ? '✅' : '➡️'}</span>
                                          <span>
                                            Your price <strong className="font-bold">${listing.price.toFixed(2)}</strong> is{' '}
                                            {isHigh ? `${pct.toFixed(0)}% above median — consider lowering`
                                              : isLow ? `${Math.abs(pct).toFixed(0)}% below median — room to increase`
                                              : 'near the market median'}
                                          </span>
                                        </div>
                                      );
                                    })()}

                                    {/* Comparable list */}
                                    <div className="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
                                      {cmp.data.comparables.map(c => (
                                        <a
                                          key={c.itemId}
                                          href={c.url}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          className="flex items-center gap-2 p-1.5 rounded-lg hover:bg-gray-800 transition group"
                                        >
                                          {c.pictureUrl ? (
                                            <img src={c.pictureUrl} alt="" className="w-8 h-8 rounded object-cover bg-gray-800 shrink-0" />
                                          ) : (
                                            <div className="w-8 h-8 rounded bg-gray-800 shrink-0" />
                                          )}
                                          <span className="text-[10px] text-gray-400 group-hover:text-gray-200 transition line-clamp-2 flex-1 leading-snug">{c.title}</span>
                                          <span className="text-[11px] font-bold tabular-nums text-green-400 shrink-0">${c.price.toFixed(2)}</span>
                                        </a>
                                      ))}
                                    </div>
                                  </>
                                ) : (
                                  <p className="text-xs text-gray-500 py-3 text-center">No comparable listings found.</p>
                                )}
                              </div>
                            )}

                            {isOpen && cmp?.status === 'error' && (
                              <div className="absolute right-0 top-full mt-1 z-50 w-64 bg-gray-900 border border-red-500/30 rounded-xl shadow-2xl p-3 text-xs text-red-400">
                                Failed to load: {(cmp as any).message}
                              </div>
                            )}
                          </>
                        );
                      })()}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {page < totalPages && (
            <div ref={loadMoreRef} className="py-4 text-center text-sm text-gray-500 flex items-center justify-center gap-2">
              <div className="w-4 h-4 border-2 border-gray-700 border-t-green-500 rounded-full animate-spin" />
              Loading more...
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
