import { decodeRequest, decoderFor, type DecodedEvent, type VendorId } from './decoders';
import { withOptimizelyNames } from './decoders/optimizely';
import { isGtmInternal, parsePayload, SNAPSHOT_SOURCES } from './payload';
import { changedPaths } from './datalayer-state';
import type {
  DataLayerEvent,
  EnvEvent,
  EnvSource,
  HitEvent,
  InteractionEvent,
  NavEvent,
  PageRecord,
  RuleEvent,
  TabTimeline,
  TimelineEvent,
} from './types';
import { paramsOf, parseTerms, watchCells, watchSource, type Param, type QueryTerms, type WatchCell } from './watch';

export { parsePayload } from './payload';

export type Category = VendorId | 'datalayer' | 'gtm' | 'rule' | 'interaction' | 'nav';

export const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'adobe-analytics', label: 'AA' },
  { id: 'adobe-websdk', label: 'Web SDK' },
  { id: 'ga4', label: 'GA4' },
  { id: 'adobe-target', label: 'Target' },
  { id: 'optimizely', label: 'Optimizely' },
  { id: 'pixel', label: 'Pixels' },
  { id: 'datalayer', label: 'Data layer' },
  { id: 'gtm', label: 'GTM internals' },
  { id: 'rule', label: 'Tags rules' },
  { id: 'interaction', label: 'Clicks' },
  { id: 'nav', label: 'Navigation' },
];

/** Hidden until switched on: they bury the pushes that matter on GTM sites. */
export const HIDDEN_BY_DEFAULT: Category[] = ['gtm'];

export type Row =
  | { type: 'hit'; key: string; ts: number; event: HitEvent; decoded: DecodedEvent; index: number; of: number }
  /** `changed`: for snapshots (digitalData), the paths that differ from the previous snapshot. */
  | { type: 'datalayer'; key: string; ts: number; event: DataLayerEvent; changed?: string[] }
  | { type: 'interaction'; key: string; ts: number; event: InteractionEvent }
  | { type: 'nav'; key: string; ts: number; event: NavEvent }
  /** A Tags rule run: the trigger, and the completion or failure once it arrives. */
  | { type: 'rule'; key: string; ts: number; event: RuleEvent; outcome?: RuleEvent };

export type HitRow = Extract<Row, { type: 'hit' }>;

export interface TagsEnv {
  property?: string;
  propertyId?: string;
  environment?: string;
  buildDate?: string;
  turbineVersion?: string;
}
export interface GtmEnv {
  containers: { id: string; environment?: string; preview?: boolean }[];
}
export interface OptimizelyEnv {
  active: { experimentId: string; experiment?: string; campaign?: string; variationId?: string; variation?: string; holdback?: boolean }[];
  names: Record<string, string>;
}
export interface PageEnv {
  'adobe-tags'?: TagsEnv;
  gtm?: GtmEnv;
  optimizely?: OptimizelyEnv;
}

export interface PageGroup {
  page: PageRecord;
  rows: Row[];
  /** The latest snapshot of each library on the page. */
  env: PageEnv;
}

export const rowCategory = (row: Row): Category => {
  if (row.type === 'hit') return row.event.vendor;
  if (row.type === 'datalayer') return isGtmInternal(row.event) ? 'gtm' : 'datalayer';
  return row.type;
};

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
    case 'rule':
      return 'Rule';
  }
}

export function dataLayerTitle(e: DataLayerEvent, changed?: string[]): string {
  const p = parsePayload(e) as any;
  if (e.source === '_satellite.track') return `_satellite.track("${p?.identifier}")`;
  if (e.source.endsWith('()')) return `${e.source.slice(0, -2)}("${p?.command}")`;
  // The badge already names the snapshot's source.
  if (SNAPSHOT_SOURCES.has(e.source)) {
    if (!changed) return 'first value';
    return changed.length ? `${changed.join(', ')} changed` : 'no change';
  }
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

/** `core/src/lib/conditions/path.js` -> `core: path`. */
export function componentName(modulePath: string | undefined): string {
  if (!modulePath) return 'unknown';
  const [extension, ...rest] = modulePath.split('/');
  const name = (rest.pop() ?? modulePath).replace(/\.js$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return `${extension}: ${name}`;
}

/** How a rule run ended, for its row: `fired`, `condition not met: core: path`, or `running`. */
export function ruleOutcome(row: Extract<Row, { type: 'rule' }>): { label: string; tone: 'ok' | 'failed' | 'error' | 'pending' } {
  const end = row.outcome ?? (row.event.phase === 'triggered' ? undefined : row.event);
  if (!end) return { label: 'running', tone: 'pending' };
  if (end.phase === 'completed') return { label: 'fired', tone: 'ok' };
  const what = `${end.negate ? 'not ' : ''}${componentName(end.component)}`;
  if (end.phase === 'condition-failed') return { label: `condition not met: ${what}`, tone: 'failed' };
  return { label: `action failed: ${what}`, tone: 'error' };
}

// ---- Building rows ----
// Events in chunks that didn't change keep their identity between storage reads, so rows are cached
// by event: unchanged rows are the same objects, and memoized row components skip re-rendering.

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

const hitRowCache = new WeakMap<HitEvent, { names?: object; rows: HitRow[] }>();
function hitRows(event: HitEvent, names: Record<string, string> | undefined): HitRow[] {
  const relevantNames = event.vendor === 'optimizely' ? names : undefined;
  const cached = hitRowCache.get(event);
  if (cached && cached.names === relevantNames) return cached.rows;
  const decoded = decodeHit(event).map((d) => (relevantNames ? withOptimizelyNames(d, relevantNames) : d));
  const rows = decoded.map((d, index): HitRow => ({
    type: 'hit',
    key: `${event.id}:${index}`,
    ts: event.ts,
    event,
    decoded: d,
    index,
    of: decoded.length,
  }));
  hitRowCache.set(event, { names: relevantNames, rows });
  return rows;
}

const ruleRowCache = new WeakMap<RuleEvent, Extract<Row, { type: 'rule' }>>();
function ruleRow(event: RuleEvent, outcome: RuleEvent | undefined): Row {
  const cached = ruleRowCache.get(event);
  if (cached && cached.outcome === outcome) return cached;
  const row = { type: 'rule' as const, key: event.id, ts: event.ts, event, outcome };
  ruleRowCache.set(event, row);
  return row;
}

const rowCache = new WeakMap<TimelineEvent, Row>();
function simpleRow(event: DataLayerEvent | InteractionEvent | NavEvent): Row {
  let row = rowCache.get(event);
  if (!row) {
    row = { type: event.kind, key: event.id, ts: event.ts, event } as Row;
    rowCache.set(event, row);
  }
  return row;
}

function snapshotRow(event: DataLayerEvent, previous: DataLayerEvent | undefined): Row {
  let row = rowCache.get(event);
  if (!row) {
    const changed = previous ? changedPaths(parsePayload(previous), parsePayload(event)) : undefined;
    row = { type: 'datalayer', key: event.id, ts: event.ts, event, changed };
    rowCache.set(event, row);
  }
  return row;
}

/** Optimizely's ID -> name map, from every snapshot on the tab (the names belong to the project, not the page). */
let namesCache: { key: string; names: Record<string, string> } | undefined;
function optimizelyNames(t: TabTimeline): Record<string, string> | undefined {
  const snapshots = t.events.filter((e): e is EnvEvent => e.kind === 'env' && e.source === 'optimizely');
  if (!snapshots.length) return undefined;
  const key = snapshots.map((e) => e.id).join();
  if (namesCache?.key !== key) {
    const names: Record<string, string> = {};
    for (const e of snapshots) Object.assign(names, (parsePayload(e) as OptimizelyEnv | null)?.names);
    namesCache = { key, names };
  }
  return namesCache.names;
}

export function buildGroups(t: TabTimeline): PageGroup[] {
  const groups = new Map<string, PageGroup>(t.pages.map((page) => [page.id, { page, rows: [], env: {} }]));
  const runKey = (e: RuleEvent) => `${e.pageId}|${e.run}`;
  const outcomes = new Map<string, RuleEvent>();
  const triggered = new Set<string>();
  for (const e of t.events) {
    if (e.kind !== 'rule') continue;
    if (e.phase === 'triggered') triggered.add(runKey(e));
    else outcomes.set(runKey(e), e);
  }
  const names = optimizelyNames(t);
  const lastSnapshot = new Map<string, DataLayerEvent>();

  for (const event of t.events) {
    const g = groups.get(event.pageId);
    if (!g) continue;
    switch (event.kind) {
      case 'hit':
        g.rows.push(...hitRows(event, names));
        break;
      case 'env':
        (g.env as Record<EnvSource, unknown>)[event.source] = parsePayload(event);
        break;
      case 'rule':
        // An outcome joins its trigger's row; one whose trigger wasn't seen gets its own.
        if (event.phase === 'triggered') g.rows.push(ruleRow(event, outcomes.get(runKey(event))));
        else if (!triggered.has(runKey(event))) g.rows.push(ruleRow(event, undefined));
        break;
      case 'datalayer':
        if (SNAPSHOT_SOURCES.has(event.source)) {
          const key = `${event.pageId}|${event.source}`;
          g.rows.push(snapshotRow(event, lastSnapshot.get(key)));
          lastSnapshot.set(key, event);
        } else {
          g.rows.push(simpleRow(event));
        }
        break;
      default:
        g.rows.push(simpleRow(event));
    }
  }
  return [...groups.values()];
}

const searchCache = new WeakMap<object, string>();
export function searchText(row: Row): string {
  const cacheKey = row.type === 'hit' ? row.decoded : row.type === 'rule' ? row : row.event;
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
    } else if (row.type === 'rule') {
      const end = row.outcome ?? row.event;
      text = [row.event.ruleName, ruleOutcome(row).label, end.component, end.settings].join('\n');
    } else {
      text = row.event.url;
    }
    text = text.toLowerCase();
    searchCache.set(cacheKey, text);
  }
  return text;
}

export const rowParams = (row: Row): Param[] => paramsOf(row, (r) => parsePayload(r.event));

export interface FilterResult {
  groups: PageGroup[];
  terms: QueryTerms;
  /** Watched values per row key, for hits and data layer pushes that carry a watched variable. */
  watch: Map<string, WatchCell[]>;
}

/** Rows kept between watched values for context: what the user did, and the rules that fired because of it. */
function isContext(r: Row): boolean {
  if (r.type === 'interaction' || r.type === 'nav') return true;
  return r.type === 'rule' && ruleOutcome(r).tone === 'ok';
}

/**
 * Apply the type chips and the search bar. Text terms keep rows that match any of them. Watch terms
 * keep hits and data layer pushes that carry at least one watched variable, while clicks, navigation
 * and fired rules stay as context unless text terms are also given.
 */
export function filterGroups(groups: PageGroup[], enabled: Set<Category>, query: string): FilterResult {
  const terms = parseTerms(query, groups, rowParams);
  const watch = new Map<string, WatchCell[]>();
  const lastValues = new Map<string, string>();
  const latest = groups[groups.length - 1];

  const keep = (r: Row): boolean => {
    if (!enabled.has(rowCategory(r))) return false;
    if (terms.text.length && !terms.text.some((t) => searchText(r).includes(t))) return false;
    if (!terms.watch.length) return true;
    if (r.type !== 'hit' && r.type !== 'datalayer') return terms.text.length === 0 && isContext(r);
    const cells = watchCells(rowParams(r), terms.watch, watchSource(r), lastValues);
    if (!cells.some((c) => c.matches.length)) return false;
    watch.set(r.key, cells);
    return true;
  };

  return {
    groups: groups
      .map((g) => ({ ...g, rows: g.rows.filter(keep) }))
      .filter((g) => g.rows.length > 0 || g.page === latest?.page),
    terms,
    watch,
  };
}

/** The hit of the same vendor and event before this one on the tab (or of the same vendor, failing that). */
export function previousHit(groups: PageGroup[], row: HitRow): { row: HitRow; page: PageRecord } | undefined {
  let sameVendor: { row: HitRow; page: PageRecord } | undefined;
  let found = false;
  for (let gi = groups.length - 1; gi >= 0; gi--) {
    const g = groups[gi]!;
    for (let ri = g.rows.length - 1; ri >= 0; ri--) {
      const r = g.rows[ri]!;
      if (!found) {
        found = r.key === row.key;
        continue;
      }
      if (r.type !== 'hit' || r.event.vendor !== row.event.vendor) continue;
      if (r.decoded.eventName === row.decoded.eventName) return { row: r, page: g.page };
      sameVendor ??= { row: r, page: g.page };
    }
  }
  return sameVendor;
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
