'use client';

import Navigation from './components/Navigation';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      <Navigation />
      <main className="flex-1 h-full overflow-hidden">
        {children}
      </main>
    </div>
  );
}
