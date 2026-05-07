'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { useNewLeadCount, useHunterRunStatus } from '../hooks/useRealtime';

const NAV_ITEMS = [
  { href: '/', label: 'Leads', icon: '⚡' },
  { href: '/watchlist', label: 'Watchlist', icon: '👁' },
  { href: '/inventory', label: 'Inventory', icon: '📦' },
  { href: '/bulk-list', label: 'Bulk List ', icon: '🚀' },
  { href: '/active-listings', label: 'Active Listings', icon: '📋' },
  { href: '/analytics', label: 'Analytics', icon: '📊' },
];

export default function Navigation() {
  const pathname = usePathname();
  const { count: newLeads, reset } = useNewLeadCount();
  const activeRun = useHunterRunStatus();

  return (
    <nav className="w-56 bg-gray-950 border-r border-gray-800 min-h-screen p-4 flex flex-col">
      {/* Logo */}
      <div className="mb-8">
        <h1 className="text-lg font-bold tracking-tight">
          <span className="text-green-400">Alpha</span>
          <span className="text-white">Card</span>
        </h1>
        <p className="text-[10px] text-gray-600 tracking-widest uppercase mt-0.5">
          Sourcing Engine
        </p>
      </div>

      {/* Nav Links */}
      <div className="space-y-1 flex-1">
        {NAV_ITEMS.map(item => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => {
                if (item.href === '/' && newLeads > 0) reset();
              }}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${isActive
                  ? 'bg-gray-800 text-white font-medium'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-gray-900'
                }`}
            >
              <span className="text-base">{item.icon}</span>
              <span>{item.label}</span>
              {item.href === '/' && newLeads > 0 && (
                <span className="ml-auto bg-green-500/20 text-green-400 text-[10px] font-bold px-1.5 py-0.5 rounded-full">
                  +{newLeads}
                </span>
              )}
            </Link>
          );
        })}
      </div>

      {/* Active Hunt Status */}
      {activeRun && (
        <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 bg-blue-400 rounded-full animate-pulse" />
            <span className="text-xs text-blue-400 font-medium">Scanning...</span>
          </div>
          <p className="text-[10px] text-blue-400/60 mt-1">
            {activeRun.hunter_type.replace('_', ' ')}
          </p>
        </div>
      )}

      {/* Connection Status */}
      <div className="mt-4 pt-4 border-t border-gray-800">
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 bg-green-500 rounded-full" />
          <span className="text-[10px] text-gray-600">Realtime connected</span>
        </div>
      </div>
    </nav>
  );
}
