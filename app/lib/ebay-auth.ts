/**
 * eBay Auth — Supabase-backed token storage with auto-refresh.
 *
 * Token resolution priority:
 * 1. In-memory cache (fastest, avoids DB on every call)
 * 2. Supabase ebay_tokens (id='default') — non-expired access_token
 * 3. Refresh via refresh_token from Supabase row or EBAY_REFRESH_TOKEN env
 * 4. Fallback to EBAY_OAUTH_TOKEN env (may be expired)
 *
 * Run the Auth'n'Auth flow at /ebay-connect to populate the DB.
 */

import { supabaseAdmin } from './supabase-admin';

const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
  'https://api.ebay.com/oauth/api_scope/sell.marketplace.insights.readonly',
].join(' ');

/** In-memory cache so we don't refresh on every single API call */
let cachedToken: string | null = null;
let cachedTokenExpiry: number = 0;

/** Call this when eBay rejects a token so the next request forces a fresh fetch. */
export function clearTokenCache(): void {
  cachedToken = null;
  cachedTokenExpiry = 0;
}

function isProd(): boolean {
  return process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
}

function tokenUrl(): string {
  return isProd()
    ? 'https://api.ebay.com/identity/v1/oauth2/token'
    : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
}

function basicAuth(): string {
  const appId = process.env.EBAY_APP_ID?.trim();
  const certId = process.env.EBAY_CERT_ID?.trim();
  if (!appId || !certId) {
    throw new Error('Missing required env vars: EBAY_APP_ID or EBAY_CERT_ID');
  }
  return Buffer.from(`${appId}:${certId}`).toString('base64');
}

/** Returns true when the token is an OAuth2 user token (v^1.1#...) */
export function isOAuthToken(token: string): boolean {
  return token.startsWith('v^');
}

/** Load the token row from Supabase, or null if not found / DB unavailable. */
async function getTokenRow(): Promise<{
  access_token: string;
  refresh_token: string;
  expires_at: string;
} | null> {
  try {
    const { data } = await supabaseAdmin
      .from('ebay_tokens')
      .select('access_token, refresh_token, expires_at')
      .eq('id', 'default')
      .single();
    return data ?? null;
  } catch {
    return null;
  }
}

/**
 * Refresh the access token using the given refresh token.
 * Writes the new access_token + expires_at back to Supabase on success.
 */
async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  console.log('[ebay-auth] Refreshing access token...');
  try {
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

    if (!res.ok) {
      const text = await res.text();
      console.error('[ebay-auth] Refresh failed:', res.status, text);
      return null;
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    console.log(`[ebay-auth] Token refreshed (expires in ${data.expires_in}s)`);

    // Update in-memory cache
    cachedToken = data.access_token;
    cachedTokenExpiry = Date.now() + (data.expires_in - 300) * 1000; // 5 min buffer

    // Persist updated access_token back to Supabase
    const expiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();
    await supabaseAdmin
      .from('ebay_tokens')
      .update({ access_token: data.access_token, expires_at: expiresAt, updated_at: new Date().toISOString() })
      .eq('id', 'default');

    return data.access_token;
  } catch (err) {
    console.error('[ebay-auth] Refresh error:', err);
    return null;
  }
}

/**
 * Returns a valid eBay auth token.
 * 1. Returns cached in-memory token if still valid
 * 2. Checks Supabase for a non-expired access_token
 * 3. Refreshes using refresh_token from Supabase, then EBAY_REFRESH_TOKEN env
 * 4. Falls back to EBAY_OAUTH_TOKEN from .env (may be expired)
 * 5. Throws EBAY_AUTH_REQUIRED if nothing is available
 */
export async function getValidToken(): Promise<string> {
  // 1. In-memory cache
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  // 2. Supabase row
  const row = await getTokenRow();
  if (row) {
    const expiresAt = new Date(row.expires_at).getTime();
    if (expiresAt > Date.now() + 60_000) {
      // Access token still valid — populate in-memory cache and return
      cachedToken = row.access_token;
      cachedTokenExpiry = expiresAt - 300_000;
      return row.access_token;
    }
    // Expired — try refreshing with the stored refresh token
    if (row.refresh_token) {
      const refreshed = await refreshAccessToken(row.refresh_token);
      if (refreshed) return refreshed;
    }
  }

  // 3. Env-var refresh token fallback
  const envRefresh = process.env.EBAY_REFRESH_TOKEN?.trim();
  if (envRefresh) {
    const refreshed = await refreshAccessToken(envRefresh);
    if (refreshed) return refreshed;
  }

  // 4. Last-resort static token from env (may be expired)
  const envToken = process.env.EBAY_OAUTH_TOKEN?.trim().replace(/^'|'$/g, '');
  if (envToken) {
    console.log('[ebay-auth] Using EBAY_OAUTH_TOKEN from .env (may be expired)');
    return envToken;
  }

  throw new Error('EBAY_AUTH_REQUIRED');
}

/**
 * Builds the Trading API headers.
 * OAuth2 tokens use X-EBAY-API-IAF-TOKEN header.
 */
export function getEbayApiHeaders(callName: string, token: string): Record<string, string> {
  const devId = process.env.EBAY_DEV_ID?.trim();
  const appId = process.env.EBAY_APP_ID?.trim();
  const certId = process.env.EBAY_CERT_ID?.trim();
  if (!devId || !appId || !certId) {
    const missing = ['EBAY_DEV_ID', 'EBAY_APP_ID', 'EBAY_CERT_ID'].filter(k => !process.env[k]?.trim()).join(', ');
    throw new Error(`Missing required eBay env vars: ${missing}`);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'text/xml',
    'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
    'X-EBAY-API-DEV-NAME': devId,
    'X-EBAY-API-APP-NAME': appId,
    'X-EBAY-API-CERT-NAME': certId,
    'X-EBAY-API-CALL-NAME': callName,
    'X-EBAY-API-SITEID': '0',
  };

  if (isOAuthToken(token)) {
    headers['X-EBAY-API-IAF-TOKEN'] = token;
  }

  return headers;
}

/** Returns the Trading API base URL for the current environment. */
export function getEbayApiUrl(): string {
  return isProd()
    ? 'https://api.ebay.com/ws/api.dll'
    : 'https://api.sandbox.ebay.com/ws/api.dll';
}
