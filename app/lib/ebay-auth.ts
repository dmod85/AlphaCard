import { supabaseAdmin } from './supabase-admin';

const IS_PRODUCTION = process.env.EBAY_ENVIRONMENT === 'PRODUCTION';

const EBAY_AUTH_URL = IS_PRODUCTION
  ? 'https://auth.ebay.com/oauth2/authorize'
  : 'https://auth.sandbox.ebay.com/oauth2/authorize';

const EBAY_TOKEN_URL = IS_PRODUCTION
  ? 'https://api.ebay.com/identity/v1/oauth2/token'
  : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';

const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
].join(' ');

function basicAuth(): string {
  return Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
}

export function getAuthorizationUrl(): string {
  const params = new URLSearchParams({
    client_id: process.env.EBAY_APP_ID!,
    response_type: 'code',
    redirect_uri: process.env.EBAY_REDIRECT_URI!,
    scope: EBAY_SCOPES,
  });
  return `${EBAY_AUTH_URL}?${params}`;
}

export async function exchangeCodeForTokens(code: string) {
  const res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basicAuth()}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.EBAY_REDIRECT_URI!,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; refresh_token: string; expires_in: number }>;
}

async function refreshAccessToken(refreshToken: string) {
  const res = await fetch(EBAY_TOKEN_URL, {
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

// Returns a valid access token, refreshing automatically if needed.
// Throws with a user-facing message if re-authorization is required.
export async function getValidToken(): Promise<string> {
  const { data } = await supabaseAdmin
    .from('ebay_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('id', 'default')
    .single();

  if (data) {
    const expiresAt = new Date(data.expires_at).getTime();
    // Use the stored token if it has more than 5 minutes left
    if (expiresAt - Date.now() > 5 * 60 * 1000) {
      return data.access_token;
    }
    // Attempt a silent refresh
    try {
      const refreshed = await refreshAccessToken(data.refresh_token);
      await saveTokens(refreshed.access_token, data.refresh_token, refreshed.expires_in);
      return refreshed.access_token;
    } catch {
      throw new Error('EBAY_AUTH_REQUIRED');
    }
  }

  throw new Error('EBAY_AUTH_REQUIRED');
}
