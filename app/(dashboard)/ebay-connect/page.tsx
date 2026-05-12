'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function EbayConnectPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = async () => {
    const trimmed = code.trim();
    if (!trimmed) return;

    setStatus('loading');
    setErrorMsg('');

    try {
      const res = await fetch('/api/ebay/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Exchange failed');
      setStatus('success');
      setTimeout(() => router.push('/active-listings'), 1500);
    } catch (err: any) {
      setStatus('error');
      setErrorMsg(err.message);
    }
  };

  return (
    <div className="flex-1 p-6 bg-gray-900 min-h-screen flex items-start justify-center pt-20">
      <div className="w-full max-w-lg">
        <h1 className="text-xl font-semibold text-white mb-1">Connect eBay Account</h1>
        <p className="text-sm text-gray-400 mb-8">One-time setup — takes about 60 seconds.</p>

        <div className="space-y-6">
          {/* Step 1 */}
          <div className="flex gap-4">
            <div className="w-7 h-7 rounded-full bg-green-600 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">1</div>
            <div>
              <p className="text-sm text-gray-200 font-medium">Start the eBay authorization</p>
              <p className="text-xs text-gray-500 mt-0.5 mb-3">Opens eBay's consent page in a new tab.</p>
              <a
                href="/api/ebay/auth"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-500 transition"
              >
                Open eBay Sign-In →
              </a>
            </div>
          </div>

          {/* Step 2 */}
          <div className="flex gap-4">
            <div className="w-7 h-7 rounded-full bg-green-600 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">2</div>
            <div className="w-full">
              <p className="text-sm text-gray-200 font-medium">Sign in and click "Agree and Continue"</p>
              <p className="text-xs text-gray-500 mt-0.5">
                eBay will redirect you to Google. The URL will look like:<br />
                <code className="text-green-400 text-[11px]">https://google.com/?code=v^1.1...&amp;expires_in=...</code>
              </p>
            </div>
          </div>

          {/* Step 3 */}
          <div className="flex gap-4">
            <div className="w-7 h-7 rounded-full bg-green-600 text-white text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">3</div>
            <div className="w-full">
              <p className="text-sm text-gray-200 font-medium mb-2">Copy the code from the URL and paste it here</p>
              <p className="text-xs text-gray-500 mb-3">
                Copy everything after <code className="text-gray-300">code=</code> up to (but not including) <code className="text-gray-300">&amp;expires_in</code>
              </p>
              <textarea
                value={code}
                onChange={e => setCode(e.target.value)}
                placeholder="v^1.1#i^1#r^1#f^0#p^1..."
                rows={4}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 font-mono focus:outline-none focus:border-blue-500 resize-none"
              />

              {status === 'error' && (
                <p className="text-red-400 text-xs mt-2">{errorMsg}</p>
              )}
              {status === 'success' && (
                <p className="text-green-400 text-xs mt-2">Connected! Redirecting to Active Listings...</p>
              )}

              <button
                onClick={handleSubmit}
                disabled={!code.trim() || status === 'loading' || status === 'success'}
                className="mt-3 px-5 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-500 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === 'loading' ? 'Connecting...' : 'Connect eBay'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
