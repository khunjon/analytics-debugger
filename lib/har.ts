import { matchVendor } from './decoders/match';
import { sanitizePageEvent } from './page-event';
import type { HitEvent, PageRecord, TabTimeline, TimelineEvent } from './types';

/**
 * HAR 1.2 export and import (http://www.softwareishard.com/blog/har-12-spec/), so a capture can go to
 * a colleague as a file, and Charles or DevTools sessions get the same decoded, checked timeline.
 *
 * Export writes each hit as an entry and each page as a HAR page. Everything else on the timeline
 * (data layer pushes, clicks, Tags rules, what's loaded) goes in `log._analyticsDebugger`, a custom
 * field other tools ignore, so a file exported here re-imports as the same timeline.
 *
 * Import keeps only requests a decoder recognizes. Entries are grouped into pages by their `pageref`
 * (DevTools), else by the Referer header or the last document request before them (Charles).
 * Pure: no extension APIs, so the panel and the planned crawler can both use it.
 */

interface NameValue {
  name: string;
  value: string;
}

export interface HarEntry {
  pageref?: string;
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: NameValue[];
    headers: NameValue[];
    queryString: NameValue[];
    postData?: { mimeType: string; text?: string; params?: { name: string; value?: string }[] };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: NameValue[];
    headers: NameValue[];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
    /** DevTools: why the request failed, e.g. `net::ERR_BLOCKED_BY_CLIENT`. */
    _error?: string;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  /** DevTools: document, script, xhr, fetch, ping, image… */
  _resourceType?: string;
  _redirectedFrom?: string;
  /** Order of arrival on the tab, for events with the same timestamp. */
  _seq?: number;
  /** The exact timestamp: Chrome's are fractional, `startedDateTime` keeps whole milliseconds. */
  _ts?: number;
}

export interface HarPage {
  startedDateTime: string;
  id: string;
  /** The page URL, as DevTools writes it. */
  title: string;
  pageTimings: Record<string, number>;
  /** The exact timestamp, as on entries. */
  _ts?: number;
}

export interface Har {
  log: {
    version: string;
    creator: { name: string; version: string };
    pages?: HarPage[];
    entries: HarEntry[];
    _analyticsDebugger?: { version: 1; events: TimelineEvent[] };
  };
}

const iso = (ts: number) => new Date(ts).toISOString();
/** An exported `_ts` when there is one, else the ISO time. Relative times would otherwise shift by up to 10 ms when rounded. */
const timeOf = (exact: unknown, started: unknown) =>
  typeof exact === 'number' && Number.isFinite(exact) ? exact : Date.parse(typeof started === 'string' ? started : '');

function queryString(url: string): NameValue[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

const bodyType = (body: string) => (/^\s*[[{]/.test(body) ? 'application/json' : 'application/x-www-form-urlencoded');

function hitEntry(hit: HitEvent): HarEntry {
  return {
    pageref: hit.pageId,
    startedDateTime: iso(hit.ts),
    time: 0,
    request: {
      method: hit.method,
      url: hit.url,
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      queryString: queryString(hit.url),
      ...(hit.body != null ? { postData: { mimeType: bodyType(hit.body), text: hit.body } } : {}),
      headersSize: -1,
      bodySize: hit.body != null ? new TextEncoder().encode(hit.body).length : 0,
    },
    response: {
      status: hit.status ?? 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: '' },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
      ...(hit.error ? { _error: hit.error } : {}),
    },
    cache: {},
    timings: { send: 0, wait: 0, receive: 0 },
    _resourceType: hit.resourceType,
    ...(hit.redirectedFrom ? { _redirectedFrom: hit.redirectedFrom } : {}),
    ...(hit.seq !== undefined ? { _seq: hit.seq } : {}),
    _ts: hit.ts,
  };
}

/** A timeline (or some of its pages) as HAR 1.2. */
export function timelineToHar(t: TabTimeline, creator: { name: string; version: string }, pageIds?: Set<string>): Har {
  const pages = t.pages.filter((p) => !pageIds || pageIds.has(p.id));
  const keep = new Set(pages.map((p) => p.id));
  const events = t.events.filter((e) => keep.has(e.pageId));
  return {
    log: {
      version: '1.2',
      creator,
      pages: pages.map((p) => ({ startedDateTime: iso(p.ts), id: p.id, title: p.url, pageTimings: {}, _ts: p.ts })),
      entries: events.filter((e): e is HitEvent => e.kind === 'hit').map(hitEntry),
      _analyticsDebugger: { version: 1, events: events.filter((e) => e.kind !== 'hit') },
    },
  };
}

// ---- Import ----

/** What an import found, besides the timeline. */
export interface HarImport {
  timeline: TabTimeline;
  /** The tool that wrote the file, e.g. `Charles Proxy 5.0`. */
  creator?: string;
  /** Requests no decoder recognized. */
  ignored: number;
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function header(entry: Record<string, any>, name: string): string | undefined {
  const headers: unknown = entry.request?.headers;
  if (!Array.isArray(headers)) return undefined;
  const found = headers.find((h) => isObject(h) && typeof h.name === 'string' && h.name.toLowerCase() === name);
  return str(found?.value);
}

function requestBody(entry: Record<string, any>): string | undefined {
  const post: unknown = entry.request?.postData;
  if (!isObject(post)) return undefined;
  if (typeof post.text === 'string') return post.text;
  if (Array.isArray(post.params)) {
    return post.params
      .filter(isObject)
      .map((p) => `${encodeURIComponent(String(p.name ?? ''))}=${encodeURIComponent(String(p.value ?? ''))}`)
      .join('&');
  }
  return undefined;
}

/** A top-level page load. Chrome's Sec-Fetch-Dest tells a page from an iframe; without it, guess from the type. */
function isDocument(entry: Record<string, any>, url: string): boolean {
  const dest = header(entry, 'sec-fetch-dest');
  if (dest) return dest === 'document';
  if (entry._resourceType) return entry._resourceType === 'document';
  const method = str(entry.request?.method)?.toUpperCase() ?? 'GET';
  const mime = str(entry.response?.content?.mimeType) ?? '';
  return method === 'GET' && /^text\/html\b/i.test(mime) && /^https?:/.test(url);
}

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/** The page for hits with no page to go with, like an app's. */
export const NO_PAGE = '(no page: requests without a referrer)';

/** Each import gets its own ids: decoded rows are cached by event id. */
const importPrefix = () => `har-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Read a HAR file's JSON into a timeline. Throws when it isn't a HAR. `prefix` sets the ids, for tests.
 */
export function harToTimeline(input: unknown, prefix = importPrefix()): HarImport {
  const log = isObject(input) ? input.log : undefined;
  if (!isObject(log) || !Array.isArray(log.entries)) throw new Error('Not a HAR file: there is no log.entries list.');

  const pages: PageRecord[] = [];
  const addPage = (url: string, ts: number): PageRecord => {
    const page: PageRecord = { id: `${prefix}:p${pages.length}`, ts, url, committed: true };
    pages.push(page);
    return page;
  };

  // HAR pages, from DevTools or an export from here, by their id. Created when first used.
  const harPages = new Map<string, { url: string; ts: number; page?: PageRecord }>();
  for (const p of Array.isArray(log.pages) ? log.pages : []) {
    if (!isObject(p) || typeof p.id !== 'string') continue;
    const ts = timeOf(p._ts, p.startedDateTime);
    harPages.set(p.id, { url: str(p.title) ?? '', ts });
  }
  const fromHarPage = (ref: unknown, ts: number): PageRecord | undefined => {
    const hp = typeof ref === 'string' ? harPages.get(ref) : undefined;
    if (!hp) return undefined;
    hp.page ??= addPage(hp.url, Number.isFinite(hp.ts) ? hp.ts : ts);
    return hp.page;
  };
  const custom: unknown[] =
    isObject(log._analyticsDebugger) && Array.isArray(log._analyticsDebugger.events) ? log._analyticsDebugger.events : [];

  const entries = (log.entries as unknown[])
    .map((entry, index) => ({ entry, index, ts: isObject(entry) ? timeOf(entry._ts, entry.startedDateTime) : NaN }))
    .filter((x): x is { entry: Record<string, any>; index: number; ts: number } => Number.isFinite(x.ts))
    .sort((a, b) => a.ts - b.ts || a.index - b.index);

  // A redirect is two entries (the 3xx, then the request it led to). Keep the second, marked as redirected.
  const urls = new Set(entries.map((x) => str(x.entry.request?.url)));
  const redirectedFrom = new Map<string, string>();
  const redirects = new Set<number>();
  for (const { entry, index } of entries) {
    const status = Number(entry.response?.status);
    const location = str(entry.response?.redirectURL);
    const url = str(entry.request?.url);
    if (!url || !location || status < 300 || status >= 400) continue;
    let target: string;
    try {
      target = new URL(location, url).href;
    } catch {
      continue;
    }
    if (urls.has(target)) {
      redirects.add(index);
      redirectedFrom.set(target, redirectedFrom.get(url) ?? url);
    }
  }

  const found: { ts: number; order: number; event: TimelineEvent }[] = [];
  let ignored = 0;
  let current: PageRecord | undefined;

  for (const { entry, index, ts } of entries) {
    const url = str(entry.request?.url);
    if (!url) continue;
    const vendor = matchVendor(url);
    if (!vendor) {
      if (isDocument(entry, url)) current = fromHarPage(entry.pageref, ts) ?? addPage(url, ts);
      else ignored++;
      continue;
    }
    if (redirects.has(index)) continue;

    let page = fromHarPage(entry.pageref, ts);
    if (!page) {
      const referer = header(entry, 'referer');
      const refOrigin = referer && originOf(referer);
      if (referer && refOrigin) {
        // Cross-origin requests usually carry only the origin, so match the current page by origin too.
        page =
          pages.findLast((p) => p.url === referer) ??
          (current && originOf(current.url) === refOrigin && new URL(referer).pathname === '/' ? current : undefined);
        if (!page) page = current = addPage(referer, ts);
      } else {
        // Browsers send a Referer with hits; an app (Charles on a phone) doesn't. Those share one group.
        page = pages.find((p) => p.url === NO_PAGE) ?? addPage(NO_PAGE, ts);
      }
    }

    const status = Number(entry.response?.status);
    const error = str(entry.response?._error);
    const body = requestBody(entry);
    const from = str(entry._redirectedFrom) ?? redirectedFrom.get(url);
    const hit: HitEvent = {
      kind: 'hit',
      id: `${prefix}:e${index}`,
      ts,
      pageId: page.id,
      vendor,
      requestId: String(index),
      url,
      method: (str(entry.request?.method) ?? 'GET').toUpperCase(),
      ...(body !== undefined ? { body } : {}),
      resourceType: str(entry._resourceType) ?? 'other',
      ...(status > 0 ? { status } : {}),
      ...(error || !(status > 0) ? { error: error ?? 'no response' } : {}),
      ...(from ? { redirectedFrom: from } : {}),
    };
    found.push({ ts, order: typeof entry._seq === 'number' ? entry._seq : index, event: hit });
  }

  custom.forEach((raw, i) => {
    if (!isObject(raw)) return;
    const page = fromHarPage(raw.pageId, Number(raw.ts));
    if (!page) return;
    let event: TimelineEvent | undefined;
    if (raw.kind === 'nav') {
      const url = str(raw.url);
      if (url && (raw.how === 'history' || raw.how === 'hash') && Number.isFinite(raw.ts)) {
        event = { kind: 'nav', id: '', pageId: '', ts: raw.ts, url, how: raw.how };
      }
    } else {
      const clean = sanitizePageEvent(raw);
      if (clean) event = { ...clean, id: '', pageId: '' } as TimelineEvent;
    }
    if (!event) return;
    event.id = `${prefix}:x${i}`;
    event.pageId = page.id;
    found.push({ ts: event.ts, order: typeof raw.seq === 'number' ? raw.seq : entries.length + i, event });
  });

  found.sort((a, b) => a.ts - b.ts || a.order - b.order);
  const events = found.map((f, seq) => ({ ...f.event, seq }));
  pages.sort((a, b) => a.ts - b.ts);
  const creator = isObject(log.creator) ? [str(log.creator.name), str(log.creator.version)].filter(Boolean).join(' ') : '';
  return {
    timeline: { tabId: -1, rev: 1, updated: Date.now(), pages, events, docToPage: {}, nextSeq: events.length },
    ...(creator ? { creator } : {}),
    ignored,
  };
}
