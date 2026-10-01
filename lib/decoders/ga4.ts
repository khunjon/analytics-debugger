import type { CapturedRequest, DecodedEvent, Decoder, ParamRow } from './types';
import { group, parseQuery, queryOf, truncate } from './util';

const LABELS: Record<string, string> = {
  v: 'Protocol version',
  tid: 'Measurement ID',
  gtm: 'Container hash',
  _p: 'Page load ID',
  cid: 'Client ID',
  uid: 'User ID',
  sid: 'Session ID',
  sct: 'Session count',
  seg: 'Session engaged',
  _fv: 'First visit',
  _ss: 'Session start',
  _nsi: 'New session',
  dl: 'Page location',
  dr: 'Page referrer',
  dt: 'Page title',
  en: 'Event name',
  _et: 'Engagement time (ms)',
  _c: 'Conversion',
  _ee: 'Enhanced conversions',
  _s: 'Hit sequence',
  _dbg: 'Debug mode',
  cu: 'Currency',
  gcs: 'Consent state',
  gcd: 'Consent defaults',
  dma: 'DMA',
  dma_cps: 'DMA consent purposes',
  npa: 'Non-personalized ads',
  ul: 'Language',
  sr: 'Screen resolution',
  tag_exp: 'Tag experiments',
  frm: 'In iframe',
};

const ITEM_FIELDS: Record<string, string> = {
  id: 'item_id',
  nm: 'item_name',
  af: 'affiliation',
  cp: 'coupon',
  ds: 'discount',
  lp: 'index',
  br: 'item_brand',
  ca: 'item_category',
  c2: 'item_category2',
  c3: 'item_category3',
  c4: 'item_category4',
  c5: 'item_category5',
  li: 'item_list_id',
  ln: 'item_list_name',
  va: 'item_variant',
  lo: 'location_id',
  pr: 'price',
  qt: 'quantity',
  pi: 'promotion_id',
  pn: 'promotion_name',
  cn: 'creative_name',
  cs: 'creative_slot',
};

const EVENT_META = new Set(['en', '_et', '_c', '_ee', '_s', '_dbg']);
const PAGE = new Set(['dl', 'dr', 'dt']);
const SESSION = new Set(['cid', 'uid', 'sid', 'sct', 'seg', '_fv', '_ss', '_nsi']);
const CONSENT = new Set(['gcs', 'gcd', 'dma', 'dma_cps', 'npa']);

/** Keys that belong to one event in a batch rather than to the whole request. */
const isEventKey = (k: string) =>
  k === 'en' || k === '_et' || k === '_c' || k === '_ee' || k.startsWith('ep.') || k.startsWith('epn.') || /^pr\d+$/.test(k);

/** `id123~nmT-Shirt~pr10.01~k0color~v0blue` -> item fields, with custom k/v pairs resolved. */
function parseItem(raw: string): [string, string][] {
  const fields: [string, string][] = [];
  const custom = new Map<string, { k?: string; v?: string }>();
  for (const part of raw.split('~')) {
    const m = part.match(/^([kv])(\d+)(.*)$/);
    if (m) {
      const [, kind, index = '', value] = m;
      const entry = custom.get(index) ?? {};
      entry[kind as 'k' | 'v'] = value;
      custom.set(index, entry);
    } else if (part) {
      const code = part.slice(0, 2);
      fields.push([ITEM_FIELDS[code] ?? code, part.slice(2)]);
    }
  }
  for (const { k, v } of custom.values()) if (k) fields.push([k, v ?? '']);
  return fields;
}

/** `G1xy`: x = ad_storage, y = analytics_storage; 1 granted, 0 denied, - not set. */
function describeGcs(gcs: string): string | undefined {
  const m = gcs.match(/^G1([01-])([01-])$/);
  if (!m) return undefined;
  const state = (c?: string) => (c === '1' ? 'granted' : c === '0' ? 'denied' : 'not set');
  return `ad_storage ${state(m[1])}, analytics_storage ${state(m[2])}`;
}

function decodeEvent(params: [string, string][], host: string): DecodedEvent {
  const get = (k: string) => params.find(([key]) => key === k)?.[1];
  const eventParams: ParamRow[] = [];
  const userProps: ParamRow[] = [];
  const items: ParamRow[] = [];
  const event: ParamRow[] = [];
  const page: ParamRow[] = [];
  const session: ParamRow[] = [];
  const consent: ParamRow[] = [];
  const ecommerce: ParamRow[] = [];
  const technical: ParamRow[] = [{ key: 'endpoint', label: 'Endpoint', value: host }];

  for (const [key, value] of params) {
    let m: RegExpMatchArray | null;
    if ((m = key.match(/^(ep|epn)\.(.+)$/))) {
      eventParams.push({ key, label: m[2], value, note: m[1] === 'epn' ? 'number' : undefined });
    } else if ((m = key.match(/^(up|upn)\.(.+)$/))) {
      userProps.push({ key, label: m[2], value, note: m[1] === 'upn' ? 'number' : undefined });
    } else if ((m = key.match(/^pr(\d+)$/))) {
      const fields = parseItem(value);
      const name = fields.find(([f]) => f === 'item_name')?.[1] ?? fields.find(([f]) => f === 'item_id')?.[1];
      const rest = fields.filter(([f]) => f !== 'item_name' || !name).map(([f, v]) => `${f}: ${v}`);
      items.push({ key, label: `Item ${m[1]}`, value: name ?? value, note: rest.join(' · ') || undefined });
    } else {
      const row: ParamRow = { key, label: LABELS[key], value };
      if (key === 'gcs') row.note = describeGcs(value);
      if (key === 'cu') ecommerce.push(row);
      else if (EVENT_META.has(key)) event.push(row);
      else if (PAGE.has(key)) page.push(row);
      else if (SESSION.has(key)) session.push(row);
      else if (CONSENT.has(key)) consent.push(row);
      else technical.push(row);
    }
  }

  const en = get('en');
  const summary = [
    ...eventParams.slice(0, 4).map((r) => `${r.label}=${truncate(r.value, 40)}`),
    items.length && `${items.length} item${items.length === 1 ? '' : 's'}`,
    get('_dbg') && 'debug_mode',
  ].filter((s): s is string => Boolean(s));

  return {
    vendor: 'ga4',
    eventName: en ?? '(no event name)',
    detail: en === 'page_view' ? get('dt') || get('dl') : undefined,
    account: get('tid'),
    accountLabel: 'Measurement ID',
    summary,
    groups: [
      ...group('Event parameters', eventParams),
      ...group('Ecommerce', [...ecommerce, ...items]),
      ...group('Event', event),
      ...group('Page', page),
      ...group('User properties', userProps),
      ...group('Session & identity', session),
      ...group('Consent', consent),
      ...group('Technical', technical),
    ],
  };
}

function decode(req: CapturedRequest): DecodedEvent[] {
  const url = new URL(req.url);
  const host = `${url.host}${url.pathname}`;
  const urlParams = parseQuery(queryOf(req.url));
  const lines = (req.body ?? '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [decodeEvent(urlParams, host)];

  // Batched: shared params live in the URL, each body line is one event.
  const shared = urlParams.filter(([k]) => !isEventKey(k));
  const events: [string, string][][] = urlParams.some(([k]) => k === 'en') ? [urlParams] : [];
  for (const line of lines) {
    const own = parseQuery(line);
    const ownKeys = new Set(own.map(([k]) => k));
    events.push([...shared.filter(([k]) => !ownKeys.has(k)), ...own]);
  }
  return events.map((p) => decodeEvent(p, host));
}

export const ga4: Decoder = {
  id: 'ga4',
  label: 'Google Analytics 4',
  short: 'GA4',
  decode,
};
