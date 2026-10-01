import { describe, expect, it } from 'vitest';
import { analyze, hitIssues, looksLikeEmail } from '@/lib/checks';
import { applyAcdlPush, applyGtmPush, changedPaths, dataLayerStates } from '@/lib/datalayer-state';
import { decodeRequest } from '@/lib/decoders';
import { diffDecoded } from '@/lib/diff';
import type { DataLayerEvent, HitEvent, NavEvent, RuleEvent, TabTimeline, TimelineEvent } from '@/lib/types';
import { buildGroups, previousHit, rowCategory, ruleOutcome, type HitRow } from '@/lib/view';

let seq = 0;
const PAGE_TS = 1_000_000;

const hit = (vendor: HitEvent['vendor'], url: string, body?: string): HitEvent => ({
  kind: 'hit',
  id: `h${++seq}`,
  ts: PAGE_TS + seq,
  pageId: 'p1',
  vendor,
  requestId: `r${seq}`,
  url,
  method: body ? 'POST' : 'GET',
  body,
  resourceType: 'ping',
});
const aa = (query: string) => hit('adobe-analytics', `https://m.example.com/b/ss/rs/1/JS-2.27.0/s${seq}?AQB=1&${query}&AQE=1`);
const ga4 = (query: string) => hit('ga4', `https://www.example.com/g/collect?v=2&tid=G-TEST&${query}`);
const dl = (source: string, payload: unknown): DataLayerEvent => ({
  kind: 'datalayer',
  id: `dl${++seq}`,
  ts: PAGE_TS + seq,
  pageId: 'p1',
  source,
  payload: JSON.stringify(payload),
});
const nav = (): NavEvent => ({ kind: 'nav', id: `n${++seq}`, ts: PAGE_TS + seq, pageId: 'p1', url: 'https://www.example.com/next', how: 'history' });
const rule = (phase: RuleEvent['phase'], run: number, extra: Partial<RuleEvent> = {}): RuleEvent => ({
  kind: 'rule',
  id: `rule${++seq}`,
  ts: PAGE_TS + seq,
  pageId: 'p1',
  phase,
  run,
  ruleName: `Rule ${run}`,
  ...extra,
});

function timeline(events: TimelineEvent[]): TabTimeline {
  return {
    tabId: 1,
    rev: 1,
    updated: 0,
    pages: [{ id: 'p1', ts: PAGE_TS, url: 'https://www.example.com/', committed: true }],
    events,
    docToPage: {},
    nextSeq: events.length,
  };
}

const issuesOf = (events: TimelineEvent[]) => {
  const groups = buildGroups(timeline(events));
  const issues = analyze(groups);
  return groups[0]!.rows.map((r) => (issues.get(r.key) ?? []).map((i) => i.message));
};
const decode = (h: HitEvent) => decodeRequest(h.vendor, h)[0]!;
const messages = (h: HitEvent) => hitIssues(decode(h)).map((i) => i.message);

describe('checks on a single hit', () => {
  it('Adobe Analytics: byte limits, product events missing from events, purchase without purchaseID', () => {
    expect(messages(aa(`c1=${'é'.repeat(60)}&v1=${'x'.repeat(256)}&pageName=ok`))).toEqual([
      'eVar1 is 256 bytes; Adobe keeps the first 255',
      'prop1 is 120 bytes; Adobe keeps the first 100',
    ]);
    expect(messages(aa('events=purchase%2Cevent2&products=%3BSKU1%3B1%3B10%3Bevent10%3D5%7Cevent2%3D1'))).toEqual([
      'event10 set in products but not in events, so Adobe ignores it',
      'purchase without purchaseID: reloading the confirmation page can count the order twice',
    ]);
    expect(messages(aa('events=scAdd'))).toEqual(['scAdd without products, so no product gets credit']);
    expect(messages(aa('v1=D%3DpageName&pageName=home&events=purchase&products=%3BA&purchaseID=o1'))).toEqual([]);
  });

  it('GA4: name and value limits, ecommerce requirements', () => {
    expect(messages(ga4(`en=${'x'.repeat(41)}&ep.${'p'.repeat(41)}=1&ep.note=${'v'.repeat(101)}`))).toEqual([
      'Event name is 41 characters; GA4\'s limit is 40',
      `Parameter ${'p'.repeat(41)} has a 41-character name; GA4's limit is 40`,
      'note is 101 characters; GA4 keeps 100 (500 on GA4 360)',
    ]);
    expect(messages(ga4('en=purchase&epn.value=10&pr1=idA~nmWidget'))).toEqual([
      'purchase without transaction_id',
      'value without currency, so GA4 records no revenue',
    ]);
    expect(messages(ga4('en=add_to_cart&cu=USD&epn.value=10'))).toEqual(['No items, so item reports stay empty for this event']);
    expect(messages(ga4('en=view_item&pr1=pr10'))).toEqual(['Item 1 has neither item_id nor item_name']);
    expect(messages(ga4('en=google_thing'))).toEqual(['Event names starting with google_, ga_ or firebase_ are reserved']);
  });

  it('flags email addresses in any vendor, but not retina image names', () => {
    expect(messages(ga4('en=sign_up&ep.contact=jane.doe%40example.com'))).toEqual(['Looks like an email address in contact']);
    expect(looksLikeEmail('https://x.com/?e=jane%40example.co.uk')).toBe(true);
    expect(looksLikeEmail('/img/logo@2x.png')).toBe(false);
    expect(looksLikeEmail('pkg@1.2.3')).toBe(false);
  });
});

describe('checks across a page', () => {
  it('flags a duplicate page view, but not one after a route change', () => {
    const issues = issuesOf([aa('pageName=home'), aa('pageName=home'), nav(), aa('pageName=home')]);
    expect(issues[1]).toEqual([expect.stringMatching(/^Duplicate page view: same page as the s.t at \+0\.\d\ds$/)]);
    expect(issues[3]).toEqual([]);
    const ga = issuesOf([ga4('en=page_view&dl=https%3A%2F%2Fx.com%2F'), ga4('en=page_view&dl=https%3A%2F%2Fx.com%2F')]);
    expect(ga[1]![0]).toMatch(/^Duplicate page view/);
  });

  it('flags AA hits without mid when others on the page have one', () => {
    const issues = issuesOf([aa('pageName=home'), aa('pageName=other&mid=123')]);
    expect(issues[0]).toEqual([expect.stringMatching(/^No Experience Cloud ID/)]);
    expect(issues[1]).toEqual([]);
  });

  it('flags hits sent while consent was denied, and before it was given', () => {
    const denied = issuesOf([
      dl('dataLayer', ['consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied' }]),
      aa('pageName=home'),
      ga4('en=page_view&gcs=G100'),
      hit('pixel', 'https://www.facebook.com/tr/?id=1&ev=PageView'),
      dl('dataLayer', ['consent', 'update', { analytics_storage: 'granted', ad_storage: 'denied' }]),
      aa('pageName=home2'),
    ]);
    expect(denied[1]).toEqual([expect.stringMatching(/^Sent while analytics consent was denied \(gtag at \+0\.\d\ds: analytics_storage denied, ad_storage denied\)$/)]);
    // GA4 with Consent Mode sends cookieless pings by design.
    expect(denied[2]).toEqual([]);
    expect(denied[3]).toEqual([expect.stringMatching(/^Sent while advertising consent was denied/)]);
    expect(denied[5]).toEqual([]);

    const early = issuesOf([aa('pageName=home'), dl('dataLayer', { event: 'OneTrustGroupsUpdated', OnetrustActiveGroups: ',C0001,C0002,' })]);
    expect(early[0]).toEqual([expect.stringMatching(/^Sent before analytics consent was given \(OneTrust at \+0\.\d\ds\)$/)]);
  });

  it('reads Web SDK consent from the command and from setConsent calls', () => {
    const issues = issuesOf([
      dl('alloy()', { command: 'configure', options: { defaultConsent: 'pending' } }),
      hit('adobe-websdk', 'https://edge.adobedc.net/ee/v1/interact?configId=a', JSON.stringify({ events: [{ xdm: { eventType: 'x' } }] })),
      hit(
        'adobe-websdk',
        'https://edge.adobedc.net/ee/v1/privacy/set-consent?configId=a',
        JSON.stringify({ consent: [{ standard: 'Adobe', version: '2.0', value: { collect: { val: 'y' } } }] }),
      ),
      hit('adobe-websdk', 'https://edge.adobedc.net/ee/v1/interact?configId=a', JSON.stringify({ events: [{ xdm: { eventType: 'y' } }] })),
    ]);
    expect(issues[1]![0]).toMatch(/^Sent while analytics consent was denied \(Web SDK at .*defaultConsent pending\)$/);
    expect(issues[2]).toEqual([]);
    expect(issues[3]).toEqual([]);
  });
});

describe('data layer state', () => {
  it("merges dataLayer pushes the way GTM's data model does", () => {
    const state = {};
    applyGtmPush(state, { page: { type: 'pdp', tags: ['a', 'b'] } });
    applyGtmPush(state, { page: { name: 'Widget' }, 'user.id': 'u1' });
    applyGtmPush(state, { page: { tags: ['c'] } });
    applyGtmPush(state, ['event', 'add_to_cart', { value: 1 }]);
    applyGtmPush(state, ['set', { currency: 'USD' }]);
    applyGtmPush(state, { ecommerce: { items: [{ id: 1 }] } });
    applyGtmPush(state, { ecommerce: null });
    applyGtmPush(state, { page: { type: 'cart' }, _clear: true });
    expect(state).toEqual({ page: { type: 'cart' }, user: { id: 'u1' }, currency: 'USD', ecommerce: null });
  });

  it('merges adobeDataLayer pushes the way the Adobe Client Data Layer does', () => {
    const state = {};
    applyAcdlPush(state, { page: { name: 'home', tags: ['a', 'b'] }, cart: { size: 1 } });
    applyAcdlPush(state, { event: 'cart.add', eventInfo: { path: 'cart' }, page: { tags: ['c'] }, cart: null });
    expect(state).toEqual({ page: { name: 'home', tags: ['c'] } });
  });

  it('computes each layer in order, and takes digitalData snapshots as they are', () => {
    const states = dataLayerStates([
      dl('dataLayer', { a: 1 }),
      dl('adobeDataLayer', { page: { name: 'x' } }),
      dl('digitalData', { page: { pageInfo: { pageName: 'old' } } }),
      dl('dataLayer', { b: 2 }),
      dl('digitalData', { page: { pageInfo: { pageName: 'new' } } }),
      dl('_satellite.track', { identifier: 'x' }),
    ]);
    expect(states).toEqual([
      { source: 'dataLayer', state: { a: 1, b: 2 } },
      { source: 'adobeDataLayer', state: { page: { name: 'x' } } },
      { source: 'digitalData', state: { page: { pageInfo: { pageName: 'new' } } } },
    ]);
  });

  it('names what changed between two snapshots', () => {
    expect(changedPaths({ page: { pageInfo: { a: 1 } }, cart: [] }, { page: { pageInfo: { a: 2 } }, cart: [{ sku: 1 }], user: 'x' })).toEqual([
      'page.pageInfo',
      'cart',
      'user',
    ]);
  });
});

describe('comparing hits', () => {
  it('lists changed, added and removed variables, ignoring per-hit values', () => {
    const before = decode(aa('pageName=home&v1=a&v2=b&t=1'));
    const after = decode(aa('pageName=cart&v1=a&v3=c&t=2'));
    const diff = diffDecoded(before, after);
    expect(diff.changed).toEqual([{ key: 'pageName', label: 'Page name', before: 'home', after: 'cart' }]);
    expect(diff.added).toEqual([{ key: 'v3', label: 'eVar3', after: 'c' }]);
    expect(diff.removed).toEqual([{ key: 'v2', label: 'eVar2', before: 'b' }]);
    expect(diff.ignored).toEqual(['t']);
  });

  it('finds the previous hit of the same event', () => {
    const groups = buildGroups(timeline([aa('pageName=a'), aa('pe=lnk_o&pev2=x'), ga4('en=page_view'), aa('pageName=b')]));
    const rows = groups[0]!.rows as HitRow[];
    expect(previousHit(groups, rows[3]!)?.row.key).toBe(rows[0]!.key);
    expect(previousHit(groups, rows[0]!)).toBeUndefined();
  });
});

describe('timeline rows', () => {
  it('joins each rule run with its outcome', () => {
    const groups = buildGroups(
      timeline([
        rule('triggered', 1),
        rule('triggered', 2),
        rule('condition-failed', 2, { component: 'core/src/lib/conditions/valueComparison.js', negate: true }),
        rule('completed', 1),
        rule('completed', 9),
      ]),
    );
    const rows = groups[0]!.rows;
    expect(rows.map((r) => r.type === 'rule' && [r.event.ruleName, ruleOutcome(r).label])).toEqual([
      ['Rule 1', 'fired'],
      ['Rule 2', 'condition not met: not core: value comparison'],
      ['Rule 9', 'fired'],
    ]);
  });

  it('puts GTM internal events in their own category and reuses rows between builds', () => {
    const events = [dl('dataLayer', { event: 'gtm.dom' }), dl('dataLayer', { event: 'purchase' })];
    const first = buildGroups(timeline(events))[0]!.rows;
    expect(first.map(rowCategory)).toEqual(['gtm', 'datalayer']);
    const again = buildGroups(timeline(events))[0]!.rows;
    expect(again[0]).toBe(first[0]);
  });

  it("titles digitalData snapshots by what changed, and keeps each page's latest environment", () => {
    const groups = buildGroups(
      timeline([
        dl('digitalData', { page: { name: 'a' } }),
        dl('digitalData', { page: { name: 'b' }, cart: {} }),
        { kind: 'env', id: 'e1', ts: PAGE_TS + 100, pageId: 'p1', source: 'adobe-tags', payload: '{"environment":"staging"}' },
        { kind: 'env', id: 'e2', ts: PAGE_TS + 200, pageId: 'p1', source: 'adobe-tags', payload: '{"environment":"production"}' },
      ]),
    );
    const rows = groups[0]!.rows;
    expect(rows.map((r) => r.type === 'datalayer' && r.changed)).toEqual([undefined, ['page.name', 'cart']]);
    expect(groups[0]!.env['adobe-tags']).toEqual({ environment: 'production' });
  });
});
