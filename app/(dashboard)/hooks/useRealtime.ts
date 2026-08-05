'use client';

import { useEffect, useState, useCallback, useRef, type Dispatch, type SetStateAction } from 'react';
import { supabase } from '@/app/lib/supabase';
import type { Lead } from '@/app/types';

/**
 * Hook for real-time Supabase subscriptions on the raw_leads table.
 * Automatically updates the lead list when new leads are inserted,
 * or existing leads are updated/deleted.
 */
export function useRealtimeLeads(initialLeads: Lead[] = []) {
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [isConnected, setIsConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    setLeads(initialLeads);
  }, [initialLeads]);

  useEffect(() => {
    const channel = supabase
      .channel('leads-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'raw_leads' },
        (payload) => {
          const newLead = payload.new as Lead;
          setLeads(prev => [newLead, ...prev]);
          setLastUpdate(new Date());
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'raw_leads' },
        (payload) => {
          const updated = payload.new as Lead;
          setLeads(prev =>
            prev.map(l => (l.id === updated.id ? updated : l))
          );
          setLastUpdate(new Date());
        }
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'raw_leads' },
        (payload) => {
          const deleted = payload.old as { id: string };
          setLeads(prev => prev.filter(l => l.id !== deleted.id));
          setLastUpdate(new Date());
        }
      )
      .subscribe((status) => {
        setIsConnected(status === 'SUBSCRIBED');
      });

    channelRef.current = channel;

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, []);

  const removeLead = useCallback((id: string) => {
    setLeads(prev => prev.filter(l => l.id !== id));
  }, []);

  return { leads, isConnected, lastUpdate, removeLead };
}

/**
 * Hook for real-time notification count (new leads since last check)
 */
export function useNewLeadCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const channel = supabase
      .channel('lead-count')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'raw_leads' },
        () => {
          setCount(prev => prev + 1);
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  const reset = useCallback(() => setCount(0), []);
  return { count, reset };
}

/**
 * Hook for real-time hunter run status
 */
export function useHunterRunStatus() {
  const [activeRun, setActiveRun] = useState<{
    id: string;
    hunter_type: string;
    started_at: string;
  } | null>(null);

  useEffect(() => {
    const channel = supabase
      .channel('hunter-runs')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'hunter_runs' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setActiveRun({
              id: (payload.new as any).id,
              hunter_type: (payload.new as any).hunter_type,
              started_at: (payload.new as any).started_at,
            });
          } else if (payload.eventType === 'UPDATE') {
            const run = payload.new as any;
            if (run.status === 'completed' || run.status === 'failed') {
              setActiveRun(null);
            }
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, []);

  return activeRun;
}

/**
 * Wires an existing sales-list state setter up to Supabase Realtime on
 * ebay_sales (enabled in 20260804_packing_slip_printed.sql — the same
 * publication the local packing-slip print agent listens on). Merges
 * INSERT/UPDATE/DELETE events into whatever state the caller already
 * manages via fetch/sync, so e.g. a shipping label bought after the page
 * loaded (which lands as an UPDATE — tracking_number/shipped_at/
 * packing_slip_url) shows up within ~1s without a manual refresh.
 *
 * Takes the caller's own setState rather than owning the list itself, since
 * the Sales page already fetches/replaces its list via /api/ebay/sold-orders
 * — this only layers realtime deltas on top of that.
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
