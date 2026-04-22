'use client';

import type { BulkListStagingItem } from '@/app/types';

interface Props {
  items: BulkListStagingItem[];
  onRemove: (id: string) => void;
  onUpdate: (id: string, updates: Partial<BulkListStagingItem>) => void;
  onClear: () => void;
}

export default function StagingTable({ items, onRemove, onUpdate }: Props) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="bg-gray-800/60 sticky top-0 z-10">
            <tr>
              <th className="text-left p-3 text-gray-500 font-medium w-8">#</th>
              <th className="text-left p-3 text-gray-500 font-medium">Title</th>
              <th className="text-left p-3 text-gray-500 font-medium">Player</th>
              <th className="text-left p-3 text-gray-500 font-medium">Sport</th>
              <th className="text-left p-3 text-gray-500 font-medium">Condition</th>
              <th className="text-right p-3 text-gray-500 font-medium">Price</th>
              <th className="text-right p-3 text-gray-500 font-medium">Qty</th>
              <th className="text-right p-3 text-gray-500 font-medium w-16"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={item.id} className="border-t border-gray-800/50 hover:bg-gray-800/30 transition group">
                <td className="p-3 text-gray-600">{idx + 1}</td>
                <td className="p-3 max-w-xs">
                  <input
                    type="text"
                    value={item.title}
                    onChange={e => onUpdate(item.id, { title: e.target.value })}
                    className="bg-transparent text-gray-300 w-full focus:bg-gray-800 focus:outline-none rounded px-1 py-0.5 transition truncate"
                  />
                </td>
                <td className="p-3 text-gray-400 whitespace-nowrap">{item.player_name}</td>
                <td className="p-3">
                  <select
                    value={item.sport}
                    onChange={e => onUpdate(item.id, { sport: e.target.value })}
                    className="bg-transparent text-gray-400 focus:bg-gray-800 focus:outline-none rounded px-1 py-0.5 transition"
                  >
                    {['mlb', 'nfl', 'nba', 'nhl', 'soccer', 'other'].map(s => (
                      <option key={s} value={s}>{s.toUpperCase()}</option>
                    ))}
                  </select>
                </td>
                <td className="p-3">
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                    item.condition === 'graded'
                      ? 'bg-purple-500/10 text-purple-400'
                      : 'bg-gray-700 text-gray-400'
                  }`}>
                    {item.condition === 'graded' ? `${item.grader || 'Graded'} ${item.grade || ''}`.trim() : 'Raw'}
                  </span>
                </td>
                <td className="p-3 text-right">
                  <input
                    type="number" step="0.01" min="0.99"
                    value={item.price}
                    onChange={e => onUpdate(item.id, { price: parseFloat(e.target.value) || 0 })}
                    className="bg-transparent text-green-400 font-medium text-right w-20 focus:bg-gray-800 focus:outline-none rounded px-1 py-0.5 transition"
                  />
                </td>
                <td className="p-3 text-right text-gray-400">{item.quantity}</td>
                <td className="p-3 text-right">
                  <button
                    onClick={() => onRemove(item.id)}
                    className="text-gray-600 hover:text-red-400 transition opacity-0 group-hover:opacity-100"
                    title="Remove"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
