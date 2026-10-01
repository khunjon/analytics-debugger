import { describe, expect, it } from 'vitest';
import { pageToWatchMarkdown } from '@/lib/markdown';
import type { DataLayerEvent, HitEvent, InteractionEvent, TabTimeline, TimelineEvent } from '@/lib/types';
import { buildGroups, filterGroups, CATEGORIES, type Category } from '@/lib/view';
import { paramMatches } from '@/lib/watch';

const ALL = new Set<Category>(CATEGORIES.map((c) => c.id));
let seq = 0;

const aa = (query: string): HitEvent => ({
  kind: 'hit',
  id: `aa${++seq}`,
  ts: seq,
  pageId: 'p1',
  vendor: 'adobe-analytics',
  requestId: `r${seq}`,
  url: `https://m.example.com/b/ss/rs/1/JS-2.27.0/s${seq}?AQB=1&${query}&AQE=1`,
  method: 'GET',
  resourceType: 'image',
});

const ga4 = (query: string): HitEvent => ({
  ...aa(''),
  id: `ga${seq}`,
  vendor: 'ga4',
  url: `https://www.example.com/g/collect?v=2&tid=G-TEST&${query}`,
});

const dl = (source: string, payload: unknown): DataLayerEvent => ({
  kind: 'datalayer',
  id: `dl${++seq}`,
  ts: seq,
  pageId: 'p1',
  source,
  payload: JSON.stringify(payload),
});

const click = (text: string): InteractionEvent => ({
  kind: 'interaction',
  id: `c${++seq}`,
  ts: seq,
  pageId: 'p1',
  action: 'click',
  text,
  selector: 'button',
  tag: 'button',
});

function timeline(events: TimelineEvent[]): TabTimeline {
  return {
    tabId: 1,
    rev: 1,
    updated: 0,
    pages: [{ id: 'p1', ts: 0, url: 'https://www.example.com/', committed: true }],
    events,
    docToPage: {},
  };
}

const t = timeline([
  aa('pageName=home&v12=alpha&events=event1'),
  ga4('en=page_view&dl=https%3A%2F%2Fwww.example.com%2F&dt=Home'),
  click('Add to cart'),
  dl('adobeDataLayer', { event: 'cart.add', product: { sku: 'A1' } }),
  aa('pe=lnk_o&pev2=add%20to%20cart&v12=beta&events=scAdd'),
  ga4('en=add_to_cart&cu=USD'),
  dl('dataLayer', ['event', 'add_to_cart', { currency: 'USD', value: 10 }]),
  aa('pageName=cart&v12=beta'),
]);
const groups = buildGroups(t);
const run = (query: string) => filterGroups(groups, ALL, query);
const titles = (query: string) => run(query).groups.flatMap((g) => g.rows.map((r) => r.key));

describe('watching variables from the search bar', () => {
  it('treats variable names as watches and everything else as text', () => {
    expect(run('eVar12, page_view').terms).toEqual({ watch: ['eVar12'], text: ['page_view'] });
    expect(run('v12').terms.watch).toEqual(['v12']);
    expect(run('Page Name').terms.watch).toEqual(['Page Name']);
    expect(run('page_location').terms.watch).toEqual(['page_location']);
    expect(run('"events"').terms).toEqual({ watch: [], text: ['events'] });
    expect(run('not_a_variable').terms).toEqual({ watch: [], text: ['not_a_variable'] });
  });

  it('keeps hits that carry the variable, plus clicks for context, and flags changes', () => {
    const result = run('eVar12');
    const rows = result.groups[0]!.rows;
    expect(rows.map((r) => r.type)).toEqual(['hit', 'interaction', 'hit', 'hit']);
    const cells = rows.filter((r) => r.type === 'hit').map((r) => result.watch.get(r.key)![0]!);
    expect(cells.map((c) => [c.matches[0]?.value, c.changed])).toEqual([
      ['alpha', false],
      ['beta', true],
      ['beta', false],
    ]);
  });

  it('shows several variables per hit, marking the ones a hit lacks', () => {
    const result = run('eVar12, pageName');
    const link = result.groups[0]!.rows.find((r) => r.type === 'hit' && r.decoded.eventName === 's.tl')!;
    expect(result.watch.get(link.key)!.map((c) => [c.term, c.matches.map((m) => m.value)])).toEqual([
      ['eVar12', ['beta']],
      ['pageName', []],
    ]);
  });

  it('combines an event filter with a watch', () => {
    const result = run('page_view, page_location');
    const rows = result.groups[0]!.rows;
    expect(rows).toHaveLength(1);
    expect(result.watch.get(rows[0]!.key)![0]!.matches[0]!.value).toBe('https://www.example.com/');
  });

  it('matches the same variable across vendors and data layer pushes', () => {
    const result = run('currency');
    const rows = result.groups[0]!.rows.filter((r) => r.type !== 'interaction');
    expect(rows.map((r) => [r.type, result.watch.get(r.key)![0]!.matches[0]!.value])).toEqual([
      ['hit', 'USD'],
      ['datalayer', 'USD'],
    ]);
    expect(run('product.sku').watch.size).toBe(1);
  });

  it('keeps plain text search working, with comma-separated terms matching any', () => {
    expect(titles('scAdd')).toHaveLength(1);
    expect(run('page_view, add_to_cart').groups[0]!.rows.map((r) => r.type)).toEqual(['hit', 'hit', 'datalayer']);
  });

  it('matches dotted terms against the end of nested keys only', () => {
    const p = { key: 'web.webPageDetails.name', value: 'home' };
    expect(paramMatches(p, 'webPageDetails.name')).toBe(true);
    expect(paramMatches(p, 'name')).toBe(false);
  });

  it('copies the watched values as a table', () => {
    const result = run('eVar12, events');
    const md = pageToWatchMarkdown(result.groups[0]!, result.terms.watch, result.watch);
    expect(md).toContain('| Time | Source | Event | eVar12 | events |');
    expect(md).toContain('| AA | s.tl (add to cart (custom link)) | beta | scAdd |');
    expect(md).toContain('| Click | "Add to cart" button |  |  |');
  });
});
