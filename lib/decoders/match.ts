import type { VendorId } from './types';

/**
 * URL matching lives apart from decoding: the background worker bundles only this file, so changing
 * how a hit is decoded is a panel-only update that doesn't reload the extension.
 */
export const matchers: Record<VendorId, (url: URL) => boolean> = {
  'adobe-analytics': (url) => /\/b\/ss\//.test(url.pathname),

  // /ee/v1/interact, /ee/irl1/v1/collect, and the same paths on first-party edge domains
  'adobe-websdk': (url) => /\/ee\/(?:[\w-]+\/)?v\d+\/(?:interact|collect)$/.test(url.pathname),

  ga4: (url) => {
    // stats.g.doubleclick.net carries a copy of the hit for Google signals; skip it to avoid duplicates.
    if (url.hostname.endsWith('doubleclick.net')) return false;
    if (/\/g\/collect$/.test(url.pathname)) return true;
    // Server-side GTM endpoints on custom paths still carry v=2 and a G- measurement ID.
    return url.searchParams.get('v') === '2' && /^G-[A-Z0-9]+$/i.test(url.searchParams.get('tid') ?? '');
  },
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
