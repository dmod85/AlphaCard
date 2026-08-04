'use client';

import { useState, useEffect } from 'react';
import type { SearchQuery } from '@/app/types';

export default function WatchlistPage() {
  const [queries, setQueries] = useState<SearchQuery[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [form, setForm] = useState({
    query: '',
    max_price: '',
  });

  const fetchQueries = async () => {
    const res = await fetch('/api/search-queries');
    const data = await res.json();
    setQueries(data.queries || []);
    setLoading(false);
  };

  useEffect(() => { fetchQueries(); }, []);

  const resetForm = () => {
    setForm({ query: '', max_price: '' });
    setEditingId(null);
    setShowForm(false);
  };

  const handleSubmit = async () => {
    const body = {
      query: form.query,
      max_price: parseFloat(form.max_price),
    };

    if (editingId) {
      await fetch('/api/search-queries', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: editingId, ...body }),
      });
    } else {
      await fetch('/api/search-queries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    resetForm();
    fetchQueries();
  };

  const handleEdit = (q: SearchQuery) => {
    setForm({
      query: q.query,
      max_price: q.max_price.toString(),
    });
    setEditingId(q.id);
    setShowForm(true);
  };

  const handleToggle = async (id: string, active: boolean) => {
    await fetch('/api/search-queries', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, active: !active }),
    });
    fetchQueries();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this search query?')) return;
    await fetch(`/api/search-queries?id=${id}`, { method: 'DELETE' });
    fetchQueries();
  };

  const isValid = form.query.trim() !== '' && form.max_price !== '' && !isNaN(parseFloat(form.max_price));

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-bold text-white">Search queries</h2>
          <p className="text-sm text-gray-500 mt-1">
            {queries.filter(q => q.active).length} active · drives the eBay → Discord alert script
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(!showForm); }}
          className="px-4 py-2 bg-green-500/20 text-green-400 rounded-lg text-sm font-medium hover:bg-green-500/30 transition"
        >
          {showForm ? 'Cancel' : '+ Add search'}
        </button>
      </div>

      {/* Add/Edit Form */}
      {showForm && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-6">
          <h3 className="text-sm font-medium text-white mb-4">
            {editingId ? 'Edit search' : 'Add new search'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="md:col-span-2">
              <label className="text-xs text-gray-500 block mb-1">eBay search query *</label>
              <input
                type="text"
                value={form.query}
                onChange={e => setForm(f => ({ ...f, query: e.target.value }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-green-500 outline-none"
                placeholder="Sophie Cunningham Card"
              />
            </div>
            <div>
              <label className="text-xs text-gray-500 block mb-1">Max price ($) *</label>
              <input
                type="number" min="0" step="0.01"
                value={form.max_price}
                onChange={e => setForm(f => ({ ...f, max_price: e.target.value }))}
                className="w-full bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-green-500 outline-none"
                placeholder="75"
              />
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <button
              onClick={handleSubmit}
              disabled={!isValid}
              className="px-4 py-2 bg-green-500 text-black rounded-lg text-sm font-medium hover:bg-green-400 transition disabled:opacity-40"
            >
              {editingId ? 'Save changes' : 'Add search'}
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

      {/* Query List */}
      {loading ? (
        <div className="text-center py-12 text-gray-600">Loading search queries...</div>
      ) : queries.length === 0 ? (
        <div className="text-center py-12 text-gray-600">
          No search queries yet. Add one to start getting Discord alerts.
        </div>
      ) : (
        <div className="space-y-2">
          {queries.map(q => (
            <div
              key={q.id}
              className={`bg-gray-900 border rounded-xl p-4 flex items-center gap-4 transition ${
                q.active ? 'border-gray-800' : 'border-gray-800/50 opacity-50'
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-white truncate">{q.query}</span>
                </div>
                <div className="flex gap-3 mt-1 text-[10px] text-gray-600">
                  <span>Max price: ${q.max_price.toFixed(2)}</span>
                </div>
              </div>

              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => handleToggle(q.id, q.active)}
                  className={`text-xs px-3 py-1 rounded-lg transition ${
                    q.active
                      ? 'bg-green-500/10 text-green-400 hover:bg-green-500/20'
                      : 'bg-gray-800 text-gray-500 hover:bg-gray-700'
                  }`}
                >
                  {q.active ? 'Active' : 'Paused'}
                </button>
                <button
                  onClick={() => handleEdit(q)}
                  className="text-xs px-3 py-1 rounded-lg bg-gray-800 text-gray-400 hover:bg-gray-700 transition"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(q.id)}
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
