import { supabaseAdmin } from './supabase-admin';

const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account.readonly',
].join(' ');

// Evaluated lazily at call time so env vars are always fully loaded
function isProd(): boolean {
  return process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
}
function authUrl(): string {
  return isProd()
    ? 'https://auth.ebay.com/oauth2/authorize'
    : 'https://auth.sandbox.ebay.com/oauth2/authorize';
}
function tokenUrl(): string {
  return isProd()
    ? 'https://api.ebay.com/identity/v1/oauth2/token'
    : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
}
function basicAuth(): string {
  return Buffer.from(`${process.env.EBAY_APP_ID!.trim()}:${process.env.EBAY_CERT_ID!.trim()}`).toString('base64');
}

export function getAuthorizationUrl(): string {
  const params = new URLSearchParams({
    client_id: process.env.EBAY_APP_ID!.trim(),
    response_type: 'code',
    redirect_uri: process.env.EBAY_REDIRECT_URI!.trim(),
  });
  // Append scope manually — URLSearchParams encodes : and / but eBay matches scope strings literally
  const scope = EBAY_SCOPES.replace(/ /g, '%20');
  return `${authUrl()}?${params.toString()}&scope=${scope}`;
}

export async function exchangeCodeForTokens(code: string) {
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth()}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.EBAY_REDIRECT_URI!.trim(),
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth()}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: EBAY_SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

export async function saveTokens(accessToken: string, refreshToken: string, expiresIn: number) {
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  await supabaseAdmin.from('ebay_tokens').upsert({
    id: 'default',
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  });
}

// Returns a valid access token. Checks Supabase first, then falls back to
// EBAY_OAUTH_TOKEN env var (Trading API / Auth'n'Auth style token).
export async function getValidToken(): Promise<string> {
  const { data } = await supabaseAdmin
    .from('ebay_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('id', 'default')
    .single();

  if (data) {
    const expiresAt = new Date(data.expires_at).getTime();
    if (expiresAt - Date.now() > 5 * 60 * 1000) {
      return data.access_token;
    }
    try {
      const refreshed = await refreshAccessToken(data.refresh_token);
      await saveTokens(refreshed.access_token, data.refresh_token, refreshed.expires_in);
      return refreshed.access_token;
    } catch {
      // fall through to env token
    }
  }

  const envToken = process.env.EBAY_OAUTH_TOKEN?.trim().replace(/^'|'$/g, '');
  if (envToken) return envToken;

  throw new Error('EBAY_AUTH_REQUIRED');
}
