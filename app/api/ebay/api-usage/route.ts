import { NextRequest, NextResponse } from 'next/server';
import { getValidToken, isOAuthToken, getEbayApiHeaders, getEbayApiUrl, clearTokenCache } from '@/app/lib/ebay-auth';

function decodeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function buildGetApiAccessRulesRequest(token: string): string {
  const credentials = isOAuthToken(token)
    ? ''
    : `<RequesterCredentials><eBayAuthToken>${token}</eBayAuthToken></RequesterCredentials>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<GetApiAccessRulesRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${credentials}
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
</GetApiAccessRulesRequest>`;
}

interface ApiAccessRule {
  callName: string;
  dailyUsage: number;
  dailyHardLimit: number;
  hourlyUsage?: number;
  hourlyHardLimit?: number;
  ruleCurrentStatus: string;
}

function parseApiAccessRules(xml: string): ApiAccessRule[] {
  const rules: ApiAccessRule[] = [];
  const ruleRegex = /<ApiAccessRule>([\s\S]*?)<\/ApiAccessRule>/g;
  let m;
  while ((m = ruleRegex.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag: string) => block.match(new RegExp(`<${tag}>(.*?)</${tag}>`))?.[1];
    rules.push({
      callName: decodeXml(get('CallName') || ''),
      dailyUsage: parseInt(get('DailyUsage') || '0', 10),
      dailyHardLimit: parseInt(get('DailyHardLimit') || '0', 10),
      hourlyUsage: get('HourlyUsage') !== undefined ? parseInt(get('HourlyUsage') as string, 10) : undefined,
      hourlyHardLimit: get('HourlyHardLimit') !== undefined ? parseInt(get('HourlyHardLimit') as string, 10) : undefined,
      ruleCurrentStatus: get('RuleCurrentStatus') || '',
    });
  }
  return rules;
}

/** eBay's Trading API daily call limit resets at midnight Pacific time. */
function getPacificOffsetMinutes(date: Date): number {
  const utc = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  const pt = new Date(date.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return (utc.getTime() - pt.getTime()) / 60000;
}

function nextPacificMidnightUTC(now: Date): Date {
  const offsetMinutes = getPacificOffsetMinutes(now);
  const ptNow = new Date(now.getTime() - offsetMinutes * 60000);
  const ptNextMidnight = new Date(Date.UTC(ptNow.getUTCFullYear(), ptNow.getUTCMonth(), ptNow.getUTCDate() + 1, 0, 0, 0));
  return new Date(ptNextMidnight.getTime() + offsetMinutes * 60000);
}

// GET — diagnostic call only; eBay docs say not to poll this regularly.
export async function GET(_request: NextRequest) {
  try {
    const token = await getValidToken();
    const xml = buildGetApiAccessRulesRequest(token);
    const response = await fetch(getEbayApiUrl(), {
      method: 'POST',
      headers: getEbayApiHeaders('GetApiAccessRules', token),
      body: xml,
    });
    const text = await response.text();

    const ack = text.match(/<Ack>(.*?)<\/Ack>/)?.[1];
    if (ack === 'Failure') {
      const errorMsg = text.match(/<LongMessage>(.*?)<\/LongMessage>/)?.[1]
        || text.match(/<ShortMessage>(.*?)<\/ShortMessage>/)?.[1]
        || 'eBay API error';
      return NextResponse.json({ error: decodeXml(errorMsg) }, { status: 500 });
    }

    const rules = parseApiAccessRules(text);
    const aggregate = rules.find((r) => r.callName === 'ApplicationAggregate') || null;
    const resetsAt = nextPacificMidnightUTC(new Date()).toISOString();

    return NextResponse.json({
      resetsAt,
      aggregate: aggregate && {
        used: aggregate.dailyUsage,
        limit: aggregate.dailyHardLimit,
        percent: aggregate.dailyHardLimit > 0
          ? Math.round((aggregate.dailyUsage / aggregate.dailyHardLimit) * 1000) / 10
          : 0,
        status: aggregate.ruleCurrentStatus,
      },
      // Individual call rules (e.g. GetSellerList, GetItem) beyond the app-wide aggregate
      rules: rules
        .filter((r) => r.callName !== 'ApplicationAggregate')
        .map((r) => ({
          callName: r.callName,
          used: r.dailyUsage,
          limit: r.dailyHardLimit,
          percent: r.dailyHardLimit > 0 ? Math.round((r.dailyUsage / r.dailyHardLimit) * 1000) / 10 : 0,
          status: r.ruleCurrentStatus,
        })),
    });
  } catch (err: any) {
    if (err.message === 'EBAY_AUTH_REQUIRED') {
      clearTokenCache();
      return NextResponse.json({ error: 'EBAY_AUTH_REQUIRED' }, { status: 401 });
    }
    return NextResponse.json({ error: err.message || 'Failed to fetch API usage' }, { status: 500 });
  }
}
