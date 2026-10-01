import { pixelPlatform, type PixelPlatform } from './match';
import type { CapturedRequest, DecodedEvent, Decoder } from './types';
import { flatten, group, parseQuery, queryOf } from './util';

type Params = Map<string, string>;

interface Platform {
  name: string;
  accountLabel: string;
  account(p: Params, url: URL): string | undefined;
  event(p: Params, url: URL): string | undefined;
}

const PLATFORMS: Record<PixelPlatform, Platform> = {
  meta: { name: 'Meta Pixel', accountLabel: 'Pixel ID', account: (p) => p.get('id'), event: (p) => p.get('ev') },
  'google-ads': {
    name: 'Google Ads',
    accountLabel: 'Conversion ID',
    account: (_, url) => {
      const id = url.pathname.match(/\/(\d+)\/?/)?.[1];
      return id ? `AW-${id}` : undefined;
    },
    event: (p, url) =>
      url.pathname.includes('1p-user-list') ? 'remarketing' : p.get('label') ? `conversion ${p.get('label')}` : 'conversion',
  },
  floodlight: {
    name: 'Floodlight',
    accountLabel: 'Advertiser',
    account: (p) => (p.get('src') ? `DC-${p.get('src')}` : undefined),
    event: (p) => [p.get('type'), p.get('cat')].filter(Boolean).join('/') || undefined,
  },
  tiktok: {
    name: 'TikTok Pixel',
    accountLabel: 'Pixel code',
    account: (p) => p.get('context.pixel.code') ?? p.get('sdkid'),
    event: (p) => p.get('event'),
  },
  linkedin: {
    name: 'LinkedIn Insight',
    accountLabel: 'Partner ID',
    account: (p) => p.get('pid'),
    event: (p) => (p.get('conversionId') ? `conversion ${p.get('conversionId')}` : 'page view'),
  },
  pinterest: { name: 'Pinterest Tag', accountLabel: 'Tag ID', account: (p) => p.get('tid'), event: (p) => p.get('event') },
  bing: {
    name: 'Microsoft UET',
    accountLabel: 'Tag ID',
    account: (p) => p.get('ti'),
    event: (p) => p.get('ea') ?? p.get('evt'),
  },
  x: { name: 'X Pixel', accountLabel: 'Pixel ID', account: (p) => p.get('txn_id'), event: (p) => p.get('events') ?? 'page view' },
};

function paramsOf(req: CapturedRequest, url: URL): [string, string][] {
  const out = parseQuery(queryOf(req.url));
  // Floodlight puts its parameters in the path: /activityi;src=123;type=abc;cat=def
  out.push(...parseQuery(url.pathname.split(';').slice(1).join('&')));
  if (req.body) {
    try {
      out.push(...flatten(JSON.parse(req.body)));
    } catch {
      out.push(...parseQuery(req.body));
    }
  }
  return out;
}

function decode(req: CapturedRequest): DecodedEvent[] {
  const url = new URL(req.url);
  const platform = pixelPlatform(url);
  const params = paramsOf(req, url);
  const map: Params = new Map(params);
  const p = platform ? PLATFORMS[platform] : undefined;
  return [
    {
      vendor: 'pixel',
      eventName: p?.event(map, url) ?? '(no event name)',
      detail: p?.name,
      account: p?.account(map, url),
      accountLabel: p?.accountLabel,
      summary: [],
      groups: [
        ...group('Parameters', params.map(([key, value]) => ({ key, value }))),
        ...group('Request', [{ key: 'endpoint', label: 'Endpoint', value: `${url.host}${url.pathname.split(';')[0]}` }]),
      ],
    },
  ];
}

export const pixels: Decoder = {
  id: 'pixel',
  label: 'Marketing pixels',
  short: 'Pixel',
  decode,
};
