'use client';

import { useState } from 'react';
import type { BulkListStagingItem } from '@/app/types';

interface Props {
  onAdd: (item: BulkListStagingItem) => void;
}

const SPORTS = ['mlb', 'nfl', 'nba', 'nhl', 'soccer', 'other'];

const EMPTY_FORM: {
  player_name: string;
  card_year: string;
  card_set: string;
  card_number: string;
  sport: string;
  condition: 'graded' | 'ungraded';
  grader: string;
  grade: string;
  cert_number: string;
  price: string;
  quantity: string;
} = {
  player_name: '',
  card_year: '',
  card_set: '',
  card_number: '',
  sport: 'mlb',
  condition: 'ungraded',
  grader: '',
  grade: '',
  cert_number: '',
  price: '',
  quantity: '1',
};

export default function CardEntryForm({ onAdd }: Props) {
  const [form, setForm] = useState(EMPTY_FORM);

  const set = (field: string, value: string) => setForm(f => ({ ...f, [field]: value } as typeof EMPTY_FORM));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.player_name || !form.price) return;

    const title = [form.card_year, form.card_set, form.player_name, form.card_number ? `#${form.card_number}` : '']
      .filter(Boolean).join(' ');

    onAdd({
      id: crypto.randomUUID(),
      title,
      player_name: form.player_name,
      card_year: form.card_year ? parseInt(form.card_year) : null,
      card_set: form.card_set,
      card_number: form.card_number,
      sport: form.sport,
      condition: form.condition,
      grader: form.grader,
      grade: form.grade,
      cert_number: form.cert_number,
      price: parseFloat(form.price),
      quantity: parseInt(form.quantity) || 1,
      image_urls: [],
    });

    setForm(EMPTY_FORM);
  };

  return (
    <form onSubmit={handleSubmit} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        {/* Player Name */}
        <label className="flex flex-col gap-1 col-span-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Player Name *</span>
          <input
            type="text" required value={form.player_name}
            onChange={e => set('player_name', e.target.value)}
            className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
            placeholder="Patrick Mahomes"
          />
        </label>

        {/* Year */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Year</span>
          <input
            type="number" value={form.card_year}
            onChange={e => set('card_year', e.target.value)}
            className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
            placeholder="2023"
          />
        </label>

        {/* Set */}
        <label className="flex flex-col gap-1 col-span-2">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Card Set</span>
          <input
            type="text" value={form.card_set}
            onChange={e => set('card_set', e.target.value)}
            className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
            placeholder="Topps Chrome"
          />
        </label>

        {/* Card Number */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Card #</span>
          <input
            type="text" value={form.card_number}
            onChange={e => set('card_number', e.target.value)}
            className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
            placeholder="150"
          />
        </label>

        {/* Sport */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Sport</span>
          <select
            value={form.sport} onChange={e => set('sport', e.target.value)}
            className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
          >
            {SPORTS.map(s => <option key={s} value={s}>{s.toUpperCase()}</option>)}
          </select>
        </label>

        {/* Condition */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Condition</span>
          <select
            value={form.condition} onChange={e => set('condition', e.target.value)}
            className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
          >
            <option value="ungraded">Ungraded</option>
            <option value="graded">Graded</option>
          </select>
        </label>

        {/* Grading fields — shown only when graded */}
        {form.condition === 'graded' && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">Grader</span>
              <select
                value={form.grader} onChange={e => set('grader', e.target.value)}
                className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
              >
                <option value="">Select...</option>
                <option value="PSA">PSA</option>
                <option value="BGS">BGS</option>
                <option value="SGC">SGC</option>
                <option value="CGC">CGC</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">Grade</span>
              <input
                type="text" value={form.grade}
                onChange={e => set('grade', e.target.value)}
                className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
                placeholder="10"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">Cert #</span>
              <input
                type="text" value={form.cert_number}
                onChange={e => set('cert_number', e.target.value)}
                className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
                placeholder="12345678"
              />
            </label>
          </>
        )}

        {/* Price */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Price ($) *</span>
          <input
            type="number" step="0.01" min="0.99" required value={form.price}
            onChange={e => set('price', e.target.value)}
            className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-green-500 focus:outline-none transition"
            placeholder="9.99"
          />
        </label>

        {/* Quantity */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] text-gray-500 uppercase tracking-wide">Qty</span>
          <input
            type="number" min="1" value={form.quantity}
            onChange={e => set('quantity', e.target.value)}
            className="bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition"
          />
        </label>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 transition flex items-center gap-2"
        >
          <span>＋</span> Add to Batch
        </button>
      </div>
    </form>
  );
}
