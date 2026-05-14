/**
 * eBay Auth — simplified with auto-refresh.
 *
 * Uses EBAY_OAUTH_TOKEN from .env as initial token.
 * When expired, automatically refreshes using EBAY_REFRESH_TOKEN.
 * OAuth2 tokens are passed via the X-EBAY-API-IAF-TOKEN header.
 */

const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.marketing',
].join(' ');

/** In-memory cache so we don't refresh on every single API call */
let cachedToken: string | null = null;
let cachedTokenExpiry: number = 0;

function isProd(): boolean {
  return process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
}

function tokenUrl(): string {
  return isProd()
    ? 'https://api.ebay.com/identity/v1/oauth2/token'
    : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
}

function basicAuth(): string {
  return Buffer.from(
    `${process.env.EBAY_APP_ID!.trim()}:${process.env.EBAY_CERT_ID!.trim()}`
  ).toString('base64');
}

/** Returns true when the token is an OAuth2 user token (v^1.1#...) */
export function isOAuthToken(token: string): boolean {
  return token.startsWith('v^');
}

/**
 * Refresh the access token using the refresh token.
 * Returns a fresh access token or null on failure.
 */
async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = process.env.EBAY_REFRESH_TOKEN?.trim();
  if (!refreshToken) {
    console.error('[ebay-auth] No EBAY_REFRESH_TOKEN set — cannot auto-refresh.');
    return null;
  }

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
    console.log(`[ebay-auth] Token refreshed successfully (expires in ${data.expires_in}s)`);

    // Cache in memory
    cachedToken = data.access_token;
    cachedTokenExpiry = Date.now() + (data.expires_in - 300) * 1000; // 5 min buffer

    return data.access_token;
  } catch (err) {
    console.error('[ebay-auth] Refresh error:', err);
    return null;
  }
}

/**
 * Returns a valid eBay auth token.
 * 1. Returns cached in-memory token if still valid
 * 2. Tries to refresh using EBAY_REFRESH_TOKEN
 * 3. Falls back to EBAY_OAUTH_TOKEN from .env
 * 4. Throws EBAY_AUTH_REQUIRED if nothing available
 */
export async function getValidToken(): Promise<string> {
  // 1. Check in-memory cache
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  // 2. Try refresh
  const refreshed = await refreshAccessToken();
  if (refreshed) return refreshed;

  // 3. Fall back to env token (may be expired but worth trying)
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
  const headers: Record<string, string> = {
    'Content-Type': 'text/xml',
    'X-EBAY-API-COMPATIBILITY-LEVEL': '1349',
    'X-EBAY-API-DEV-NAME': process.env.EBAY_DEV_ID!.trim(),
    'X-EBAY-API-APP-NAME': process.env.EBAY_APP_ID!.trim(),
    'X-EBAY-API-CERT-NAME': process.env.EBAY_CERT_ID!.trim(),
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
