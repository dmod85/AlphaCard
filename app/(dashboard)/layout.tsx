'use client';

import { useState } from 'react';
import Navigation from './components/Navigation';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <div className="flex flex-col nav:flex-row h-screen overflow-hidden bg-gray-950">
      {/* Top bar — shown below the nav breakpoint in place of the always-visible sidebar */}
      <div className="nav:hidden flex items-center gap-3 px-4 py-2.5 border-b border-gray-800 bg-gray-950 shrink-0">
        <button
          onClick={() => setNavOpen(true)}
          aria-label="Open menu"
          className="p-1.5 -ml-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-gray-900 transition"
        >
          <span className="text-lg leading-none">☰</span>
        </button>
        <span className="text-sm font-bold tracking-tight">
          <span className="text-green-400">Alpha</span>
          <span className="text-white">Card</span>
        </span>
      </div>

      <Navigation open={navOpen} onClose={() => setNavOpen(false)} />

      <main className="flex-1 min-h-0 h-full overflow-hidden">
        {children}
      </main>
    </div>
  );
}
