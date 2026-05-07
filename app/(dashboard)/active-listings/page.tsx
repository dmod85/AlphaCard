'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface ActiveListing {
  itemId: string;
  title: string;
  price: number;
  url: string;
  pictureUrl?: string;
  quantity: number;
  quantityAvailable: number;
}

type ItemStatus = 'rewriting' | 'done' | 'error';

interface ItemState {
  status: ItemStatus;
  error?: string;
}

export default function ActiveListingsPage() {
  const [listings, setListings] = useState<ActiveListing[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [itemStates, setItemStates] = useState<Record<string, ItemState>>({});
  const [rewriting, setRewriting] = useState(false);
  const [summary, setSummary] = useState<{ done: number; failed: number } | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const fetchListings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNeedsAuth(false);
    setSelected(new Set());
    setItemStates({});
    setSummary(null);
    try {
      const res = await fetch('/api/ebay/active-listings');
      const data = await res.json();
      if (res.status === 401 || data.error === 'EBAY_AUTH_REQUIRED') {
        setNeedsAuth(true);
        return;
      }
      if (!res.ok) throw new Error(data.error || 'Failed to fetch listings');
      setListings(data.listings);
      setTotal(data.total);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // After OAuth redirect, strip the query param then reload listings
    const params = new URLSearchParams(window.location.search);
    if (params.get('ebay_connected')) {
      window.history.replaceState({}, '', '/active-listings');
    }
    fetchListings();
  }, [fetchListings]);

  // Update indeterminate state on the select-all checkbox
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate =
        selected.size > 0 && selected.size < listings.length;
    }
  }, [selected, listings]);

  const toggleAll = () => {
    if (selected.size === listings.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(listings.map(l => l.itemId)));
    }
  };

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
      let done = 0, failed = 0;
      for (const result of (data.results || [])) {
        if (result.success) {
          updates[result.itemId] = { status: 'done' };
          done++;
        } else {
          updates[result.itemId] = { status: 'error', error: result.error };
          failed++;
        }
      }
      setItemStates(prev => ({ ...prev, ...updates }));
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
            onClick={fetchListings}
            disabled={loading || rewriting}
            className="px-3 py-1.5 text-sm bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition disabled:opacity-50"
          >
            Refresh
          </button>
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
            href="/api/ebay/auth"
            className="px-4 py-2 bg-yellow-500 text-black text-sm font-semibold rounded-lg hover:bg-yellow-400 transition whitespace-nowrap ml-4"
          >
            Connect eBay
          </a>
        </div>
      )}

      {/* Summary banner */}
      {summary && (
        <div className="mb-4 p-3 bg-gray-800 border border-gray-700 rounded-lg flex items-center gap-4 text-sm">
          {summary.done > 0 && (
            <span className="text-green-400 font-medium">{summary.done} updated successfully</span>
          )}
          {summary.failed > 0 && (
            <span className="text-red-400 font-medium">{summary.failed} failed</span>
          )}
        </div>
      )}

      {/* Description format preview */}
      <div className="mb-5 p-4 bg-gray-800/50 border border-gray-700 rounded-xl">
        <p className="text-[10px] text-gray-500 uppercase tracking-wider mb-2 font-semibold">Description format that will be applied</p>
        <div className="text-sm text-gray-300 space-y-1.5">
          <p>
            <span className="text-white font-bold">Card Details:</span>
            <span className="text-gray-400"> &gt; [Listing title].</span>
          </p>
          <p>
            <span className="text-white font-bold">Condition:</span>
            <span className="text-gray-400"> &gt; Pack fresh, placed directly into a penny sleeve and toploader. Card is Near Mint or Better. Please see high-resolution photos for exact condition.</span>
          </p>
          <p>
            <span className="text-white font-bold">Shipping:</span>
            <span className="text-gray-400"> &gt; Shipped securely via eBay Standard Envelope in a reinforced mailer to ensure it arrives safely.</span>
          </p>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Loading state */}
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
                <th className="px-4 py-3 text-left text-gray-400 font-medium">Title</th>
                <th className="px-4 py-3 text-right text-gray-400 font-medium w-24">Price</th>
                <th className="px-4 py-3 text-center text-gray-400 font-medium w-32">Item ID</th>
                <th className="px-4 py-3 text-center text-gray-400 font-medium w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {listings.map(listing => {
                const state = itemStates[listing.itemId];
                const isSelected = selected.has(listing.itemId);
                return (
                  <tr
                    key={listing.itemId}
                    className={`border-b border-gray-700/40 hover:bg-gray-700/30 transition cursor-pointer ${isSelected ? 'bg-green-500/5' : ''}`}
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
                        <img
                          src={listing.pictureUrl}
                          alt=""
                          className="w-10 h-10 object-cover rounded bg-gray-700"
                        />
                      ) : (
                        <div className="w-10 h-10 bg-gray-700 rounded flex items-center justify-center text-gray-600 text-xs">–</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-200 max-w-xs">
                      <span className="line-clamp-2 leading-snug">{listing.title}</span>
                    </td>
                    <td className="px-4 py-3 text-right text-green-400 font-medium tabular-nums">
                      ${listing.price.toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-center" onClick={e => e.stopPropagation()}>
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
                      {!state && <span className="text-gray-700 text-xs">—</span>}
                      {state?.status === 'rewriting' && (
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="w-3 h-3 border border-gray-600 border-t-blue-400 rounded-full animate-spin" />
                          <span className="text-blue-400 text-xs">Rewriting</span>
                        </div>
                      )}
                      {state?.status === 'done' && (
                        <span className="px-2 py-0.5 bg-green-500/10 text-green-400 rounded-full text-xs font-medium">
                          Updated
                        </span>
                      )}
                      {state?.status === 'error' && (
                        <span
                          className="px-2 py-0.5 bg-red-500/10 text-red-400 rounded-full text-xs font-medium cursor-help"
                          title={state.error}
                        >
                          Error
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
