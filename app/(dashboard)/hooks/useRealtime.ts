'use client';

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { supabase } from '@/app/lib/supabase';

/**
 * Wires an existing sales-list state setter up to Supabase Realtime on
 * ebay_sales (enabled in 20260804_packing_slip_printed.sql — the same
 * publication the local packing-slip print agent listens on). Merges
 * INSERT/UPDATE/DELETE events into whatever state the caller already
 * manages via fetch/sync.
 */
export function useSalesRealtimeSync<T extends { id: string }>(
  setSales: Dispatch<SetStateAction<T[]>>
) {
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    const channel = supabase
      .channel('ebay-sales-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ebay_sales' },
        (payload) => {
          const row = payload.new as T;
          setSales((prev) => (prev.some((s) => s.id === row.id) ? prev : [row, ...prev]));
          setLastUpdate(new Date());
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'ebay_sales' },
        (payload) => {
          const row = payload.new as T;
          setSales((prev) => prev.map((s) => (s.id === row.id ? { ...s, ...row } : s)));
          setLastUpdate(new Date());
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'ebay_sales' },
        (payload) => {
          const oldRow = payload.old as { id: string };
          setSales((prev) => prev.filter((s) => s.id !== oldRow.id));
          setLastUpdate(new Date());
        }
      )
      .subscribe((status) => setIsConnected(status === 'SUBSCRIBED'));

    return () => { supabase.removeChannel(channel); };
  }, [setSales]);

  return { isConnected, lastUpdate };
}
