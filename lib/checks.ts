import { consentNeeded, consentSignal, type ConsentSignal, type ConsentState } from './consent';
import { parseEvents, parseProducts } from './decoders/adobe-analytics';
import { NO_ITEM_ID } from './decoders/ga4';
import type { DecodedEvent, ParamRow } from './decoders/types';
import { relativeTime, type HitRow, type PageGroup } from './view';

export interface Issue {
  level: 'error' | 'warn' | 'info';
  message: string;
}

const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).length;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const allRows = (d: DecodedEvent): ParamRow[] => d.groups.flatMap((g) => g.rows);
const valueOf = (d: DecodedEvent, key: string) => allRows(d).find((r) => r.key === key)?.value;

// ---- PII ----

const EMAIL = /[A-Z0-9._%+-]+(?:@|%40)[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.([A-Z]{2,})/i;
/** `logo@2x.png` isn't an email address. */
const FILE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'js', 'css', 'json', 'html', 'htm', 'woff', 'woff2']);

export function looksLikeEmail(value: string): boolean {
  const m = value.match(EMAIL);
  return Boolean(m && !FILE_EXTENSIONS.has(m[1]!.toLowerCase()));
}

function piiIssues(d: DecodedEvent): Issue[] {
  const keys = [...new Set(allRows(d).filter((r) => looksLikeEmail(r.value)).map((r) => r.label ?? r.key))];
  return keys.length ? [{ level: 'error', message: `Looks like an email address in ${keys.join(', ')}` }] : [];
}

// ---- Adobe Analytics ----

/** Adobe truncates longer values without warning. Limits are in bytes, so accented characters count double. */
const AA_LIMITS: [RegExp, number][] = [
  [/^pageName$/, 100],
  [/^ch$/, 100],
  [/^server$/, 100],
  [/^pev2$/, 100],
  [/^c\d+$/, 100],
  [/^v\d+$/, 255],
  [/^h\d$/, 255],
  [/^purchaseID$/, 20],
  [/^(?:state|zip)$/, 50],
];
const NEEDS_PRODUCTS = ['prodView', 'scAdd', 'scRemove', 'scCheckout', 'purchase'];

function adobeAnalyticsIssues(d: DecodedEvent): Issue[] {
  const issues: Issue[] = [];
  for (const r of allRows(d)) {
    if (r.value.startsWith('D=')) continue;
    const limit = AA_LIMITS.find(([re]) => re.test(r.key))?.[1];
    const size = limit ? bytes(r.value) : 0;
    if (limit && size > limit) {
      issues.push({ level: 'warn', message: `${r.label ?? r.key} is ${size} bytes; Adobe keeps the first ${limit}` });
    }
  }
  const events = new Set(parseEvents(valueOf(d, 'events') ?? '').map((e) => e.name));
  const products = valueOf(d, 'products');
  if (products) {
    const missing = new Set<string>();
    for (const p of parseProducts(products)) {
      for (const pe of p.events.split('|').filter(Boolean)) {
        const name = pe.split('=')[0]!;
        if (!events.has(name)) missing.add(name);
      }
    }
    if (missing.size) {
      const names = [...missing].join(', ');
      issues.push({ level: 'warn', message: `${names} set in products but not in events, so Adobe ignores ${missing.size === 1 ? 'it' : 'them'}` });
    }
  }
  const needing = NEEDS_PRODUCTS.filter((e) => events.has(e));
  if (needing.length && !products) {
    issues.push({ level: 'warn', message: `${needing.join(', ')} without products, so no product gets credit` });
  }
  if (events.has('purchase') && !valueOf(d, 'purchaseID')) {
    issues.push({ level: 'warn', message: 'purchase without purchaseID: reloading the confirmation page can count the order twice' });
  }
  return issues;
}

// ---- GA4 ----

const GA4_ITEM_EVENTS = new Set([
  'add_payment_info',
  'add_shipping_info',
  'add_to_cart',
  'add_to_wishlist',
  'begin_checkout',
  'purchase',
  'remove_from_cart',
  'select_item',
  'view_cart',
  'view_item',
  'view_item_list',
]);
const RESERVED_PREFIX = /^(?:google_|ga_|firebase_)/;
/** Collection limits for standard properties (GA4 360 allows longer parameter values). */
const GA4_PAGE_LIMITS: Record<string, number> = { dl: 1000, dr: 420, dt: 300 };

function ga4Issues(d: DecodedEvent): Issue[] {
  const issues: Issue[] = [];
  const warn = (message: string) => issues.push({ level: 'warn', message });
  const rows = allRows(d);
  const name = d.eventName;
  if (name.length > 40) warn(`Event name is ${name.length} characters; GA4's limit is 40`);
  if (RESERVED_PREFIX.test(name)) warn(`Event names starting with google_, ga_ or firebase_ are reserved`);

  const params = rows.filter((r) => /^epn?\./.test(r.key));
  if (params.length > 25) warn(`${params.length} event parameters; GA4 keeps 25`);
  for (const r of params) {
    const param = r.key.replace(/^epn?\./, '');
    if (param.length > 40) warn(`Parameter ${param} has a ${param.length}-character name; GA4's limit is 40`);
    if (RESERVED_PREFIX.test(param)) warn(`Parameter ${param}: names starting with google_, ga_ or firebase_ are reserved`);
    if (r.value.length > 100) warn(`${param} is ${r.value.length} characters; GA4 keeps 100 (500 on GA4 360)`);
  }
  for (const r of rows.filter((r) => /^upn?\./.test(r.key))) {
    const prop = r.key.replace(/^upn?\./, '');
    if (prop.length > 24) warn(`User property ${prop} has a ${prop.length}-character name; GA4's limit is 24`);
    if (r.value.length > 36) warn(`User property ${prop} is ${r.value.length} characters; GA4 keeps 36`);
  }
  for (const [key, limit] of Object.entries(GA4_PAGE_LIMITS)) {
    const v = valueOf(d, key);
    if (v && v.length > limit) warn(`${rows.find((r) => r.key === key)?.label ?? key} is ${v.length} characters; GA4 keeps ${limit}`);
  }

  const items = rows.filter((r) => /^pr\d+$/.test(r.key));
  const hasValue = rows.some((r) => r.key === 'epn.value' || r.key === 'ep.value');
  if ((name === 'purchase' || name === 'refund') && !valueOf(d, 'ep.transaction_id')) warn(`${name} without transaction_id`);
  if (hasValue && !valueOf(d, 'cu')) warn('value without currency, so GA4 records no revenue');
  if (GA4_ITEM_EVENTS.has(name) && !items.length) warn('No items, so item reports stay empty for this event');
  for (const item of items) if (item.value === NO_ITEM_ID) warn(`${item.label} has neither item_id nor item_name`);
  return issues;
}

export function hitIssues(d: DecodedEvent): Issue[] {
  const vendorIssues = d.vendor === 'adobe-analytics' ? adobeAnalyticsIssues(d) : d.vendor === 'ga4' ? ga4Issues(d) : [];
  return [...piiIssues(d), ...vendorIssues];
}

// ---- Page-level: duplicates, ECID, consent ----

/** What makes two page views the same: account and page, per vendor. */
function pageViewKey(row: HitRow): string | undefined {
  const d = row.decoded;
  if (d.vendor === 'adobe-analytics' && d.eventName === 's.t') return `aa|${d.account}|${d.detail}`;
  if (d.vendor === 'ga4' && d.eventName === 'page_view') return `ga4|${d.account}|${valueOf(d, 'dl')}`;
  if (d.vendor === 'adobe-websdk' && d.eventName === 'web.webpagedetails.pageViews') return `websdk|${d.account}|${d.detail}`;
  return undefined;
}

function pageIssues(group: PageGroup, add: (key: string, issue: Issue) => void) {
  const { page, rows } = group;
  const at = (ts: number) => relativeTime(ts, page.ts);

  // Duplicate page views: the same page sent twice with no route change in between.
  let seen = new Map<string, HitRow>();
  for (const r of rows) {
    if (r.type === 'nav') seen = new Map();
    if (r.type !== 'hit') continue;
    const key = pageViewKey(r);
    if (!key) continue;
    const first = seen.get(key);
    if (first) add(r.key, { level: 'warn', message: `Duplicate page view: same page as the ${first.decoded.eventName} at ${at(first.ts)}` });
    else seen.set(key, r);
  }

  // Experience Cloud ID: if some AA hits on the page have it, the ones without were sent before the ID service was ready.
  const aa = rows.filter((r): r is HitRow => r.type === 'hit' && r.event.vendor === 'adobe-analytics');
  if (aa.some((r) => valueOf(r.decoded, 'mid'))) {
    for (const r of aa) {
      if (!valueOf(r.decoded, 'mid')) {
        add(r.key, { level: 'warn', message: 'No Experience Cloud ID (mid), unlike other hits on this page: the ID service wasn\'t ready yet' });
      }
    }
  }

  // Consent: hits sent while consent was denied, or before it was given.
  const signals: { ts: number; signal: ConsentSignal }[] = [];
  for (const r of rows) {
    const signal = consentSignal(r);
    if (signal) signals.push({ ts: r.ts, signal });
  }
  if (!signals.length) return;
  const firstGrant = (kind: 'analytics' | 'ads') => signals.find((s) => s.signal[kind] === 'granted');
  const state: Record<'analytics' | 'ads', { value?: ConsentState; by?: ConsentSignal; ts?: number }> = { analytics: {}, ads: {} };
  for (const r of rows) {
    const signal = consentSignal(r);
    if (signal) {
      for (const kind of ['analytics', 'ads'] as const) if (signal[kind]) state[kind] = { value: signal[kind], by: signal, ts: r.ts };
      continue;
    }
    if (r.type !== 'hit') continue;
    const kind = consentNeeded(r);
    if (!kind) continue;
    const label = kind === 'ads' ? 'advertising' : 'analytics';
    const now = state[kind];
    if (now.value === 'denied') {
      add(r.key, {
        level: 'warn',
        message: `Sent while ${label} consent was denied (${now.by!.by} at ${at(now.ts!)}: ${now.by!.summary})`,
      });
    } else if (!now.value) {
      const grant = firstGrant(kind);
      if (grant && grant.ts > r.ts) {
        add(r.key, { level: 'info', message: `Sent before ${label} consent was given (${grant.signal.by} at ${at(grant.ts)})` });
      }
    }
  }
}

/** Issues by row key, for every row on the tab. */
export function analyze(groups: PageGroup[]): Map<string, Issue[]> {
  const out = new Map<string, Issue[]>();
  const add = (key: string, issue: Issue) => {
    const list = out.get(key);
    if (list) list.push(issue);
    else out.set(key, [issue]);
  };
  for (const g of groups) {
    for (const r of g.rows) if (r.type === 'hit') for (const issue of cachedHitIssues(r.decoded)) add(r.key, issue);
    pageIssues(g, add);
  }
  return out;
}

const hitIssueCache = new WeakMap<DecodedEvent, Issue[]>();
function cachedHitIssues(d: DecodedEvent): Issue[] {
  let issues = hitIssueCache.get(d);
  if (!issues) hitIssueCache.set(d, (issues = hitIssues(d)));
  return issues;
}

export const worstLevel = (issues: Issue[]): Issue['level'] =>
  issues.some((i) => i.level === 'error') ? 'error' : issues.some((i) => i.level === 'warn') ? 'warn' : 'info';
