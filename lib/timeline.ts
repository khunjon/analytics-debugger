import type { HitEvent, PageRecord, TabTimeline, TimelineEvent } from './types';

export const MAX_PAGES = 40;
export const MAX_EVENTS = 2000;
/** Per-tab budget. chrome.storage.session holds 10 MB across all tabs. */
export const MAX_BYTES = 3_000_000;

export const newId = () => crypto.randomUUID();

export function emptyTimeline(tabId: number): TabTimeline {
  return { tabId, rev: 0, updated: Date.now(), pages: [], events: [], docToPage: {} };
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

export function insertEvent(t: TabTimeline, e: TimelineEvent): void {
  let i = t.events.length;
  while (i > 0 && t.events[i - 1]!.ts > e.ts) i--;
  t.events.splice(i, 0, e);
}

export function findHit(t: TabTimeline, requestId: string): HitEvent | undefined {
  return t.events.findLast((e): e is HitEvent => e.kind === 'hit' && e.requestId === requestId);
}

function dropPages(t: TabTimeline, count: number): void {
  const dropped = new Set(t.pages.splice(0, count).map((p) => p.id));
  t.events = t.events.filter((e) => !dropped.has(e.pageId));
  for (const [doc, pageId] of Object.entries(t.docToPage)) if (dropped.has(pageId)) delete t.docToPage[doc];
}

/** Keep a tab's timeline within the page, event and byte budgets, dropping the oldest data first. */
export function trim(t: TabTimeline, maxBytes = MAX_BYTES): void {
  if (t.pages.length > MAX_PAGES) dropPages(t, t.pages.length - MAX_PAGES);
  if (t.events.length > MAX_EVENTS) t.events.splice(0, t.events.length - MAX_EVENTS);
  while (JSON.stringify(t).length > maxBytes) {
    if (t.pages.length > 1) dropPages(t, Math.max(1, Math.floor(t.pages.length / 4)));
    else if (t.events.length > 1) t.events.splice(0, Math.ceil(t.events.length / 2));
    else break;
  }
}

/** Clear events but keep the current page, so new hits still group under it. */
export function clearTimeline(t: TabTimeline): void {
  const current = t.pages[t.pages.length - 1];
  t.events = [];
  t.pages = current ? [current] : [];
  t.docToPage = current?.documentId ? { [current.documentId]: current.id } : {};
}

export function hitsOnLatestPage(t: TabTimeline): number {
  const latest = t.pages[t.pages.length - 1];
  if (!latest) return 0;
  return t.events.reduce((n, e) => n + (e.kind === 'hit' && e.pageId === latest.id ? 1 : 0), 0);
}
