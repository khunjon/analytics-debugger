import type { CapturedRequest, DecodedEvent, Decoder, ParamRow } from './types';
import { byTrailingNumber, group, parseQuery, queryOf, truncate } from './util';

const LABELS: Record<string, string> = {
  pageName: 'Page name',
  g: 'Page URL',
  r: 'Referrer',
  ch: 'Site section',
  server: 'Server',
  pageType: 'Page type',
  events: 'Events',
  products: 'Products',
  purchaseID: 'Purchase ID',
  xact: 'Transaction ID',
  cc: 'Currency code',
  state: 'State',
  zip: 'Zip code',
  v0: 'Campaign',
  pe: 'Link type',
  pev1: 'Link URL',
  pev2: 'Link name',
  pev3: 'Media / other',
  mid: 'Experience Cloud ID',
  aid: 'Analytics visitor ID',
  vid: 'Custom visitor ID',
  fid: 'Fallback visitor ID',
  mcorgid: 'Experience Cloud org',
  aamb: 'Audience Manager blob',
  aamlh: 'Audience Manager location hint',
  sdid: 'Supplemental data ID (A4T)',
  tnt: 'Target A4T payload',
  t: 'Client timestamp',
  ts: 'Timestamp',
  ce: 'Character set',
  cl: 'Visit cookie lifetime',
  c: 'Color depth',
  s: 'Screen resolution',
  bw: 'Browser width',
  bh: 'Browser height',
  j: 'JavaScript version',
  v: 'Java enabled',
  k: 'Cookies enabled',
  p: 'Plug-ins',
  ns: 'Visitor namespace',
  AQB: 'Start of query',
  AQE: 'End of query',
  ndh: 'Image request flag',
};

const LINK_TYPES: Record<string, string> = {
  lnk_o: 'custom link',
  lnk_d: 'download link',
  lnk_e: 'exit link',
};

const PAGE_KEYS = new Set(['pageName', 'g', 'r', 'ch', 'server', 'pageType', 'h1', 'h2', 'h3', 'h4', 'h5']);
const LINK_KEYS = new Set(['pe', 'pev1', 'pev2', 'pev3']);
const COMMERCE_KEYS = new Set(['events', 'products', 'purchaseID', 'xact', 'cc', 'state', 'zip', 'v0']);
const IDENTITY_KEYS = new Set(['mid', 'aid', 'vid', 'fid', 'mcorgid', 'aamb', 'aamlh', 'sdid', 'tnt']);

function labelFor(key: string): string | undefined {
  let m: RegExpMatchArray | null;
  if ((m = key.match(/^v(\d+)$/)) && m[1] !== '0') return `eVar${m[1]}`;
  if ((m = key.match(/^c(\d+)$/))) return `prop${m[1]}`;
  if ((m = key.match(/^h(\d)$/))) return `hier${m[1]}`;
  if ((m = key.match(/^l(\d)$/))) return `list${m[1]}`;
  return LABELS[key];
}

/**
 * AppMeasurement serializes context data as nested markers in the query string:
 * `c.&a.&activitymap.&page=home&.activitymap&.a&myKey=1&.c` -> `a.activitymap.page`, `myKey`.
 */
function splitContextData(params: [string, string][]) {
  const regular: [string, string][] = [];
  const context: [string, string][] = [];
  const stack: string[] = [];
  for (const [k, v] of params) {
    if (v === '' && k.length > 1 && k.endsWith('.') && !k.startsWith('.')) {
      stack.push(k.slice(0, -1));
    } else if (v === '' && k.length > 1 && k.startsWith('.') && stack.length) {
      stack.pop();
    } else if (stack[0] === 'c') {
      context.push([[...stack.slice(1), k].join('.'), v]);
    } else if (stack.length) {
      regular.push([[...stack, k].join('.'), v]);
    } else {
      regular.push([k, v]);
    }
  }
  return { regular, context };
}

/** `;Category;SKU;qty;price;events;eVars` entries, comma separated. */
function productRows(products: string): ParamRow[] {
  return products.split(',').map((entry, i) => {
    const [category, product, qty, price, events, evars] = entry.split(';');
    const note = [
      category && `category ${category}`,
      qty && `qty ${qty}`,
      price && `price ${price}`,
      events && events,
      evars && evars,
    ]
      .filter(Boolean)
      .join(' · ');
    return { key: `product ${i + 1}`, value: product || '(no product)', note: note || undefined };
  });
}

function decode(req: CapturedRequest): DecodedEvent[] {
  const url = new URL(req.url);
  const all = parseQuery(queryOf(req.url));
  if (req.body && req.method === 'POST') all.push(...parseQuery(req.body));
  const { regular, context } = splitContextData(all);
  const values = new Map(regular);

  const rows: ParamRow[] = regular.map(([key, value]) => {
    const row: ParamRow = { key, label: labelFor(key), value };
    if (value.startsWith('D=')) {
      const ref = value.slice(2);
      row.note = values.has(ref) ? `= ${values.get(ref)}` : 'dynamic variable, resolved by Adobe';
    }
    if (key === 'pe' && LINK_TYPES[value]) row.note = LINK_TYPES[value];
    return row;
  });

  const take = (pred: (r: ParamRow) => boolean) => {
    const picked: ParamRow[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (pred(rows[i]!)) picked.unshift(...rows.splice(i, 1));
    }
    return picked;
  };

  const page = take((r) => PAGE_KEYS.has(r.key));
  const link = take((r) => LINK_KEYS.has(r.key));
  const commerce = take((r) => COMMERCE_KEYS.has(r.key));
  const evars = take((r) => /^v\d+$/.test(r.key)).sort(byTrailingNumber);
  const props = take((r) => /^c\d+$/.test(r.key)).sort(byTrailingNumber);
  const lists = take((r) => /^l\d$/.test(r.key)).sort(byTrailingNumber);
  const identity = take((r) => IDENTITY_KEYS.has(r.key));

  const activityMap = context
    .filter(([k]) => k.startsWith('a.activitymap.'))
    .map(([key, value]) => ({ key, label: `Activity Map ${key.slice('a.activitymap.'.length)}`, value }));
  const contextRows = context.filter(([k]) => !k.startsWith('a.activitymap.')).map(([key, value]) => ({ key, value }));

  // Path: /b/ss/{rsid[,rsid]}/{mode}/{library version}/s{random}
  const segments = url.pathname.split('/').filter(Boolean);
  const ss = segments.indexOf('ss');
  const reportSuites = ss >= 0 ? segments[ss + 1] : undefined;
  const version = ss >= 0 ? segments[ss + 3] : undefined;
  const technical: ParamRow[] = [
    { key: 'endpoint', label: 'Tracking server', value: url.host },
    ...(version && !/^s\d+$/.test(version) ? [{ key: 'version', label: 'Library version', value: version }] : []),
    ...(req.method !== 'GET' ? [{ key: 'method', label: 'HTTP method', value: req.method }] : []),
    ...rows,
  ];

  const pe = values.get('pe');
  const events = values.get('events');
  const products = values.get('products');
  const summary = [
    events && `events=${events}`,
    products && `products=${truncate(products, 60)}`,
    evars.length && `${evars.length} eVar${evars.length === 1 ? '' : 's'}`,
    props.length && `${props.length} prop${props.length === 1 ? '' : 's'}`,
    contextRows.length && `${contextRows.length} context data`,
  ].filter((s): s is string => Boolean(s));

  return [
    {
      vendor: 'adobe-analytics',
      eventName: pe ? 's.tl' : 's.t',
      detail: pe
        ? `${values.get('pev2') || values.get('pev1') || '(no link name)'}${LINK_TYPES[pe] ? ` (${LINK_TYPES[pe]})` : ''}`
        : values.get('pageName') || values.get('g') || '(no page name)',
      account: reportSuites,
      accountLabel: 'Report suite',
      summary,
      groups: [
        ...group('Page', page),
        ...group('Link', link),
        ...group('Commerce', commerce),
        ...group('Products', products ? productRows(products) : []),
        ...group('eVars', evars),
        ...group('Props', props),
        ...group('List variables', lists),
        ...group('Context data', contextRows),
        ...group('Activity Map', activityMap),
        ...group('Identity', identity),
        ...group('Technical', technical),
      ],
    },
  ];
}

export const adobeAnalytics: Decoder = {
  id: 'adobe-analytics',
  label: 'Adobe Analytics',
  short: 'AA',
  decode,
};
