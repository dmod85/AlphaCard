'use client';

import { useState, useEffect } from 'react';
import type { InventoryCard } from '@/app/types';

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  in_transit: { label: 'In transit', color: 'text-blue-400', bg: 'bg-blue-500/10' },
  in_hand: { label: 'In hand', color: 'text-green-400', bg: 'bg-green-500/10' },
  at_grader: { label: 'At grader', color: 'text-purple-400', bg: 'bg-purple-500/10' },
  listed: { label: 'Listed', color: 'text-amber-400', bg: 'bg-amber-500/10' },
  sold: { label: 'Sold', color: 'text-green-400', bg: 'bg-green-500/10' },
  returned: { label: 'Returned', color: 'text-red-400', bg: 'bg-red-500/10' },
};

export default function InventoryPage() {
  const [cards, setCards] = useState<InventoryCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [showSellModal, setShowSellModal] = useState<string | null>(null);
  const [sellForm, setSellForm] = useState({ sold_price: '', ebay_fees_paid: '', shipping_cost: '0.63' });

  const fetchCards = async () => {
    const url = filterStatus ? `/api/inventory?status=${filterStatus}` : '/api/inventory';
    const res = await fetch(url);
    const data = await res.json();
    setCards(data.cards || []);
    setLoading(false);
  };

  useEffect(() => { fetchCards(); }, [filterStatus]);

  const handleStatusUpdate = async (id: string, status: string) => {
    await fetch('/api/inventory', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    });
    fetchCards();
  };

  const handleSell = async (id: string) => {
    await fetch('/api/inventory', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        status: 'sold',
        sold_price: parseFloat(sellForm.sold_price),
        ebay_fees_paid: parseFloat(sellForm.ebay_fees_paid) || undefined,
        shipping_cost: parseFloat(sellForm.shipping_cost) || 0.63,
      }),
    });
    setShowSellModal(null);
    setSellForm({ sold_price: '', ebay_fees_paid: '', shipping_cost: '0.63' });
    fetchCards();
  };

  // Summary stats
  const active = cards.filter(c => !['sold', 'returned'].includes(c.status));
  const sold = cards.filter(c => c.status === 'sold');
  const totalInvested = active.reduce((s, c) => s + (c.total_cost || 0), 0);
  const totalProfit = sold.reduce((s, c) => s + (c.net_profit || 0), 0);
  const totalRevenue = sold.reduce((s, c) => s + (c.sold_price || 0), 0);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Inventory</h2>
          <p className="text-sm text-gray-500 mt-1">
            {active.length} active cards · {sold.length} sold
          </p>
        </div>
      </div>

      {/* Summary Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="text-xs text-gray-500">Total invested</div>
          <div className="text-lg font-semibold text-white">${totalInvested.toFixed(2)}</div>
        </div>
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="text-xs text-gray-500">Total revenue</div>
          <div className="text-lg font-semibold text-white">${totalRevenue.toFixed(2)}</div>
        </div>
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="text-xs text-gray-500">Net profit</div>
          <div className={`text-lg font-semibold ${totalProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            ${totalProfit.toFixed(2)}
          </div>
        </div>
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="text-xs text-gray-500">Avg ROI</div>
          <div className="text-lg font-semibold text-white">
            {sold.length > 0 ? Math.round(sold.reduce((s, c) => s + (c.roi_pct || 0), 0) / sold.length) : 0}%
          </div>
        </div>
        <div className="bg-gray-900 rounded-xl p-4">
          <div className="text-xs text-gray-500">At grader</div>
          <div className="text-lg font-semibold text-purple-400">
            {cards.filter(c => c.status === 'at_grader').length}
          </div>
        </div>
      </div>

      {/* Status Filter */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {['', 'in_transit', 'in_hand', 'at_grader', 'listed', 'sold'].map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-3 py-1 rounded-full text-xs transition ${
              filterStatus === s
                ? 'bg-white/10 text-white font-medium'
                : 'bg-gray-900 text-gray-500 hover:text-gray-300'
            }`}
          >
            {s ? STATUS_CONFIG[s]?.label || s : 'All'}
          </button>
        ))}
      </div>

      {/* Cards Table */}
      {loading ? (
        <div className="text-center py-12 text-gray-600">Loading inventory...</div>
      ) : cards.length === 0 ? (
        <div className="text-center py-12 text-gray-600">
          No cards in inventory yet. Purchase leads from the dashboard to get started.
        </div>
      ) : (
        <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800">
                <th className="text-left p-3 text-xs text-gray-500 font-medium">Card</th>
                <th className="text-right p-3 text-xs text-gray-500 font-medium">Cost</th>
                <th className="text-right p-3 text-xs text-gray-500 font-medium">Listed</th>
                <th className="text-right p-3 text-xs text-gray-500 font-medium">Sold</th>
                <th className="text-right p-3 text-xs text-gray-500 font-medium">Profit</th>
                <th className="text-center p-3 text-xs text-gray-500 font-medium">Status</th>
                <th className="text-right p-3 text-xs text-gray-500 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cards.map(card => {
                const cfg = STATUS_CONFIG[card.status] || STATUS_CONFIG.in_hand;
                return (
                  <tr key={card.id} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition">
                    <td className="p-3">
                      <div className="font-medium text-white text-xs">{card.player_name}</div>
                      <div className="text-[10px] text-gray-500 mt-0.5">
                        {[card.card_year, card.card_set, card.parallel_type].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="p-3 text-right text-xs text-gray-300">${(card.total_cost || 0).toFixed(2)}</td>
                    <td className="p-3 text-right text-xs text-gray-300">
                      {card.listed_price ? `$${card.listed_price.toFixed(2)}` : '—'}
                    </td>
                    <td className="p-3 text-right text-xs text-gray-300">
                      {card.sold_price ? `$${card.sold_price.toFixed(2)}` : '—'}
                    </td>
                    <td className="p-3 text-right text-xs">
                      {card.net_profit != null ? (
                        <span className={card.net_profit >= 0 ? 'text-green-400' : 'text-red-400'}>
                          ${card.net_profit.toFixed(2)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="p-3 text-center">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${cfg.bg} ${cfg.color}`}>
                        {cfg.label}
                      </span>
                    </td>
                    <td className="p-3 text-right">
                      <div className="flex gap-1 justify-end">
                        {card.status === 'in_hand' && (
                          <>
                            <button
                              onClick={() => handleStatusUpdate(card.id, 'listed')}
                              className="text-[10px] px-2 py-1 rounded bg-amber-500/10 text-amber-400 hover:bg-amber-500/20"
                            >
                              List
                            </button>
                            <button
                              onClick={() => handleStatusUpdate(card.id, 'at_grader')}
                              className="text-[10px] px-2 py-1 rounded bg-purple-500/10 text-purple-400 hover:bg-purple-500/20"
                            >
                              Grade
                            </button>
                          </>
                        )}
                        {card.status === 'listed' && (
                          <button
                            onClick={() => setShowSellModal(card.id)}
                            className="text-[10px] px-2 py-1 rounded bg-green-500/10 text-green-400 hover:bg-green-500/20"
                          >
                            Mark sold
                          </button>
                        )}
                        {card.status === 'in_transit' && (
                          <button
                            onClick={() => handleStatusUpdate(card.id, 'in_hand')}
                            className="text-[10px] px-2 py-1 rounded bg-green-500/10 text-green-400 hover:bg-green-500/20"
                          >
                            Received
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Sell Modal */}
      {showSellModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-xl p-6 w-80">
            <h3 className="text-sm font-medium text-white mb-4">Record sale</h3>
            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-500">Sold price *</label>
                <input
                  type="number" step="0.01"
                  value={sellForm.sold_price}
                  onChange={e => setSellForm(f => ({ ...f, sold_price: e.target.value }))}
                  className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 mt-1"
                  placeholder="0.00"
                  autoFocus
                />
              </div>
              <div>
                <label className="text-xs text-gray-500">eBay fees (auto-calculated if blank)</label>
                <input
                  type="number" step="0.01"
                  value={sellForm.ebay_fees_paid}
                  onChange={e => setSellForm(f => ({ ...f, ebay_fees_paid: e.target.value }))}
                  className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 mt-1"
                  placeholder="Auto"
                />
              </div>
              <div>
                <label className="text-xs text-gray-500">Shipping cost</label>
                <input
                  type="number" step="0.01"
                  value={sellForm.shipping_cost}
                  onChange={e => setSellForm(f => ({ ...f, shipping_cost: e.target.value }))}
                  className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 mt-1"
                />
              </div>
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => handleSell(showSellModal)}
                disabled={!sellForm.sold_price}
                className="flex-1 px-4 py-2 bg-green-500 text-black rounded-lg text-sm font-medium hover:bg-green-400 disabled:opacity-40"
              >
                Record sale
              </button>
              <button
                onClick={() => setShowSellModal(null)}
                className="px-4 py-2 bg-gray-800 text-gray-400 rounded-lg text-sm hover:bg-gray-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
