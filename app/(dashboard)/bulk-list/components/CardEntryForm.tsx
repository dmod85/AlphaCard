'use client';

import { useState, useRef, useCallback } from 'react';
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

interface UploadingImage {
  id: string;
  file: File;
  preview: string;
  status: 'uploading' | 'done' | 'error';
  url?: string;
  error?: string;
}

export default function CardEntryForm({ onAdd }: Props) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [images, setImages] = useState<UploadingImage[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const set = (field: string, value: string) => setForm(f => ({ ...f, [field]: value } as typeof EMPTY_FORM));

  const uploadFile = useCallback(async (file: File): Promise<string | null> => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload-image', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      return data.url as string;
    } catch (err: any) {
      return null;
    }
  }, []);

  const addFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter(f => f.type.startsWith('image/'));
    if (imageFiles.length === 0) return;

    const newImages: UploadingImage[] = imageFiles.map(file => ({
      id: crypto.randomUUID(),
      file,
      preview: URL.createObjectURL(file),
      status: 'uploading' as const,
    }));

    setImages(prev => [...prev, ...newImages]);

    await Promise.all(
      newImages.map(async (img) => {
        const url = await uploadFile(img.file);
        setImages(prev => prev.map(i =>
          i.id === img.id
            ? { ...i, status: url ? 'done' : 'error', url: url || undefined, error: url ? undefined : 'Upload failed' }
            : i
        ));
      })
    );
  }, [uploadFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    addFiles(Array.from(e.dataTransfer.files));
  }, [addFiles]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files));
    e.target.value = '';
  };

  const removeImage = (id: string) => {
    setImages(prev => {
      const img = prev.find(i => i.id === id);
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter(i => i.id !== id);
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.player_name || !form.price) return;

    const uploading = images.some(i => i.status === 'uploading');
    if (uploading) return;

    const title = [form.card_year, form.card_set, form.player_name, form.card_number ? `#${form.card_number}` : '']
      .filter(Boolean).join(' ');

    const image_urls = images.filter(i => i.status === 'done' && i.url).map(i => i.url!);

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
      image_urls,
    });

    setForm(EMPTY_FORM);
    images.forEach(i => URL.revokeObjectURL(i.preview));
    setImages([]);
  };

  const uploadingCount = images.filter(i => i.status === 'uploading').length;

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

      {/* Image Upload */}
      <div className="mt-4">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide">Photos</span>
        <div className="mt-1.5 flex gap-2 flex-wrap items-start">
          {/* Uploaded thumbnails */}
          {images.map(img => (
            <div key={img.id} className="relative w-16 h-16 rounded-lg overflow-hidden border border-gray-700 flex-shrink-0">
              <img src={img.preview} alt="" className="w-full h-full object-cover" />
              {img.status === 'uploading' && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                </div>
              )}
              {img.status === 'error' && (
                <div className="absolute inset-0 bg-red-900/80 flex items-center justify-center text-xs text-white text-center px-1">
                  Failed
                </div>
              )}
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                className="absolute top-0.5 right-0.5 w-4 h-4 bg-black/70 rounded-full text-white text-[10px] flex items-center justify-center hover:bg-red-500 transition"
              >
                ✕
              </button>
            </div>
          ))}

          {/* Drop zone / add button */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`w-16 h-16 rounded-lg border-2 border-dashed flex flex-col items-center justify-center cursor-pointer transition flex-shrink-0 ${
              dragOver
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-gray-700 hover:border-gray-500 hover:bg-gray-800/50'
            }`}
          >
            <span className="text-xl text-gray-500">+</span>
            <span className="text-[9px] text-gray-600 mt-0.5">photo</span>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileSelect}
            className="hidden"
          />
        </div>
        {images.length > 0 && (
          <p className="text-[10px] text-gray-600 mt-1">
            {images.filter(i => i.status === 'done').length} uploaded
            {uploadingCount > 0 ? `, ${uploadingCount} uploading…` : ''}
          </p>
        )}
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          disabled={uploadingCount > 0}
          className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2"
        >
          <span>＋</span> {uploadingCount > 0 ? `Uploading ${uploadingCount}…` : 'Add to Batch'}
        </button>
      </div>
    </form>
  );
}
