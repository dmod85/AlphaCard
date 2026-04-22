'use client';

import { useState, useEffect } from 'react';
import type { EbayListingJob } from '@/app/types';

export default function JobHistory() {
  const [jobs, setJobs] = useState<EbayListingJob[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ebay/bulk-list/jobs');
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (expanded) fetchJobs();
  }, [expanded]);

  return (
    <div className="mt-8">
      <button
        onClick={() => setExpanded(v => !v)}
        className="flex items-center gap-2 text-sm text-gray-500 hover:text-gray-300 transition"
      >
        <span>{expanded ? '▼' : '▶'}</span>
        <span>Past Listing Jobs</span>
      </button>

      {expanded && (
        <div className="mt-3 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {loading ? (
            <div className="p-4 text-center text-xs text-gray-600">Loading...</div>
          ) : jobs.length === 0 ? (
            <div className="p-4 text-center text-xs text-gray-600">No past jobs found.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-gray-800/60">
                <tr>
                  <th className="text-left p-3 text-gray-500 font-medium">Date</th>
                  <th className="text-right p-3 text-gray-500 font-medium">Total</th>
                  <th className="text-right p-3 text-gray-500 font-medium">Listed</th>
                  <th className="text-right p-3 text-gray-500 font-medium">Failed</th>
                  <th className="text-center p-3 text-gray-500 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(job => (
                  <tr key={job.id} className="border-t border-gray-800/50 hover:bg-gray-800/30 transition">
                    <td className="p-3 text-gray-400 whitespace-nowrap">
                      {new Date(job.created_at).toLocaleString('en-US', {
                        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                      })}
                    </td>
                    <td className="p-3 text-right text-white">{job.total_items}</td>
                    <td className="p-3 text-right text-green-400">{job.listed_count}</td>
                    <td className="p-3 text-right text-red-400">{job.failed_count > 0 ? job.failed_count : '—'}</td>
                    <td className="p-3 text-center">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        job.status === 'completed' && job.failed_count === 0
                          ? 'bg-green-500/10 text-green-400'
                          : job.status === 'completed' && job.failed_count > 0
                          ? 'bg-amber-500/10 text-amber-400'
                          : job.status === 'processing'
                          ? 'bg-blue-500/10 text-blue-400'
                          : 'bg-gray-700 text-gray-400'
                      }`}>
                        {job.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
