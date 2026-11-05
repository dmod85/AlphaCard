'use client';

import { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BulkListStagingItem } from '@/app/types';
import type { CompsResult, GeneratedListing, ItemSpecific } from '@/app/lib/card-listing/schema';
import { queueForBulkList } from '@/app/lib/card-listing/handoff';
import { resizeImage } from './resize';

interface Photo {
  id: string;
  preview: string;
  status: 'uploading' | 'done' | 'error';
  url?: string;
}

interface CardJob {
  id: string;
  photos: Photo[];
  notes: string;
  status: 'idle' | 'generating' | 'done' | 'error';
  error?: string;
  listing?: GeneratedListing;
  compsStatus: 'idle' | 'loading' | 'done' | 'error';
  compsError?: string;
  comps?: CompsResult;
  price: string;
}

const input =
  'bg-gray-800 text-white text-sm rounded-lg px-3 py-2 border border-gray-700 focus:border-blue-500 focus:outline-none transition w-full';

const money = (n: number | null | undefined) => (n == null ? '—' : `$${n.toFixed(2)}`);

function bulkSport(listing: GeneratedListing): string {
  const text = `${listing.card.sport ?? ''} ${listing.card.league ?? ''}`.toLowerCase();
  if (/baseball|mlb/.test(text)) return 'mlb';
  if (/football|nfl/.test(text)) return 'nfl';
  if (/basketball|nba|wnba/.test(text)) return 'nba';
  if (/hockey|nhl/.test(text)) return 'nhl';
  if (/soccer|mls|fifa|premier/.test(text)) return 'soccer';
  return 'other';
}

function newCard(photos: Photo[]): CardJob {
  return { id: crypto.randomUUID(), photos, notes: '', status: 'idle', compsStatus: 'idle', price: '' };
}

async function uploadPhoto(file: File): Promise<string> {
  const resized = await resizeImage(file);
  const form = new FormData();
  form.append('file', resized);
  const res = await fetch('/api/upload-image', { method: 'POST', body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.url as string;
}

export default function ListingGeneratorPage() {
  const router = useRouter();
  const [cards, setCards] = useState<CardJob[]>([]);
  const [pairPhotos, setPairPhotos] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [running, setRunning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const patch = useCallback((id: string, updates: Partial<CardJob> | ((c: CardJob) => Partial<CardJob>)) => {
    setCards(prev => prev.map(c => (c.id === id ? { ...c, ...(typeof updates === 'function' ? updates(c) : updates) } : c)));
  }, []);

  const patchPhoto = useCallback((photoId: string, updates: Partial<Photo>) => {
    setCards(prev =>
      prev.map(c =>
        c.photos.some(p => p.id === photoId)
          ? { ...c, photos: c.photos.map(p => (p.id === photoId ? { ...p, ...updates } : p)) }
          : c
      )
    );
  }, []);

  const addFiles = useCallback(
    (files: File[]) => {
      const images = files.filter(f => f.type.startsWith('image/')).sort((a, b) => a.name.localeCompare(b.name));
      if (!images.length) return;
      const photos = images.map(file => ({
        file,
        photo: { id: crypto.randomUUID(), preview: URL.createObjectURL(file), status: 'uploading' as const },
      }));
      const size = pairPhotos ? 2 : 1;
      const newCards: CardJob[] = [];
      for (let i = 0; i < photos.length; i += size) {
        newCards.push(newCard(photos.slice(i, i + size).map(p => p.photo)));
      }
      setCards(prev => [...prev, ...newCards]);
      photos.forEach(({ file, photo }) =>
        uploadPhoto(file)
          .then(url => patchPhoto(photo.id, { status: 'done', url }))
          .catch(() => patchPhoto(photo.id, { status: 'error' }))
      );
    },
    [pairPhotos, patchPhoto]
  );

  const fetchComps = useCallback(
    async (id: string, listing: GeneratedListing) => {
      patch(id, { compsStatus: 'loading', compsError: undefined });
      try {
        const res = await fetch('/api/listing-generator/comps', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ listing }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Comp search failed');
        const comps = data as CompsResult;
        patch(id, c => ({
          compsStatus: 'done',
          comps,
          price: c.price || (comps.price.suggested != null ? comps.price.suggested.toFixed(2) : ''),
        }));
      } catch (err: any) {
        patch(id, { compsStatus: 'error', compsError: err.message });
      }
    },
    [patch]
  );

  const generate = useCallback(
    async (card: CardJob) => {
      const urls = card.photos.filter(p => p.status === 'done' && p.url).map(p => p.url!);
      if (!urls.length) return;
      patch(card.id, { status: 'generating', error: undefined });
      try {
        const res = await fetch('/api/listing-generator', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_urls: urls, notes: card.notes }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Generation failed');
        patch(card.id, { status: 'done', listing: data.listing });
        fetchComps(card.id, data.listing);
      } catch (err: any) {
        patch(card.id, { status: 'error', error: err.message });
      }
    },
    [patch, fetchComps]
  );

  const ready = cards.filter(
    c => c.status !== 'generating' && c.status !== 'done' && c.photos.length > 0 && c.photos.every(p => p.status === 'done')
  );
  const uploading = cards.some(c => c.photos.some(p => p.status === 'uploading'));

  const generateAll = async () => {
    setRunning(true);
    const queue = [...ready];
    const worker = async () => {
      for (let card = queue.shift(); card; card = queue.shift()) await generate(card);
    };
    await Promise.all([worker(), worker()]);
    setRunning(false);
  };

  const removeCard = (id: string) =>
    setCards(prev => {
      prev.find(c => c.id === id)?.photos.forEach(p => URL.revokeObjectURL(p.preview));
      return prev.filter(c => c.id !== id);
    });

  // Moves one photo to its own card, or merges a card into the one above it,
  // for when the front/back pairing came out wrong.
  const splitPhoto = (cardId: string, photoId: string) =>
    setCards(prev => {
      const idx = prev.findIndex(c => c.id === cardId);
      const card = prev[idx];
      const photo = card.photos.find(p => p.id === photoId)!;
      const next = [...prev];
      next[idx] = { ...card, photos: card.photos.filter(p => p.id !== photoId), status: 'idle', listing: undefined };
      next.splice(idx + 1, 0, newCard([photo]));
      return next;
    });

  const mergeUp = (cardId: string) =>
    setCards(prev => {
      const idx = prev.findIndex(c => c.id === cardId);
      if (idx <= 0) return prev;
      const next = [...prev];
      next[idx - 1] = { ...next[idx - 1], photos: [...next[idx - 1].photos, ...next[idx].photos], status: 'idle', listing: undefined };
      next.splice(idx, 1);
      return next;
    });

  const doneCards = cards.filter(c => c.listing);

  const sendToBulkList = () => {
    const items: BulkListStagingItem[] = doneCards.map(c => {
      const l = c.listing!;
      return {
        id: crypto.randomUUID(),
        title: l.title,
        player_name: l.card.player_names.join(' / '),
        card_year: l.card.year ? parseInt(l.card.year, 10) || null : null,
        card_set: [l.card.manufacturer, l.card.set_name].filter(Boolean).join(' '),
        card_number: l.card.card_number ?? '',
        sport: bulkSport(l),
        condition: l.card.graded ? 'graded' : 'ungraded',
        grader: l.card.grader ?? '',
        grade: l.card.grade ?? '',
        cert_number: l.card.cert_number ?? '',
        price: parseFloat(c.price) || 0,
        quantity: 1,
        image_urls: c.photos.filter(p => p.url).map(p => p.url!),
        description: l.description,
        item_specifics: l.item_specifics,
      };
    });
    queueForBulkList(items);
    router.push('/bulk-list');
  };

  return (
    <div className="h-full overflow-auto bg-gray-950">
      <div className="p-6 max-w-7xl mx-auto">
        <div className="mb-6">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <span>✨</span> Listing Generator
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            Upload card photos. Claude identifies each card, writes an SEO title, description and item specifics, and pulls sold comps for a price.
          </p>
        </div>

        {/* Upload */}
        <div
          onDragOver={e => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => { e.preventDefault(); setDragOver(false); addFiles(Array.from(e.dataTransfer.files)); }}
          onClick={() => fileRef.current?.click()}
          className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition ${
            dragOver ? 'border-green-400 bg-green-500/5' : 'border-gray-700 hover:border-gray-500 bg-gray-900'
          }`}
        >
          <div className="text-3xl mb-2">📸</div>
          <p className="text-sm text-gray-300">Drop card photos here or click to choose</p>
          <p className="text-xs text-gray-500 mt-1">
            {pairPhotos ? 'Photos are paired in name order: front, back, front, back…' : 'Each photo is its own card'}
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={e => { if (e.target.files) addFiles(Array.from(e.target.files)); e.target.value = ''; }}
          />
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-3">
          <label className="flex items-center gap-2 text-xs text-gray-400">
            <input type="checkbox" checked={pairPhotos} onChange={e => setPairPhotos(e.target.checked)} />
            Pair photos as front + back
          </label>
          <div className="flex-1" />
          {cards.length > 0 && (
            <button
              onClick={() => setCards([])}
              className="px-4 py-2 bg-gray-800 text-gray-400 rounded-lg text-sm hover:bg-gray-700 transition"
            >
              Clear all
            </button>
          )}
          <button
            onClick={generateAll}
            disabled={running || uploading || ready.length === 0}
            className="px-5 py-2 bg-green-500 text-black rounded-lg text-sm font-semibold hover:bg-green-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {running ? 'Generating…' : uploading ? 'Uploading photos…' : `✨ Generate ${ready.length || ''} listing${ready.length === 1 ? '' : 's'}`}
          </button>
        </div>

        {/* Cards */}
        <div className="mt-6 space-y-4">
          {cards.map((card, i) => (
            <CardPanel
              key={card.id}
              card={card}
              canMergeUp={i > 0}
              onPatch={u => patch(card.id, u)}
              onRemove={() => removeCard(card.id)}
              onSplit={photoId => splitPhoto(card.id, photoId)}
              onMergeUp={() => mergeUp(card.id)}
              onRegenerate={() => generate(card)}
              onRefreshComps={() => card.listing && fetchComps(card.id, card.listing)}
            />
          ))}
        </div>

        {doneCards.length > 0 && (
          <div className="sticky bottom-0 mt-6 py-3 bg-gray-950/95 border-t border-gray-800 flex items-center gap-3">
            <span className="text-xs text-gray-500">
              {doneCards.length} listing{doneCards.length === 1 ? '' : 's'} ready
              {doneCards.some(c => !parseFloat(c.price)) && <span className="text-amber-400"> · set a price on every card first</span>}
            </span>
            <div className="flex-1" />
            <button
              onClick={sendToBulkList}
              disabled={doneCards.some(c => !parseFloat(c.price))}
              className="px-5 py-2 bg-blue-500 text-white rounded-lg text-sm font-semibold hover:bg-blue-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              🚀 Send to Bulk List
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); })}
      className="text-[10px] px-2 py-1 rounded bg-gray-800 text-gray-400 hover:text-white hover:bg-gray-700 transition"
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function CardPanel({
  card,
  canMergeUp,
  onPatch,
  onRemove,
  onSplit,
  onMergeUp,
  onRegenerate,
  onRefreshComps,
}: {
  card: CardJob;
  canMergeUp: boolean;
  onPatch: (u: Partial<CardJob>) => void;
  onRemove: () => void;
  onSplit: (photoId: string) => void;
  onMergeUp: () => void;
  onRegenerate: () => void;
  onRefreshComps: () => void;
}) {
  const l = card.listing;
  const setListing = (updates: Partial<GeneratedListing>) => l && onPatch({ listing: { ...l, ...updates } });
  const setSpecific = (idx: number, updates: Partial<ItemSpecific>) =>
    l && setListing({ item_specifics: l.item_specifics.map((s, i) => (i === idx ? { ...s, ...updates } : s)) });

  const specificsText = l?.item_specifics.map(s => `${s.name}: ${s.value}`).join('\n') ?? '';

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Photos + notes */}
        <div className="lg:w-56 shrink-0 space-y-2">
          <div className="flex gap-2">
            {card.photos.map(p => (
              <div key={p.id} className="relative group">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.preview} alt="" className="w-24 h-32 object-cover rounded-lg border border-gray-700" />
                {p.status === 'uploading' && (
                  <div className="absolute inset-0 bg-black/60 rounded-lg flex items-center justify-center text-[10px] text-gray-300">Uploading…</div>
                )}
                {p.status === 'error' && (
                  <div className="absolute inset-0 bg-red-900/70 rounded-lg flex items-center justify-center text-[10px] text-red-200">Upload failed</div>
                )}
                {card.photos.length > 1 && (
                  <button
                    onClick={() => onSplit(p.id)}
                    title="Move this photo to its own card"
                    className="absolute top-1 right-1 hidden group-hover:block text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-gray-200"
                  >
                    split
                  </button>
                )}
              </div>
            ))}
          </div>
          <textarea
            value={card.notes}
            onChange={e => onPatch({ notes: e.target.value })}
            placeholder="Optional notes, e.g. “Gold /50”, “PSA 10”, “has soft corner”"
            rows={2}
            className={`${input} text-xs`}
          />
          <div className="flex flex-wrap gap-2 text-[11px]">
            {canMergeUp && (
              <button onClick={onMergeUp} className="text-gray-500 hover:text-gray-300">↑ merge with card above</button>
            )}
            <button onClick={onRemove} className="text-gray-500 hover:text-red-400">remove</button>
          </div>
        </div>

        {/* Listing */}
        <div className="flex-1 min-w-0 space-y-3">
          {card.status === 'idle' && <p className="text-sm text-gray-500">Ready to generate.</p>}
          {card.status === 'generating' && (
            <p className="text-sm text-gray-400 flex items-center gap-2">
              <span className="inline-block w-4 h-4 border-2 border-green-400 border-t-transparent rounded-full animate-spin" />
              Reading the card and writing the listing…
            </p>
          )}
          {card.status === 'error' && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 flex items-center gap-3">
              <span className="flex-1">{card.error}</span>
              <button onClick={onRegenerate} className="text-xs underline">Retry</button>
            </div>
          )}

          {l && (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span
                  className={`px-2 py-0.5 rounded-full ${
                    l.card.confidence === 'high'
                      ? 'bg-green-500/15 text-green-400'
                      : l.card.confidence === 'medium'
                        ? 'bg-amber-500/15 text-amber-400'
                        : 'bg-red-500/15 text-red-400'
                  }`}
                >
                  {l.card.confidence} confidence
                </span>
                {l.card.rookie && <span className="px-2 py-0.5 rounded-full bg-gray-800 text-gray-300">RC</span>}
                {l.card.autograph && <span className="px-2 py-0.5 rounded-full bg-gray-800 text-gray-300">Auto</span>}
                {l.card.serial_number && <span className="px-2 py-0.5 rounded-full bg-gray-800 text-gray-300">{l.card.serial_number}</span>}
                {l.card.graded && (
                  <span className="px-2 py-0.5 rounded-full bg-gray-800 text-gray-300">{`${l.card.grader ?? ''} ${l.card.grade ?? ''}`.trim()}</span>
                )}
                <div className="flex-1" />
                <button onClick={onRegenerate} className="text-gray-500 hover:text-gray-300">↻ regenerate</button>
              </div>

              {l.card.needs_review.length > 0 && (
                <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-300">
                  <span className="font-semibold">Check before listing:</span> {l.card.needs_review.join(' · ')}
                </div>
              )}

              {/* Title */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wide">Title</span>
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] ${l.title.length > 80 ? 'text-red-400' : 'text-gray-500'}`}>{l.title.length}/80</span>
                    <CopyButton text={l.title} />
                  </div>
                </div>
                <input value={l.title} onChange={e => setListing({ title: e.target.value })} className={input} maxLength={80} />
                {l.alt_titles.length > 0 && (
                  <div className="mt-1.5 space-y-1">
                    {l.alt_titles.map(t => (
                      <button
                        key={t}
                        onClick={() => setListing({ title: t, alt_titles: [l.title, ...l.alt_titles.filter(x => x !== t)] })}
                        className="block text-left text-xs text-gray-500 hover:text-gray-300"
                        title="Use this title instead"
                      >
                        ⇄ {t}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Description */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wide">Description</span>
                  <CopyButton text={l.description} />
                </div>
                <textarea value={l.description} onChange={e => setListing({ description: e.target.value })} rows={6} className={input} />
              </div>

              {/* Item specifics */}
              <details className="group" open>
                <summary className="flex items-center justify-between cursor-pointer list-none mb-1">
                  <span className="text-[10px] text-gray-500 uppercase tracking-wide">
                    Item specifics ({l.item_specifics.length}) <span className="group-open:hidden">▸</span>
                    <span className="hidden group-open:inline">▾</span>
                  </span>
                  <CopyButton text={specificsText} />
                </summary>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-1">
                  {l.item_specifics.map((s, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="text-xs text-gray-500 w-36 shrink-0 truncate" title={s.name}>{s.name}</span>
                      <input
                        value={s.value}
                        onChange={e => setSpecific(idx, { value: e.target.value })}
                        className="flex-1 min-w-0 bg-gray-800 text-white text-xs rounded px-2 py-1 border border-gray-700 focus:border-blue-500 focus:outline-none"
                      />
                    </div>
                  ))}
                </div>
              </details>

              {l.keywords.length > 0 && (
                <p className="text-xs text-gray-500">
                  <span className="text-gray-600 uppercase tracking-wide text-[10px] mr-1">Keywords</span>
                  {l.keywords.join(', ')}
                </p>
              )}
            </>
          )}
        </div>

        {/* Comps + price */}
        {l && (
          <div className="lg:w-80 shrink-0 space-y-3">
            <CompsPanel card={card} onPrice={price => onPatch({ price })} onRefresh={onRefreshComps} />
          </div>
        )}
      </div>
    </div>
  );
}

function CompsPanel({ card, onPrice, onRefresh }: { card: CardJob; onPrice: (p: string) => void; onRefresh: () => void }) {
  const c = card.comps;
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-gray-500 uppercase tracking-wide">Price</span>
        <button onClick={onRefresh} disabled={card.compsStatus === 'loading'} className="text-[11px] text-gray-500 hover:text-gray-300 disabled:opacity-50">
          ↻ comps
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-gray-500">$</span>
        <input
          value={card.price}
          onChange={e => onPrice(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          className="bg-gray-800 text-white text-lg font-semibold rounded-lg px-3 py-1.5 border border-gray-700 focus:border-blue-500 focus:outline-none w-full"
        />
      </div>

      {card.compsStatus === 'loading' && (
        <p className="text-xs text-gray-400 flex items-center gap-2">
          <span className="inline-block w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          Searching sold comps…
        </p>
      )}
      {card.compsStatus === 'error' && <p className="text-xs text-red-400">{card.compsError}</p>}

      {c && (
        <>
          {c.price.suggested != null && (
            <div className="grid grid-cols-3 gap-1 text-center">
              {([['Quick', c.price.quick_sale], ['Market', c.price.suggested], ['High', c.price.high]] as const).map(([label, v]) => (
                <button
                  key={label}
                  onClick={() => v != null && onPrice(v.toFixed(2))}
                  className="rounded bg-gray-900 hover:bg-gray-800 py-1.5 transition"
                >
                  <div className="text-[10px] text-gray-500">{label}</div>
                  <div className={`text-sm font-semibold ${label === 'Market' ? 'text-green-400' : 'text-gray-200'}`}>{money(v)}</div>
                </button>
              ))}
            </div>
          )}
          <p className="text-[11px] text-gray-500">
            {c.price.basis}
            {c.price.confidence !== 'none' && <> · {c.price.confidence} confidence</>}
          </p>
          {c.sold_notes && <p className="text-[11px] text-gray-400">{c.sold_notes}</p>}

          <CompList
            title={`Sold (${c.sold.length})`}
            error={c.sold_error}
            rows={c.sold.map(s => ({
              key: `${s.title}-${s.price}-${s.sold_date}`,
              title: s.title,
              price: s.price,
              meta: [s.sold_date, s.source, s.match === 'close' ? 'close match' : null].filter(Boolean).join(' · '),
              url: s.url,
            }))}
          />
          <CompList
            title={`Active on eBay (${c.active.length})`}
            error={c.active_error}
            rows={c.active.slice(0, 6).map(a => ({ key: a.url, title: a.title, price: a.price, meta: null, url: a.url }))}
          />
          {c.own_sales.length > 0 && (
            <CompList
              title={`Your past sales (${c.own_sales.length})`}
              error={null}
              rows={c.own_sales.map((s, i) => ({
                key: `${i}`,
                title: s.title,
                price: s.price,
                meta: s.sold_date?.slice(0, 10) ?? null,
                url: null,
              }))}
            />
          )}
        </>
      )}
    </div>
  );
}

function CompList({
  title,
  error,
  rows,
}: {
  title: string;
  error: string | null;
  rows: { key: string; title: string; price: number; meta: string | null; url: string | null }[];
}) {
  return (
    <details open={rows.length > 0 && rows.length <= 8}>
      <summary className="text-[10px] text-gray-500 uppercase tracking-wide cursor-pointer">{title}</summary>
      {error && <p className="text-[11px] text-red-400 mt-1">{error}</p>}
      <ul className="mt-1 space-y-1 max-h-56 overflow-auto">
        {rows.map(r => (
          <li key={r.key} className="flex items-start gap-2 text-[11px]">
            <span className="text-gray-200 font-medium w-14 shrink-0 text-right">{money(r.price)}</span>
            <span className="min-w-0">
              {r.url ? (
                <a href={r.url} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-blue-400 line-clamp-2">{r.title}</a>
              ) : (
                <span className="text-gray-400 line-clamp-2">{r.title}</span>
              )}
              {r.meta && <span className="block text-gray-600">{r.meta}</span>}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
