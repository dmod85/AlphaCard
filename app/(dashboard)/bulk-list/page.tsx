'use client';

import { useState } from 'react';
import type { BulkListStagingItem, EbayListingJob, EbayListingItem } from '@/app/types';
import CardEntryForm from './components/CardEntryForm';
import CsvUpload from './components/CsvUpload';
import StagingTable from './components/StagingTable';
import ResultsPanel from './components/ResultsPanel';
import JobHistory from './components/JobHistory';

export default function BulkListPage() {
  const [stagingItems, setStagingItems] = useState<BulkListStagingItem[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeJob, setActiveJob] = useState<EbayListingJob | null>(null);
  const [jobItems, setJobItems] = useState<EbayListingItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'manual' | 'csv'>('manual');

  const addItem = (item: BulkListStagingItem) => {
    setStagingItems(prev => [...prev, item]);
  };

  const addItems = (items: BulkListStagingItem[]) => {
    setStagingItems(prev => [...prev, ...items]);
  };

  const removeItem = (id: string) => {
    setStagingItems(prev => prev.filter(i => i.id !== id));
  };

  const clearAll = () => setStagingItems([]);

  const updateItem = (id: string, updates: Partial<BulkListStagingItem>) => {
    setStagingItems(prev => prev.map(i => i.id === id ? { ...i, ...updates } : i));
  };

  const submitBatch = async () => {
    if (stagingItems.length === 0) return;
    setIsSubmitting(true);
    setError(null);
    setActiveJob(null);
    setJobItems([]);

    try {
      const res = await fetch('/api/ebay/bulk-list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: stagingItems }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit batch');

      setActiveJob(data.job);
      setJobItems(data.items || []);
      setStagingItems([]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const totalValue = stagingItems.reduce((s, i) => s + i.price * i.quantity, 0);
  const estFees = totalValue * 0.1325 + stagingItems.length * 0.30;

  return (
    <div className="p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <span>🚀</span> Bulk List on eBay
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Add cards manually or upload a CSV, then list them all on eBay in one click.
        </p>
      </div>

      {/* Input Tabs */}
      <div className="flex gap-1 mb-4">
        <button
          onClick={() => setActiveTab('manual')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            activeTab === 'manual'
              ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          ✏️ Manual Entry
        </button>
        <button
          onClick={() => setActiveTab('csv')}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
            activeTab === 'csv'
              ? 'bg-blue-500/20 text-blue-400 ring-1 ring-blue-500/30'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          📄 CSV Upload
        </button>
      </div>

      {/* Input Section */}
      {activeTab === 'manual' ? (
        <CardEntryForm onAdd={addItem} />
      ) : (
        <CsvUpload onImport={addItems} />
      )}

      {/* Staging Table */}
      {stagingItems.length > 0 && (
        <div className="mt-6">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-white">
              Staging — {stagingItems.length} card{stagingItems.length !== 1 ? 's' : ''}
            </h3>
            <div className="flex items-center gap-4 text-xs text-gray-500">
              <span>Total: <span className="text-white font-medium">${totalValue.toFixed(2)}</span></span>
              <span>Est. fees: <span className="text-amber-400">${estFees.toFixed(2)}</span></span>
            </div>
          </div>
          <StagingTable
            items={stagingItems}
            onRemove={removeItem}
            onUpdate={updateItem}
            onClear={clearAll}
          />
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={submitBatch}
              disabled={isSubmitting}
              className="px-6 py-2.5 bg-green-500 text-black rounded-lg text-sm font-semibold hover:bg-green-400 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center gap-2"
            >
              {isSubmitting ? (
                <>
                  <span className="inline-block w-4 h-4 border-2 border-black border-t-transparent rounded-full animate-spin" />
                  Listing on eBay...
                </>
              ) : (
                <>🚀 List All on eBay</>
              )}
            </button>
            <button
              onClick={clearAll}
              className="px-4 py-2.5 bg-gray-800 text-gray-400 rounded-lg text-sm hover:bg-gray-700 transition"
            >
              Clear All
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {activeJob && (
        <ResultsPanel job={activeJob} items={jobItems} />
      )}

      {/* Job History */}
      <JobHistory />
    </div>
  );
}
