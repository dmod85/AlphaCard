import { NextRequest, NextResponse } from 'next/server';

const GITHUB_API = 'https://api.github.com';
const REPO = 'dmod85/AlphaCard';
const WORKFLOW = 'hunter-scan.yml';

function ghHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_PAT}`,
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

// POST /api/hunters/trigger — dispatch a workflow run
// Body: { hunter?: 'typo' | 'holo' | 'stale' | 'all' }
// Returns: { runId, triggeredAt }
export async function POST(request: NextRequest) {
  const { hunter } = await request.json().catch(() => ({}));
  const triggeredAt = new Date().toISOString();

  const dispatch = await fetch(
    `${GITHUB_API}/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: { ...ghHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'master', inputs: { hunter: hunter || '' } }),
    }
  );

  if (!dispatch.ok) {
    const err = await dispatch.text();
    return NextResponse.json({ error: `GitHub dispatch failed: ${err}` }, { status: 502 });
  }

  // GitHub returns 204 — poll until the new run appears (created after triggeredAt)
  const triggeredMs = new Date(triggeredAt).getTime();
  let runId: number | null = null;

  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise(r => setTimeout(r, 3000));

    const runsRes = await fetch(
      `${GITHUB_API}/repos/${REPO}/actions/runs?event=workflow_dispatch&per_page=5`,
      { headers: ghHeaders() }
    );
    const { workflow_runs } = await runsRes.json();

    const match = (workflow_runs as any[]).find(
      r => new Date(r.created_at).getTime() >= triggeredMs - 5000
    );
    if (match) {
      runId = match.id;
      break;
    }
  }

  if (!runId) {
    return NextResponse.json({ error: 'Run did not appear within 36s' }, { status: 504 });
  }

  return NextResponse.json({ runId, triggeredAt });
}

// GET /api/hunters/trigger?runId=xxx — poll run status and steps
export async function GET(request: NextRequest) {
  const runId = request.nextUrl.searchParams.get('runId');
  if (!runId) return NextResponse.json({ error: 'runId required' }, { status: 400 });

  const [runRes, jobsRes] = await Promise.all([
    fetch(`${GITHUB_API}/repos/${REPO}/actions/runs/${runId}`, { headers: ghHeaders() }),
    fetch(`${GITHUB_API}/repos/${REPO}/actions/runs/${runId}/jobs`, { headers: ghHeaders() }),
  ]);

  const run = await runRes.json();
  const { jobs } = await jobsRes.json();

  const job = (jobs as any[])?.[0];

  return NextResponse.json({
    status: run.status as 'queued' | 'in_progress' | 'completed',
    conclusion: run.conclusion as 'success' | 'failure' | 'cancelled' | null,
    steps: (job?.steps ?? []).map((s: any) => ({
      name: s.name,
      status: s.status,
      conclusion: s.conclusion,
      number: s.number,
      startedAt: s.started_at,
      completedAt: s.completed_at,
    })),
    startedAt: run.run_started_at ?? run.created_at,
    updatedAt: run.updated_at,
    htmlUrl: run.html_url,
  });
}
