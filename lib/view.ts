import { decodeRequest, decoderFor, type DecodedEvent, type VendorId } from './decoders';
import type { DataLayerEvent, HitEvent, InteractionEvent, NavEvent, PageRecord, TabTimeline } from './types';

export type Category = VendorId | 'datalayer' | 'interaction' | 'nav';

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'adobe-analytics', label: 'AA' },
  { id: 'adobe-websdk', label: 'Web SDK' },
  { id: 'ga4', label: 'GA4' },
  { id: 'datalayer', label: 'Data layer' },
  { id: 'interaction', label: 'Clicks' },
  { id: 'nav', label: 'Navigation' },
];

export type Row =
  | { type: 'hit'; key: string; ts: number; event: HitEvent; decoded: DecodedEvent; index: number; of: number }
  | { type: 'datalayer'; key: string; ts: number; event: DataLayerEvent }
  | { type: 'interaction'; key: string; ts: number; event: InteractionEvent }
  | { type: 'nav'; key: string; ts: number; event: NavEvent };

export interface PageGroup {
  page: PageRecord;
  rows: Row[];
}

export const rowCategory = (row: Row): Category => (row.type === 'hit' ? row.event.vendor : row.type);

const SOURCE_BADGES: Record<string, string> = {
  dataLayer: 'DL',
  adobeDataLayer: 'ACDL',
  '_satellite.track': 'Tags',
};

export function badgeFor(row: Row): string {
  switch (row.type) {
    case 'hit':
      return decoderFor(row.event.vendor).short;
    case 'datalayer':
      return SOURCE_BADGES[row.event.source] ?? row.event.source.replace(/\(\)$/, '');
    case 'interaction':
      return row.event.action === 'submit' ? 'Submit' : 'Click';
    case 'nav':
      return 'Nav';
  }
}

const payloadCache = new Map<string, unknown>();
export function parsePayload(e: DataLayerEvent): unknown {
  if (payloadCache.has(e.id)) return payloadCache.get(e.id);
  let value: unknown;
  try {
    value = JSON.parse(e.payload);
  } catch {
    value = e.payload;
  }
  if (payloadCache.size > 5000) payloadCache.clear();
  payloadCache.set(e.id, value);
  return value;
}

export function dataLayerTitle(e: DataLayerEvent): string {
  const p = parsePayload(e) as any;
  if (e.source === '_satellite.track') return `_satellite.track("${p?.identifier}")`;
  if (e.source.endsWith('()')) return `${e.source.slice(0, -2)}("${p?.command}")`;
  if (Array.isArray(p)) {
    // gtag() pushes its arguments object: ['event', 'add_to_cart', {...}]
    const [cmd, arg] = p;
    return `gtag("${cmd}"${typeof arg === 'string' ? `, "${arg}"` : ''})`;
  }
  if (p && typeof p === 'object') {
    if (typeof p.event === 'string') return `event: ${p.event}`;
    const keys = Object.keys(p);
    return keys.length ? `{ ${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''} }` : '{}';
  }
  return String(p);
}

/** Decoding is pure, so cache by event id + url (the url changes on a redirect). */
const decodeCache = new Map<string, DecodedEvent[]>();
function decodeHit(hit: HitEvent): DecodedEvent[] {
  const key = `${hit.id}|${hit.url}`;
  let decoded = decodeCache.get(key);
  if (!decoded) {
    decoded = decodeRequest(hit.vendor, hit);
    if (decodeCache.size > 5000) decodeCache.clear();
    decodeCache.set(key, decoded);
  }
  return decoded;
}

export function buildGroups(t: TabTimeline): PageGroup[] {
  const groups = new Map<string, PageGroup>(t.pages.map((page) => [page.id, { page, rows: [] }]));
  for (const event of t.events) {
    const g = groups.get(event.pageId);
    if (!g) continue;
    if (event.kind === 'hit') {
      const decoded = decodeHit(event);
      decoded.forEach((d, index) =>
        g.rows.push({ type: 'hit', key: `${event.id}:${index}`, ts: event.ts, event, decoded: d, index, of: decoded.length }),
      );
    } else if (event.kind === 'datalayer') {
      g.rows.push({ type: 'datalayer', key: event.id, ts: event.ts, event });
    } else if (event.kind === 'interaction') {
      g.rows.push({ type: 'interaction', key: event.id, ts: event.ts, event });
    } else {
      g.rows.push({ type: 'nav', key: event.id, ts: event.ts, event });
    }
  }
  return [...groups.values()];
}

const searchCache = new WeakMap<object, string>();
export function searchText(row: Row): string {
  const cacheKey = row.type === 'hit' ? row.decoded : row.event;
  let text = searchCache.get(cacheKey);
  if (text === undefined) {
    if (row.type === 'hit') {
      const d = row.decoded;
      text = [
        d.eventName,
        d.detail,
        d.account,
        ...d.summary,
        ...d.groups.flatMap((g) => g.rows.flatMap((r) => [r.key, r.label, r.value, r.note])),
      ].join('\n');
    } else if (row.type === 'datalayer') {
      text = `${row.event.source}\n${row.event.payload}`;
    } else if (row.type === 'interaction') {
      text = [row.event.text, row.event.selector, row.event.href, JSON.stringify(row.event.dataAttrs ?? {})].join('\n');
    } else {
      text = row.event.url;
    }
    text = text.toLowerCase();
    searchCache.set(cacheKey, text);
  }
  return text;
}

export function filterGroups(groups: PageGroup[], enabled: Set<Category>, query: string): PageGroup[] {
  const q = query.trim().toLowerCase();
  const latest = groups[groups.length - 1];
  return groups
    .map((g) => ({
      page: g.page,
      rows: g.rows.filter((r) => enabled.has(rowCategory(r)) && (!q || searchText(r).includes(q))),
    }))
    .filter((g) => g.rows.length > 0 || g.page === latest?.page);
}

export function relativeTime(ts: number, pageTs: number): string {
  const s = (ts - pageTs) / 1000;
  // Page-side clocks can read a hair before the navigation timestamp; don't show that as -0.00s.
  if (s <= -0.005) return `${s.toFixed(2)}s`;
  return s < 100 ? `+${Math.max(0, s).toFixed(2)}s` : `+${Math.round(s)}s`;
}

export function clockTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function hitStatus(hit: HitEvent): { label: string; tone: 'ok' | 'error' | 'pending' } {
  if (hit.error) {
    const blocked = /BLOCKED_BY_CLIENT/.test(hit.error);
    return { label: blocked ? 'blocked by an extension' : hit.error.replace(/^net::/, ''), tone: 'error' };
  }
  if (hit.status === undefined) return { label: 'pending', tone: 'pending' };
  return { label: String(hit.status), tone: hit.status >= 400 ? 'error' : 'ok' };
}
