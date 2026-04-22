'use client';

import { useState, useRef, useCallback } from 'react';
import type { BulkListStagingItem } from '@/app/types';

interface Props {
  onImport: (items: BulkListStagingItem[]) => void;
}

const EXPECTED_HEADERS = [
  'title', 'player_name', 'card_year', 'card_set', 'card_number',
  'sport', 'condition', 'grader', 'grade', 'cert_number', 'price', 'quantity', 'image_url',
];

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let current = '';
  let inQuotes = false;
  let row: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        row.push(current.trim());
        current = '';
      } else if (ch === '\n' || (ch === '\r' && next === '\n')) {
        row.push(current.trim());
        if (row.some(c => c !== '')) rows.push(row);
        row = [];
        current = '';
        if (ch === '\r') i++;
      } else {
        current += ch;
      }
    }
  }
  // Last row
  row.push(current.trim());
  if (row.some(c => c !== '')) rows.push(row);

  return rows;
}

function mapRowToItem(headers: string[], row: string[]): BulkListStagingItem | null {
  const get = (key: string) => {
    const idx = headers.indexOf(key);
    return idx >= 0 ? (row[idx] || '') : '';
  };

  const price = parseFloat(get('price'));
  if (isNaN(price) || price <= 0) return null;

  const playerName = get('player_name');
  const title = get('title') || [get('card_year'), get('card_set'), playerName, get('card_number') ? `#${get('card_number')}` : ''].filter(Boolean).join(' ');

  if (!title && !playerName) return null;

  return {
    id: crypto.randomUUID(),
    title,
    player_name: playerName,
    card_year: get('card_year') ? parseInt(get('card_year')) : null,
    card_set: get('card_set'),
    card_number: get('card_number'),
    sport: get('sport') || 'mlb',
    condition: (get('condition') === 'graded' ? 'graded' : 'ungraded'),
    grader: get('grader'),
    grade: get('grade'),
    cert_number: get('cert_number'),
    price,
    quantity: parseInt(get('quantity')) || 1,
    image_urls: get('image_url') ? [get('image_url')] : [],
  };
}

export default function CsvUpload({ onImport }: Props) {
  const [preview, setPreview] = useState<BulkListStagingItem[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback((file: File) => {
    setParseError(null);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const rows = parseCSV(text);
        if (rows.length < 2) {
          setParseError('CSV must have at least a header row and one data row.');
          return;
        }

        const headers = rows[0].map(h => h.toLowerCase().replace(/\s+/g, '_'));
        const dataRows = rows.slice(1);
        const items: BulkListStagingItem[] = [];
        const errors: string[] = [];

        dataRows.forEach((row, idx) => {
          const item = mapRowToItem(headers, row);
          if (item) {
            items.push(item);
          } else {
            errors.push(`Row ${idx + 2}: missing required fields (title/player_name and price)`);
          }
        });

        if (items.length === 0) {
          setParseError(`No valid rows found. ${errors.slice(0, 3).join('; ')}`);
          return;
        }

        if (errors.length > 0) {
          setParseError(`${errors.length} row(s) skipped: ${errors.slice(0, 2).join('; ')}`);
        }

        setPreview(items);
      } catch {
        setParseError('Failed to parse CSV file.');
      }
    };
    reader.readAsText(file);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.csv') || file.type === 'text/csv')) {
      processFile(file);
    } else {
      setParseError('Please upload a .csv file');
    }
  }, [processFile]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const confirmImport = () => {
    if (preview) {
      onImport(preview);
      setPreview(null);
    }
  };

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      {!preview ? (
        <>
          {/* Drop Zone */}
          <div
            onDragOver={e => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileRef.current?.click()}
            className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all ${
              dragOver
                ? 'border-blue-500 bg-blue-500/5'
                : 'border-gray-700 hover:border-gray-600 hover:bg-gray-800/50'
            }`}
          >
            <div className="text-3xl mb-3">📄</div>
            <p className="text-sm text-gray-300 font-medium">
              Drop your CSV here or <span className="text-blue-400">browse files</span>
            </p>
            <p className="text-xs text-gray-600 mt-2">
              Expected columns: {EXPECTED_HEADERS.join(', ')}
            </p>
            <input ref={fileRef} type="file" accept=".csv" onChange={handleFileSelect} className="hidden" />
          </div>

          {/* Download Template */}
          <div className="mt-3 flex justify-center">
            <button
              onClick={() => {
                const csv = EXPECTED_HEADERS.join(',') + '\n' +
                  '2023 Topps Chrome Patrick Mahomes #150,Patrick Mahomes,2023,Topps Chrome,150,nfl,ungraded,,,,9.99,1,\n';
                const blob = new Blob([csv], { type: 'text/csv' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = 'ebay_bulk_template.csv'; a.click();
                URL.revokeObjectURL(url);
              }}
              className="text-xs text-gray-500 hover:text-blue-400 transition underline"
            >
              Download CSV template
            </button>
          </div>

          {parseError && (
            <div className="mt-3 p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
              {parseError}
            </div>
          )}
        </>
      ) : (
        <>
          {/* Preview */}
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-white">
              Preview — {preview.length} card{preview.length !== 1 ? 's' : ''} parsed
            </h4>
            <div className="flex gap-2">
              <button
                onClick={() => setPreview(null)}
                className="px-3 py-1.5 bg-gray-800 text-gray-400 rounded-lg text-xs hover:bg-gray-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmImport}
                className="px-4 py-1.5 bg-green-500 text-black rounded-lg text-xs font-medium hover:bg-green-400 transition"
              >
                Import {preview.length} cards
              </button>
            </div>
          </div>

          {parseError && (
            <div className="mb-3 p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400">
              ⚠ {parseError}
            </div>
          )}

          <div className="overflow-x-auto max-h-64 overflow-y-auto rounded-lg border border-gray-800">
            <table className="w-full text-xs">
              <thead className="bg-gray-800/60 sticky top-0">
                <tr>
                  <th className="text-left p-2 text-gray-500 font-medium">Title</th>
                  <th className="text-left p-2 text-gray-500 font-medium">Sport</th>
                  <th className="text-left p-2 text-gray-500 font-medium">Condition</th>
                  <th className="text-right p-2 text-gray-500 font-medium">Price</th>
                  <th className="text-right p-2 text-gray-500 font-medium">Qty</th>
                </tr>
              </thead>
              <tbody>
                {preview.slice(0, 50).map(item => (
                  <tr key={item.id} className="border-t border-gray-800/50">
                    <td className="p-2 text-gray-300 max-w-xs truncate">{item.title}</td>
                    <td className="p-2 text-gray-400">{item.sport.toUpperCase()}</td>
                    <td className="p-2 text-gray-400 capitalize">{item.condition}</td>
                    <td className="p-2 text-right text-white font-medium">${item.price.toFixed(2)}</td>
                    <td className="p-2 text-right text-gray-400">{item.quantity}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.length > 50 && (
              <div className="p-2 text-center text-xs text-gray-600">
                ... and {preview.length - 50} more
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
