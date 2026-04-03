'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

type StepStatus = 'queued' | 'in_progress' | 'completed';
type StepConclusion = 'success' | 'failure' | 'skipped' | 'cancelled' | null;

interface Step {
  number: number;
  name: string;
  status: StepStatus;
  conclusion: StepConclusion;
  startedAt: string | null;
  completedAt: string | null;
}

interface RunState {
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: 'success' | 'failure' | 'cancelled' | null;
  steps: Step[];
  startedAt: string;
  updatedAt: string;
  htmlUrl: string;
}

type PanelPhase =
  | 'idle'
  | 'triggering'    // POST in flight
  | 'waiting'       // run not yet visible on GitHub
  | 'polling'       // run found, steps streaming
  | 'done'          // completed
  | 'error';

interface Props {
  onComplete: (triggeredAt: string) => void;
}

function stepIcon(status: StepStatus, conclusion: StepConclusion) {
  if (status === 'queued') return <span className="text-gray-600">·</span>;
  if (status === 'in_progress') return <Spinner />;
  if (conclusion === 'success') return <span className="text-green-400">✓</span>;
  if (conclusion === 'failure') return <span className="text-red-400">✗</span>;
  if (conclusion === 'skipped') return <span className="text-gray-600">–</span>;
  return <span className="text-gray-500">?</span>;
}

function stepColor(status: StepStatus, conclusion: StepConclusion) {
  if (status === 'in_progress') return 'text-blue-300';
  if (conclusion === 'success') return 'text-gray-300';
  if (conclusion === 'failure') return 'text-red-400';
  return 'text-gray-600';
}

function elapsed(startedAt: string | null, completedAt: string | null) {
  if (!startedAt) return '';
  const end = completedAt ? new Date(completedAt) : new Date();
  const s = Math.round((end.getTime() - new Date(startedAt).getTime()) / 1000);
  return s > 0 ? ` ${s}s` : '';
}

function Spinner() {
  return (
    <span className="inline-block w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin" />
  );
}

export default function RunnerPanel({ onComplete }: Props) {
  const [phase, setPhase] = useState<PanelPhase>('idle');
  const [hunter, setHunter] = useState<string>('all');
  const [runId, setRunId] = useState<number | null>(null);
  const [runState, setRunState] = useState<RunState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [triggeredAt, setTriggeredAt] = useState<string>('');
  const [newLeadsCount, setNewLeadsCount] = useState<number | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Scan filters
  const [showFilters, setShowFilters] = useState(false);
  const [sport, setSport] = useState('all');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minRoi, setMinRoi] = useState('');
  const [minProfit, setMinProfit] = useState('');
  const [broadMode, setBroadMode] = useState(false);

  const buildConfig = () => ({
    sport,
    min_price: minPrice ? parseFloat(minPrice) : 1.0,
    max_price: maxPrice ? parseFloat(maxPrice) : 500.0,
    min_roi: minRoi ? parseFloat(minRoi) : 0.0,
    min_profit: minProfit ? parseFloat(minProfit) : 3.0,
    broad_mode: broadMode,
  });

  const activeFilterCount = [
    sport !== 'all',
    !!minPrice,
    !!maxPrice,
    !!minRoi,
    !!minProfit,
    broadMode,
  ].filter(Boolean).length;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const pollStatus = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/hunters/trigger?runId=${id}`);
      const data: RunState = await res.json();
      setRunState(data);

      if (data.status === 'completed') {
        stopPolling();
        setPhase('done');

        // Count leads discovered after scan was triggered
        const leadsRes = await fetch(
          `/api/leads?status=new&limit=50&discovered_after=${encodeURIComponent(triggeredAt)}`
        );
        const leadsData = await leadsRes.json();
        setNewLeadsCount(leadsData.leads?.length ?? 0);
        onComplete(triggeredAt);
      }
    } catch {
      // swallow poll errors — will retry
    }
  }, [stopPolling, triggeredAt, onComplete]);

  useEffect(() => {
    if (phase === 'polling' && runId) {
      pollRef.current = setInterval(() => pollStatus(runId), 4000);
      pollStatus(runId); // immediate first poll
    }
    return stopPolling;
  }, [phase, runId, pollStatus, stopPolling]);

  const trigger = async () => {
    setPhase('triggering');
    setError(null);
    setRunState(null);
    setRunId(null);
    setNewLeadsCount(null);

    try {
      const res = await fetch('/api/hunters/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hunter: hunter === 'all' ? '' : hunter, config: buildConfig() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to trigger');

      setTriggeredAt(data.triggeredAt);
      setRunId(data.runId);
      setPhase('polling');
    } catch (err: any) {
      setError(err.message);
      setPhase('error');
    }
  };

  const reset = () => {
    stopPolling();
    setPhase('idle');
    setRunState(null);
    setRunId(null);
    setError(null);
    setNewLeadsCount(null);
  };

  const isRunning = phase === 'triggering' || phase === 'polling';
  const totalElapsed = runState
    ? elapsed(runState.startedAt, runState.status === 'completed' ? runState.updatedAt : null)
    : '';

  return (
    <div className="mb-6">
      {/* Trigger bar */}
      <div className="flex items-center gap-3 flex-wrap">
        <select
          value={hunter}
          onChange={e => setHunter(e.target.value)}
          disabled={isRunning}
          className="bg-gray-800 text-gray-300 text-xs rounded-lg px-3 py-1.5 border-0 disabled:opacity-50"
        >
          <option value="all">All hunters</option>
          <option value="typo">Typo Hunter</option>
          <option value="holo">Holo Engine</option>
          <option value="stale">Stale Sniper</option>
        </select>
        <button
          onClick={isRunning ? undefined : trigger}
          disabled={isRunning}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium transition ${
            isRunning
              ? 'bg-blue-500/20 text-blue-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-500'
          }`}
        >
          {isRunning && <Spinner />}
          {phase === 'triggering' ? 'Dispatching...' : isRunning ? 'Scanning...' : 'Run Scan'}
        </button>
        <button
          onClick={() => setShowFilters(v => !v)}
          disabled={isRunning}
          className={`text-xs px-3 py-1.5 rounded-lg transition disabled:opacity-50 ${
            activeFilterCount > 0
              ? 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/30'
              : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
          }`}
        >
          Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''} {showFilters ? '▲' : '▼'}
        </button>
        {(phase === 'done' || phase === 'error') && (
          <button
            onClick={reset}
            className="text-xs text-gray-500 hover:text-gray-300 transition"
          >
            Clear
          </button>
        )}
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="mt-3 bg-gray-900 border border-gray-800 rounded-xl px-4 py-3">
          <div className="flex flex-wrap gap-4 items-end">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">Sport</span>
              <select
                value={sport}
                onChange={e => setSport(e.target.value)}
                className="bg-gray-800 text-gray-300 text-xs rounded-lg px-2 py-1 border-0"
              >
                <option value="all">All sports</option>
                <option value="nfl">NFL</option>
                <option value="nba">NBA</option>
                <option value="mlb">MLB</option>
                <option value="nhl">NHL</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">Min price ($)</span>
              <input
                type="number" min="0" step="1" placeholder="1"
                value={minPrice} onChange={e => setMinPrice(e.target.value)}
                className="bg-gray-800 text-gray-300 text-xs rounded-lg px-2 py-1 border-0 w-20"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">Max price ($)</span>
              <input
                type="number" min="0" step="1" placeholder="500"
                value={maxPrice} onChange={e => setMaxPrice(e.target.value)}
                className="bg-gray-800 text-gray-300 text-xs rounded-lg px-2 py-1 border-0 w-20"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">Min ROI (%)</span>
              <input
                type="number" min="0" step="5" placeholder="0"
                value={minRoi} onChange={e => setMinRoi(e.target.value)}
                className="bg-gray-800 text-gray-300 text-xs rounded-lg px-2 py-1 border-0 w-20"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">Min profit ($)</span>
              <input
                type="number" min="0" step="1" placeholder="3"
                value={minProfit} onChange={e => setMinProfit(e.target.value)}
                className="bg-gray-800 text-gray-300 text-xs rounded-lg px-2 py-1 border-0 w-20"
              />
            </label>
            <label className="flex flex-col gap-1 ml-auto">
              <span className="text-[10px] text-gray-500 uppercase tracking-wide">Broad mode</span>
              <div
                onClick={() => setBroadMode(v => !v)}
                className={`cursor-pointer flex items-center gap-2 text-xs px-3 py-1 rounded-lg transition ${
                  broadMode
                    ? 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/30'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                <span className={`w-3 h-3 rounded-sm border ${
                  broadMode ? 'bg-amber-400 border-amber-400' : 'border-gray-600'
                }`} />
                Skip watchlist
              </div>
            </label>
          </div>
          {broadMode && (
            <p className="text-[10px] text-amber-400/70 mt-2">
              Broad mode: Holo Engine and Stale Sniper will scan sport-wide queries instead of watchlist players.
              Typo Hunter still uses the watchlist (typos require known player names).
            </p>
          )}
        </div>
      )}

      {/* Log panel */}
      {phase !== 'idle' && (
        <div className="mt-3 bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          {/* Panel header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 bg-gray-950">
            <div className="flex items-center gap-2">
              {isRunning && <Spinner />}
              {phase === 'done' && runState?.conclusion === 'success' && (
                <span className="text-green-400 text-sm">✓</span>
              )}
              {phase === 'done' && runState?.conclusion !== 'success' && (
                <span className="text-red-400 text-sm">✗</span>
              )}
              {phase === 'error' && <span className="text-red-400 text-sm">✗</span>}
              <span className="text-xs font-mono text-gray-400">
                {phase === 'triggering' && 'Dispatching workflow...'}
                {phase === 'polling' && !runState && 'Waiting for runner...'}
                {phase === 'polling' && runState && `Hunter scan · ${runState.status.replace('_', ' ')}`}
                {phase === 'done' && `Scan complete${totalElapsed}`}
                {phase === 'error' && 'Scan failed'}
              </span>
            </div>
            {runState?.htmlUrl && (
              <a
                href={runState.htmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-gray-600 hover:text-gray-400 transition"
              >
                GitHub ↗
              </a>
            )}
          </div>

          {/* Steps */}
          <div className="px-4 py-3 font-mono text-xs space-y-1.5">
            {phase === 'error' && (
              <div className="text-red-400">{error}</div>
            )}

            {(phase === 'polling' || phase === 'done') && !runState && (
              <div className="text-gray-600">Waiting for GitHub Actions runner to pick up job...</div>
            )}

            {runState?.steps.map(step => (
              <div key={step.number} className="flex items-center gap-2.5">
                <span className="w-3 flex justify-center shrink-0">
                  {stepIcon(step.status, step.conclusion)}
                </span>
                <span className={stepColor(step.status, step.conclusion)}>
                  {step.name}
                </span>
                {step.status !== 'queued' && (
                  <span className="text-gray-700 ml-auto">
                    {elapsed(step.startedAt, step.completedAt)}
                  </span>
                )}
              </div>
            ))}

            {/* Result summary */}
            {phase === 'done' && (
              <div className="mt-3 pt-3 border-t border-gray-800">
                {runState?.conclusion === 'success' ? (
                  <div className="text-green-400">
                    {newLeadsCount === null
                      ? 'Refreshing leads...'
                      : newLeadsCount > 0
                      ? `${newLeadsCount} new lead${newLeadsCount !== 1 ? 's' : ''} found ↓`
                      : 'No new leads this scan'}
                  </div>
                ) : (
                  <div className="text-red-400">
                    Scan ended with {runState?.conclusion}. Check{' '}
                    <a href={runState?.htmlUrl} target="_blank" rel="noopener noreferrer"
                       className="underline">GitHub Actions</a> for details.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
