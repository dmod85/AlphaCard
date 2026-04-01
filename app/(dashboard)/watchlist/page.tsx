'use client';

import { useState, useEffect } from 'react';
import type { WatchlistPlayer, CardSport } from '@/app/types';

const SPORTS: { value: CardSport; label: string }[] = [
  { value: 'nfl', label: 'NFL' },
  { value: 'nba', label: 'NBA' },
  { value: 'mlb', label: 'MLB' },
  { value: 'nhl', label: 'NHL' },
  { value: 'soccer', label: 'Soccer' },
];

export default function WatchlistPage() {
  const [players, setPlayers] = useState<WatchlistPlayer[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [form, setForm] = useState({
    player_name: '',
    sport: 'nfl' as CardSport,
    team: '',
    priority: 5,
    common_typos: '',
    target_sets: '',
    target_years: '',
    min_value: 5,
    max_buy_price: '',
  });

  const fetchPlayers = async () => {
    const res = await fetch('/api/watchlist');
    const data = await res.json();
    setPlayers(data.players || []);
    setLoading(false);
  };

  useEffect(() => { fetchPlayers(); }, []);

  const resetForm = () => {
    setForm({
      player_name: '', sport: 'nfl', team: '', priority: 5,
      common_typos: '', target_sets: '', target_years: '',
      min_value: 5, max_buy_price: '',
    });
    setEditingId(null);
    setShowForm(false);
  };

  const handleSubmit = async () => {
    const body = {
      ...form,
      common_typos: form.common_typos.split(',').map(s => s.trim()).filter(Boolean),
      target_sets: form.target_sets.split(',').map(s => s.trim()).filter(Boolean),
      target_years: form.target_years.split(',').map(s => parseInt(s.trim())).filter(n => !isNaN(n)),
      max_buy_price: form.max_buy_price ? parseFloat(form.max_buy_price) : null,
    };

    if (editingId) {
      await fetch('/api/watchlist', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingId, ...body }),
      });
    } else {
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    resetForm();
    fetchPlayers();
  };

  const handleEdit = (player: WatchlistPlayer) => {
    setForm({
      player_name: player.player_name,
      sport: player.sport,
      team: player.team || '',
      priority: player.priority,
      common_typos: (player.common_typos || []).join(', '),
      target_sets: (player.target_sets || []).join(', '),
      target_years: (player.target_years || []).join(', '),
      min_value: player.min_value,
      max_buy_price: player.max_buy_price?.toString() || '',
    });
    setEditingId(player.id);
    setShowForm(true);
  };

  const handleToggle = async (id: string, active: boolean) => {
    await fetch('/api/watchlist', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active: !active }),
    });
    fetchPlayers();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this player from the watchlist?')) return;
    await fetch(`/api/watchlist?id=${id}`, { method: 'DELETE' });
    fetchPlayers();
  };

  const priorityColor = (p: number) => {
    if (p >= 9) return 'text-green-400 bg-green-500/10';
    if (p >= 7) return 'text-blue-400 bg-blue-500/10';
    if (p >= 5) return 'text-amber-400 bg-amber-500/10';
    return 'text-gray-400 bg-gray-800';
  };

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Player watchlist</h2>
          <p className="text-sm text-gray-500 mt-1">
            {players.filter(p => p.active).length} active players ·{' '}
            {players.reduce((s, p) => s + (p.common_typos?.length || 0), 0)} typo variants loaded
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(!showForm); }}
          className="px-4 py-2 bg-green-500/20 text-green-400 rounded-lg text-sm font-medium hover:bg-green-500/30 transition"
        >
          {showForm ? 'Cancel' : '+ Add player'}
        </button>
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h3 className="text-sm font-medium text-white mb-4">
            {editingId ? 'Edit player' : 'Add new player'}
          </h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <div>
              <label className="text-xs text-gray-500 block mb-1">Player name *</label>
              <input
                type="text"
                value={form.player_name}
                onChange={e => setForm(f => ({ ...f, player_name: e.target.value }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-green-500 outline-none"
                placeholder="C.J. Stroud"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Sport *</label>
              <select
                value={form.sport}
                onChange={e => setForm(f => ({ ...f, sport: e.target.value as CardSport }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700"
              >
                {SPORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Team</label>
              <input
                type="text"
                value={form.team}
                onChange={e => setForm(f => ({ ...f, team: e.target.value }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700"
                placeholder="Houston Texans"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Priority (1-10)</label>
              <input
                type="number" min={1} max={10}
                value={form.priority}
                onChange={e => setForm(f => ({ ...f, priority: parseInt(e.target.value) || 5 }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Min value ($)</label>
              <input
                type="number" step="0.01"
                value={form.min_value}
                onChange={e => setForm(f => ({ ...f, min_value: parseFloat(e.target.value) || 5 }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Max buy price ($)</label>
              <input
                type="text"
                value={form.max_buy_price}
                onChange={e => setForm(f => ({ ...f, max_buy_price: e.target.value }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700"
                placeholder="No limit"
              />
            </div>
            <div className="col-span-2 md:col-span-3">
              <label className="text-xs text-gray-500 block mb-1">Known typos (comma-separated)</label>
              <input
                type="text"
                value={form.common_typos}
                onChange={e => setForm(f => ({ ...f, common_typos: e.target.value }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700"
                placeholder="CJ Stroude, C J Stroud, Stroud CJ"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Target sets (comma-separated)</label>
              <input
                type="text"
                value={form.target_sets}
                onChange={e => setForm(f => ({ ...f, target_sets: e.target.value }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700"
                placeholder="Prizm, Select, Optic"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Target years (comma-separated)</label>
              <input
                type="text"
                value={form.target_years}
                onChange={e => setForm(f => ({ ...f, target_years: e.target.value }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700"
                placeholder="2023, 2024"
              />
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleSubmit}
              disabled={!form.player_name}
              className="px-4 py-2 bg-green-500 text-black rounded-lg text-sm font-medium hover:bg-green-400 transition disabled:opacity-40"
            >
              {editingId ? 'Save changes' : 'Add to watchlist'}
            </button>
            <button
              onClick={resetForm}
              className="px-4 py-2 bg-gray-800 text-gray-400 rounded-lg text-sm hover:bg-gray-700 transition"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Player List */}
      {loading ? (
        <div className="text-center py-12 text-gray-600">Loading watchlist...</div>
      ) : (
        <div className="space-y-2">
          {players.map(player => (
            <div
              key={player.id}
              className={`bg-gray-900 border rounded-xl p-4 flex items-center gap-4 transition ${
                player.active ? 'border-gray-800' : 'border-gray-800/50 opacity-50'
              }`}
            >
              {/* Priority Badge */}
              <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${priorityColor(player.priority)}`}>
                {player.priority}
              </div>

              {/* Player Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white">{player.player_name}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-800 text-gray-400">
                    {player.sport.toUpperCase()}
                  </span>
                  {player.team && (
                    <span className="text-xs text-gray-500">{player.team}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {(player.common_typos || []).slice(0, 4).map((t, i) => (
                    <span key={i} className="text-[10px] px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded">
                      {t}
                    </span>
                  ))}
                  {(player.common_typos || []).length > 4 && (
                    <span className="text-[10px] text-gray-600">
                      +{player.common_typos.length - 4} more
                    </span>
                  )}
                </div>
                <div className="flex gap-3 mt-1 text-[10px] text-gray-600">
                  {(player.target_sets || []).length > 0 && (
                    <span>Sets: {player.target_sets.join(', ')}</span>
                  )}
                  {(player.target_years || []).length > 0 && (
                    <span>Years: {player.target_years.join(', ')}</span>
                  )}
                  <span>Min: ${player.min_value}</span>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={() => handleToggle(player.id, player.active)}
                  className={`text-xs px-3 py-1 rounded-lg transition ${
                    player.active
                      ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                      : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                  }`}
                >
                  {player.active ? 'Active' : 'Paused'}
                </button>
                <button
                  onClick={() => handleEdit(player)}
                  className="text-xs px-3 py-1 rounded-lg bg-gray-800 text-gray-400 hover:bg-gray-700 transition"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(player.id)}
                  className="text-xs px-3 py-1 rounded-lg bg-gray-800 text-red-400 hover:bg-red-500/10 transition"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
