import type { HitEvent, PageRecord, StoredTimeline, TabTimeline, TimelineEvent } from './types';

export const MAX_PAGES = 40;
export const MAX_EVENTS = 2000;
/** Per-tab budget. chrome.storage.session holds 10 MB across all tabs. */
export const MAX_BYTES = 3_000_000;
/** Events per storage chunk. */
export const CHUNK_SIZE = 50;

export const newId = () => crypto.randomUUID();

export function emptyTimeline(tabId: number): TabTimeline {
  return { tabId, rev: 0, updated: Date.now(), pages: [], events: [], docToPage: {}, nextSeq: 0 };
}

function addPage(t: TabTimeline, page: PageRecord): PageRecord {
  let i = t.pages.length;
  while (i > 0 && t.pages[i - 1]!.ts > page.ts) i--;
  t.pages.splice(i, 0, page);
  if (page.documentId) t.docToPage[page.documentId] = page.id;
  return page;
}

/** A top-level navigation committed. Fills in a placeholder page if hits for this document arrived first. */
export function commitPage(
  t: TabTimeline,
  nav: { documentId?: string; url: string; ts: number; transition?: string },
): PageRecord {
  const existingId = nav.documentId ? t.docToPage[nav.documentId] : undefined;
  const existing = existingId ? t.pages.find((p) => p.id === existingId) : undefined;
  if (existing && !existing.committed) {
    existing.url = nav.url;
    existing.transition = nav.transition;
    existing.committed = true;
    existing.ts = Math.min(existing.ts, nav.ts);
    return existing;
  }
  // A committed page for this document already exists only on a back/forward-cache restore: start a new group.
  return addPage(t, { id: newId(), ts: nav.ts, url: nav.url, documentId: nav.documentId, transition: nav.transition, committed: true });
}

/** Decide which page group an event belongs to. */
export function resolvePage(
  t: TabTimeline,
  src: { documentId?: string; parentDocumentId?: string; frameId?: number; ts: number; url?: string },
): PageRecord {
  const byDoc = (id?: string) => (id && t.docToPage[id] ? t.pages.find((p) => p.id === t.docToPage[id]) : undefined);
  const known = byDoc(src.documentId) ?? byDoc(src.parentDocumentId);
  if (known) return known;

  if (src.documentId && src.frameId === 0) {
    // Top-level document we have no commit for yet: the commit event is still in flight,
    // or capture started after the page loaded.
    return addPage(t, { id: newId(), ts: src.ts, url: src.url ?? '', documentId: src.documentId, committed: false });
  }
  // Subframes, workers, anything without a document: the latest page that started before the event.
  const before = t.pages.findLast((p) => p.ts <= src.ts) ?? t.pages[0];
  return before ?? addPage(t, { id: newId(), ts: src.ts, url: src.url ?? '', committed: false });
}

/** Add an event in time order, numbering it in order of arrival. */
export function insertEvent(t: TabTimeline, e: TimelineEvent): void {
  e.seq ??= t.nextSeq++;
  let i = t.events.length;
  while (i > 0 && t.events[i - 1]!.ts > e.ts) i--;
  t.events.splice(i, 0, e);
}

export function findHit(t: TabTimeline, requestId: string): HitEvent | undefined {
  return t.events.findLast((e): e is HitEvent => e.kind === 'hit' && e.requestId === requestId);
}

function dropPages(t: TabTimeline, count: number): TimelineEvent[] {
  const dropped = new Set(t.pages.splice(0, count).map((p) => p.id));
  const removed = t.events.filter((e) => dropped.has(e.pageId));
  t.events = t.events.filter((e) => !dropped.has(e.pageId));
  for (const [doc, pageId] of Object.entries(t.docToPage)) if (dropped.has(pageId)) delete t.docToPage[doc];
  return removed;
}

const sizeOf = (events: TimelineEvent[]) => events.reduce((n, e) => n + JSON.stringify(e).length + 1, 0);

/**
 * Keep a tab's timeline within the page, event and byte budgets, dropping the oldest data first.
 * `bytes` is the current size, when the caller already knows it. Returns the events it dropped.
 */
export function trim(t: TabTimeline, maxBytes = MAX_BYTES, bytes = JSON.stringify(t).length): TimelineEvent[] {
  const removed: TimelineEvent[] = [];
  const drop = (events: TimelineEvent[]) => {
    removed.push(...events);
    bytes -= sizeOf(events);
  };
  if (t.pages.length > MAX_PAGES) drop(dropPages(t, t.pages.length - MAX_PAGES));
  // Drop a tenth more than needed, so a long session doesn't trim (and rewrite storage) on every event.
  if (t.events.length > MAX_EVENTS) drop(t.events.splice(0, t.events.length - Math.floor(MAX_EVENTS * 0.9)));
  while (bytes > maxBytes) {
    if (t.pages.length > 1) drop(dropPages(t, Math.max(1, Math.floor(t.pages.length / 4))));
    else if (t.events.length > 1) drop(t.events.splice(0, Math.ceil(t.events.length / 2)));
    else break;
  }
  return removed;
}

/** Clear events but keep the current page, so new hits still group under it. Returns the dropped events. */
export function clearTimeline(t: TabTimeline): TimelineEvent[] {
  const removed = t.events;
  const current = t.pages[t.pages.length - 1];
  t.events = [];
  t.pages = current ? [current] : [];
  t.docToPage = current?.documentId ? { [current.documentId]: current.id } : {};
  return removed;
}

export function hitsOnLatestPage(t: TabTimeline): number {
  const latest = t.pages[t.pages.length - 1];
  if (!latest) return 0;
  return t.events.reduce((n, e) => n + (e.kind === 'hit' && e.pageId === latest.id ? 1 : 0), 0);
}

// ---- Storage layout: see StoredTimeline ----

export const chunkOf = (e: TimelineEvent) => Math.floor((e.seq ?? 0) / CHUNK_SIZE);

/** The events of the given chunks (all of them by default), by chunk. Chunks without events are absent. */
export function chunkEvents(events: TimelineEvent[], only?: Set<number>): Map<number, TimelineEvent[]> {
  const out = new Map<number, TimelineEvent[]>();
  for (const e of events) {
    const c = chunkOf(e);
    if (only && !only.has(c)) continue;
    let list = out.get(c);
    if (!list) out.set(c, (list = []));
    list.push(e);
  }
  return out;
}

export function storedRecord(t: TabTimeline, chunks: Iterable<number>): StoredTimeline {
  const { events: _events, ...rest } = t;
  return { ...rest, chunks: [...chunks].sort((a, b) => a - b) };
}

/** A stored record from before chunking, with the events inline. Still read after an update. */
type LegacyRecord = Omit<TabTimeline, 'nextSeq'> & { nextSeq?: number; chunks?: undefined };

/**
 * Rebuild a timeline from its stored record and chunks, in time order (arrival order for ties, the
 * same order the background keeps). Chunk arrays are used as is, so unchanged events keep their identity.
 */
export function assembleTimeline(
  record: StoredTimeline | LegacyRecord,
  chunk: (c: number) => TimelineEvent[] | undefined,
): TabTimeline {
  if (!record.chunks) {
    const legacy = record as LegacyRecord;
    legacy.events.forEach((e, i) => (e.seq ??= i));
    return { ...legacy, nextSeq: legacy.nextSeq ?? legacy.events.length };
  }
  const { chunks, ...rest } = record;
  const events = chunks.flatMap((c) => chunk(c) ?? []);
  events.sort((a, b) => a.ts - b.ts || (a.seq ?? 0) - (b.seq ?? 0));
  return { ...rest, events };
}
