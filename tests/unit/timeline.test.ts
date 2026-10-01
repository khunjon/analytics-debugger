import { describe, expect, it } from 'vitest';
import {
  clearTimeline,
  commitPage,
  emptyTimeline,
  hitsOnLatestPage,
  insertEvent,
  resolvePage,
  trim,
} from '@/lib/timeline';
import type { HitEvent } from '@/lib/types';

const hit = (pageId: string, ts: number, extra: Partial<HitEvent> = {}): HitEvent => ({
  kind: 'hit',
  id: `h${ts}`,
  ts,
  pageId,
  vendor: 'ga4',
  requestId: `r${ts}`,
  url: 'https://www.example.com/g/collect?v=2&tid=G-X',
  method: 'POST',
  resourceType: 'ping',
  ...extra,
});

describe('timeline', () => {
  it('groups by document, including unload beacons that arrive after the next page commits', () => {
    const t = emptyTimeline(1);
    const a = commitPage(t, { documentId: 'docA', url: 'https://x.com/a', ts: 100 });
    const b = commitPage(t, { documentId: 'docB', url: 'https://x.com/b', ts: 200 });
    expect(resolvePage(t, { documentId: 'docA', frameId: 0, ts: 210 }).id).toBe(a.id);
    expect(resolvePage(t, { documentId: 'docB', frameId: 0, ts: 210 }).id).toBe(b.id);
  });

  it('creates a placeholder when a hit beats its navigation commit, then fills it in', () => {
    const t = emptyTimeline(1);
    commitPage(t, { documentId: 'docA', url: 'https://x.com/a', ts: 100 });
    const early = resolvePage(t, { documentId: 'docB', frameId: 0, ts: 205, url: 'https://x.com' });
    expect(early.committed).toBe(false);
    const committed = commitPage(t, { documentId: 'docB', url: 'https://x.com/b', ts: 200 });
    expect(committed.id).toBe(early.id);
    expect(committed).toMatchObject({ url: 'https://x.com/b', ts: 200, committed: true });
    expect(t.pages).toHaveLength(2);
  });

  it('starts a new group when a document is restored from the back/forward cache', () => {
    const t = emptyTimeline(1);
    const first = commitPage(t, { documentId: 'docA', url: 'https://x.com/a', ts: 100 });
    commitPage(t, { documentId: 'docB', url: 'https://x.com/b', ts: 200 });
    const restored = commitPage(t, { documentId: 'docA', url: 'https://x.com/a', ts: 300 });
    expect(restored.id).not.toBe(first.id);
    expect(resolvePage(t, { documentId: 'docA', frameId: 0, ts: 310 }).id).toBe(restored.id);
  });

  it('puts subframe hits on the parent page, or the latest page before them', () => {
    const t = emptyTimeline(1);
    const a = commitPage(t, { documentId: 'docA', url: 'https://x.com/a', ts: 100 });
    const b = commitPage(t, { documentId: 'docB', url: 'https://x.com/b', ts: 200 });
    expect(resolvePage(t, { documentId: 'frame1', parentDocumentId: 'docA', frameId: 5, ts: 250 }).id).toBe(a.id);
    expect(resolvePage(t, { documentId: 'frame2', frameId: 5, ts: 250 }).id).toBe(b.id);
    expect(resolvePage(t, { frameId: 5, ts: 150 }).id).toBe(a.id);
  });

  it('keeps events sorted by time regardless of arrival order', () => {
    const t = emptyTimeline(1);
    const p = commitPage(t, { documentId: 'd', url: 'https://x.com', ts: 0 });
    insertEvent(t, hit(p.id, 30));
    insertEvent(t, hit(p.id, 10));
    insertEvent(t, hit(p.id, 20));
    expect(t.events.map((e) => e.ts)).toEqual([10, 20, 30]);
    expect(hitsOnLatestPage(t)).toBe(3);
  });

  it('clears events but keeps the current page', () => {
    const t = emptyTimeline(1);
    commitPage(t, { documentId: 'docA', url: 'https://x.com/a', ts: 100 });
    const b = commitPage(t, { documentId: 'docB', url: 'https://x.com/b', ts: 200 });
    insertEvent(t, hit(b.id, 210));
    clearTimeline(t);
    expect(t.events).toEqual([]);
    expect(t.pages).toEqual([b]);
    expect(resolvePage(t, { documentId: 'docB', frameId: 0, ts: 300 }).id).toBe(b.id);
  });

  it('drops the oldest pages first when over the size budget', () => {
    const t = emptyTimeline(1);
    for (let i = 0; i < 8; i++) {
      const p = commitPage(t, { documentId: `d${i}`, url: `https://x.com/${i}`, ts: i * 100 });
      insertEvent(t, hit(p.id, i * 100 + 1, { body: 'x'.repeat(1000) }));
    }
    trim(t, 4000);
    expect(JSON.stringify(t).length).toBeLessThanOrEqual(4000);
    expect(t.pages.at(-1)?.url).toBe('https://x.com/7');
    expect(t.pages[0]?.url).not.toBe('https://x.com/0');
    const pageIds = new Set(t.pages.map((p) => p.id));
    expect(t.events.every((e) => pageIds.has(e.pageId))).toBe(true);
    expect(Object.values(t.docToPage).every((id) => pageIds.has(id))).toBe(true);
  });
});
