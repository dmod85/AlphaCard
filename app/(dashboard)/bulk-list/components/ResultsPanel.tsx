'use client';

import type { EbayListingJob, EbayListingItem } from '@/app/types';

interface Props {
  job: EbayListingJob;
  items: EbayListingItem[];
}

export default function ResultsPanel({ job, items }: Props) {
  const listed = items.filter(i => i.status === 'listed');
  const failed = items.filter(i => i.status === 'failed');
  const pending = items.filter(i => i.status === 'pending');
  const progress = job.total_items > 0 ? ((listed.length + failed.length) / job.total_items) * 100 : 0;

  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-white mb-3 flex items-center gap-2">
        {job.status === 'processing' ? (
          <span className="inline-block w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
        ) : listed.length > 0 && failed.length === 0 ? (
          <span className="text-green-400">✓</span>
        ) : failed.length > 0 ? (
          <span className="text-amber-400">⚠</span>
        ) : null}
        Listing Results
      </h3>

      {/* Progress Bar */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 mb-3">
        <div className="flex items-center justify-between text-xs mb-2">
          <div className="flex gap-4">
            <span className="text-green-400">✓ {listed.length} listed</span>
            {failed.length > 0 && <span className="text-red-400">✗ {failed.length} failed</span>}
            {pending.length > 0 && <span className="text-gray-500">⏳ {pending.length} pending</span>}
          </div>
          <span className="text-gray-500">{Math.round(progress)}%</span>
        </div>
        <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full flex">
            <div
              className="bg-green-500 transition-all duration-500"
              style={{ width: `${job.total_items > 0 ? (listed.length / job.total_items) * 100 : 0}%` }}
            />
            <div
              className="bg-red-500 transition-all duration-500"
              style={{ width: `${job.total_items > 0 ? (failed.length / job.total_items) * 100 : 0}%` }}
            />
          </div>
        </div>
      </div>

      {/* Items */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <div className="max-h-80 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-800/60 sticky top-0">
              <tr>
                <th className="text-left p-3 text-gray-500 font-medium w-8">Status</th>
                <th className="text-left p-3 text-gray-500 font-medium">Title</th>
                <th className="text-right p-3 text-gray-500 font-medium">Price</th>
                <th className="text-left p-3 text-gray-500 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.id} className="border-t border-gray-800/50">
                  <td className="p-3">
                    {item.status === 'listed' && <span className="text-green-400">✓</span>}
                    {item.status === 'failed' && <span className="text-red-400">✗</span>}
                    {item.status === 'pending' && <span className="text-gray-600">⏳</span>}
                  </td>
                  <td className="p-3 text-gray-300 max-w-sm truncate">{item.title}</td>
                  <td className="p-3 text-right text-white font-medium">${Number(item.price).toFixed(2)}</td>
                  <td className="p-3">
                    {item.status === 'listed' && item.ebay_listing_url ? (
                      <a
                        href={item.ebay_listing_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-400 hover:text-blue-300 transition"
                      >
                        View on eBay ↗
                      </a>
                    ) : item.status === 'failed' ? (
                      <span className="text-red-400" title={item.error_message || ''}>
                        {item.error_message?.slice(0, 60) || 'Failed'}
                        {(item.error_message?.length || 0) > 60 ? '...' : ''}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
