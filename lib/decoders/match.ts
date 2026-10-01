import type { VendorId } from './types';

/** Marketing pixels: recognized and named, but only lightly decoded. */
export type PixelPlatform = 'meta' | 'google-ads' | 'floodlight' | 'tiktok' | 'linkedin' | 'pinterest' | 'bing' | 'x';

export function pixelPlatform(url: URL): PixelPlatform | undefined {
  const host = url.hostname;
  const path = url.pathname;
  if (/(^|\.)facebook\.com$/.test(host) && /^\/tr\/?$/.test(path)) return 'meta';
  if (/\/pagead\/(?:viewthroughconversion|conversion|1p-conversion|1p-user-list)\/\d+/.test(path) && /google|doubleclick/.test(host)) {
    return 'google-ads';
  }
  if (/(^|\.)(?:fls|ad)\.doubleclick\.net$/.test(host) && /^\/activityi?[;/]/.test(path)) return 'floodlight';
  if (host === 'analytics.tiktok.com' && path.startsWith('/api/v2/pixel')) return 'tiktok';
  if (host === 'px.ads.linkedin.com' && /^\/(?:collect|wa)\b/.test(path)) return 'linkedin';
  if (host === 'ct.pinterest.com' && /^\/(?:v3|user)\/?$/.test(path)) return 'pinterest';
  if (host === 'bat.bing.com' && path.startsWith('/action/')) return 'bing';
  if ((host === 'analytics.twitter.com' || host === 't.co') && path.startsWith('/i/adsct')) return 'x';
  return undefined;
}

/**
 * URL matching lives apart from decoding: the background worker bundles only this file, so changing
 * how a hit is decoded is a panel-only update that doesn't reload the extension.
 */
export const matchers: Record<VendorId, (url: URL) => boolean> = {
  'adobe-analytics': (url) => /\/b\/ss\//.test(url.pathname),

  // /ee/v1/interact, /ee/irl1/v1/collect, /ee/v1/privacy/set-consent, and the same paths on first-party edge domains
  'adobe-websdk': (url) => /\/ee\/(?:[\w-]+\/)?v\d+\/(?:interact|collect|privacy\/set-consent)$/.test(url.pathname),

  ga4: (url) => {
    // stats.g.doubleclick.net carries a copy of the hit for Google signals; skip it to avoid duplicates.
    if (url.hostname.endsWith('doubleclick.net')) return false;
    if (/\/g\/collect$/.test(url.pathname)) return true;
    // Server-side GTM endpoints on custom paths still carry v=2 and a G- measurement ID.
    return url.searchParams.get('v') === '2' && /^G-[A-Z0-9]+$/i.test(url.searchParams.get('tid') ?? '');
  },

  // at.js 2 delivery API, and at.js 1 mbox requests
  'adobe-target': (url) =>
    (/\/rest\/v1\/delivery$/.test(url.pathname) && url.searchParams.has('client')) ||
    /\/m2\/[^/]+\/mbox\/(?:json|ajax|standard)$/.test(url.pathname),

  optimizely: (url) => url.hostname === 'logx.optimizely.com' && /^\/v1\/events\/?$/.test(url.pathname),

  pixel: (url) => pixelPlatform(url) !== undefined,
};

const vendors = Object.keys(matchers) as VendorId[];

export function matchVendor(rawUrl: string): VendorId | undefined {
  if (!rawUrl.startsWith('http')) return undefined;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  return vendors.find((v) => matchers[v](url));
}
