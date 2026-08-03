import 'server-only';

/**
 * App-level (client_credentials) eBay OAuth token — separate from the
 * user token in ebay-auth.ts. Required for Notification API calls
 * (createDestination/createSubscription/getPublicKey), which are
 * application-scoped, not tied to the seller's user token.
 */

let cachedToken: string | null = null;
let cachedExpiry = 0;

function isProd(): boolean {
  return process.env.EBAY_ENVIRONMENT?.trim() === 'PRODUCTION';
}

function tokenUrl(): string {
  return isProd()
    ? 'https://api.ebay.com/identity/v1/oauth2/token'
    : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
}

export function ebayApiRoot(): string {
  return isProd() ? 'https://api.ebay.com' : 'https://api.sandbox.ebay.com';
}

export async function getAppAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;

  const appId = process.env.EBAY_APP_ID?.trim();
  const certId = process.env.EBAY_CERT_ID?.trim();
  if (!appId || !certId) {
    throw new Error('Missing required eBay env vars: EBAY_APP_ID or EBAY_CERT_ID');
  }

  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${appId}:${certId}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://api.ebay.com/oauth/api_scope',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay app token request failed: ${res.status} ${text}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = data.access_token;
  cachedExpiry = Date.now() + (data.expires_in - 300) * 1000;
  return cachedToken;
}
