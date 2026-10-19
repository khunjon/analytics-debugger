import { describe, expect, it } from 'vitest';
import { analyze } from '@/lib/checks';
import { harToTimeline, NO_PAGE, timelineToHar, type Har } from '@/lib/har';
import type { TabTimeline, TimelineEvent } from '@/lib/types';
import { buildGroups } from '@/lib/view';

const T0 = Date.UTC(2026, 9, 19, 10, 0, 0);
const CREATOR = { name: 'Analytics Debugger', version: '0.2.0' };

/** A tab with two pages: page-load hits, a data layer push, a click and its link hit, a rule, an env snapshot. */
function capture(): TabTimeline {
  const events: TimelineEvent[] = [
    // A request's timestamp can be a hair before its page's navigation commit.
    {
      kind: 'hit',
      id: 'e0',
      ts: T0 - 2,
      pageId: 'p1',
      vendor: 'adobe-target',
      requestId: '100',
      url: 'https://example.tt.omtrdc.net/rest/v1/delivery?client=example&sessionId=s1&version=2.11.0',
      method: 'POST',
      body: '{"execute":{"pageLoad":{}}}',
      resourceType: 'xmlhttprequest',
      status: 200,
    },
    { kind: 'env', id: 'e1', ts: T0 + 5, pageId: 'p1', source: 'adobe-tags', payload: '{"property":"Fixture Store","environment":"development"}' },
    { kind: 'datalayer', id: 'e2', ts: T0 + 10, pageId: 'p1', source: 'adobeDataLayer', payload: '{"page":{"name":"pdp:widget-a"},"event":"page"}' },
    { kind: 'rule', id: 'e3', ts: T0 + 10, pageId: 'p1', phase: 'triggered', run: 1, ruleName: 'Page load' },
    { kind: 'rule', id: 'e4', ts: T0 + 10, pageId: 'p1', phase: 'completed', run: 1, ruleName: 'Page load' },
    {
      kind: 'hit',
      id: 'e5',
      ts: T0 + 20,
      pageId: 'p1',
      vendor: 'adobe-analytics',
      requestId: '101',
      url: 'https://example.sc.omtrdc.net/b/ss/exampleprod/1/JS-2.27.0/s111?AQB=1&pageName=pdp%3Awidget-a&v1=D%3DpageName&events=prodView&products=%3BSKU-1&AQE=1',
      method: 'GET',
      resourceType: 'image',
      status: 200,
    },
    {
      kind: 'hit',
      id: 'e6',
      ts: T0 + 25,
      pageId: 'p1',
      vendor: 'adobe-websdk',
      requestId: '102',
      url: 'https://edge.adobedc.net/ee/v1/interact?configId=aaaaaaaa-1111-2222-3333-444444444444',
      method: 'POST',
      body: '{"events":[{"xdm":{"eventType":"web.webpagedetails.pageViews","web":{"webPageDetails":{"name":"pdp:widget-a"}}}}]}',
      resourceType: 'fetch',
      status: 200,
    },
    { kind: 'interaction', id: 'e7', ts: T0 + 900, pageId: 'p1', action: 'click', text: 'Add to cart', selector: '#atc', tag: 'button' },
    {
      kind: 'hit',
      id: 'e8',
      ts: T0 + 950,
      pageId: 'p1',
      vendor: 'ga4',
      requestId: '103',
      url: 'https://www.example.com/g/collect?v=2&tid=G-TEST123&cid=1.2&en=add_to_cart',
      method: 'POST',
      body: 'en=add_to_cart&ep.list=pdp',
      resourceType: 'ping',
      error: 'net::ERR_BLOCKED_BY_CLIENT',
    },
    { kind: 'nav', id: 'e9', ts: T0 + 1000, pageId: 'p1', url: 'https://www.example.com/cart', how: 'history' },
    {
      kind: 'hit',
      id: 'e10',
      ts: T0 + 5000,
      pageId: 'p2',
      vendor: 'adobe-analytics',
      requestId: '104',
      url: 'https://example.sc.omtrdc.net/b/ss/exampleprod/1/JS-2.27.0/s333?AQB=1&pageName=cart&AQE=1',
      method: 'GET',
      resourceType: 'image',
      status: 200,
      redirectedFrom: 'https://example.sc.omtrdc.net/b/ss/exampleprod/1/JS-2.27.0/s333?AQB=1&pageName=cart',
    },
  ];
  events.forEach((e, i) => (e.seq = i));
  return {
    tabId: 7,
    rev: 3,
    updated: T0 + 6000,
    pages: [
      { id: 'p1', ts: T0, url: 'https://www.example.com/products/widget-a', committed: true },
      { id: 'p2', ts: T0 + 4000, url: 'https://www.example.com/cart', committed: true, transition: 'link' },
    ],
    events,
    docToPage: {},
    nextSeq: events.length,
  };
}

/** Events with ids replaced by what they mean, so two timelines compare by content. */
function normalized(t: TabTimeline) {
  const pageUrl = new Map(t.pages.map((p) => [p.id, p.url]));
  return {
    pages: t.pages.map((p) => ({ ts: p.ts, url: p.url })),
    events: t.events.map(({ id: _id, seq: _seq, pageId, requestId: _r, ...e }: TimelineEvent & { requestId?: string }) => ({
      ...e,
      page: pageUrl.get(pageId),
    })),
  };
}

const roundTrip = (har: Har) => harToTimeline(JSON.parse(JSON.stringify(har)), 'test');

describe('HAR export', () => {
  it('writes each hit as a HAR 1.2 entry on its page', () => {
    const har = timelineToHar(capture(), CREATOR);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual(CREATOR);
    expect(har.log.pages?.map((p) => [p.id, p.title, p.startedDateTime])).toEqual([
      ['p1', 'https://www.example.com/products/widget-a', '2026-10-19T10:00:00.000Z'],
      ['p2', 'https://www.example.com/cart', '2026-10-19T10:00:04.000Z'],
    ]);
    expect(har.log.entries).toHaveLength(5);
    const [, pageView, edge, blocked] = har.log.entries;
    expect(pageView).toMatchObject({
      pageref: 'p1',
      startedDateTime: '2026-10-19T10:00:00.020Z',
      request: { method: 'GET', headersSize: -1, bodySize: 0 },
      response: { status: 200 },
      _resourceType: 'image',
    });
    expect(pageView!.request.queryString).toContainEqual({ name: 'pageName', value: 'pdp:widget-a' });
    expect(pageView!.request.postData).toBeUndefined();
    expect(edge!.request.postData?.mimeType).toBe('application/json');
    expect(blocked!.request.postData).toEqual({ mimeType: 'application/x-www-form-urlencoded', text: 'en=add_to_cart&ep.list=pdp' });
    expect(blocked!.response).toMatchObject({ status: 0, _error: 'net::ERR_BLOCKED_BY_CLIENT' });
    // The rest of the timeline rides along in a custom field.
    expect(har.log._analyticsDebugger?.events.map((e) => e.kind)).toEqual(['env', 'datalayer', 'rule', 'rule', 'interaction', 'nav']);
  });

  it('exports just the pages asked for', () => {
    const har = timelineToHar(capture(), CREATOR, new Set(['p2']));
    expect(har.log.pages?.map((p) => p.id)).toEqual(['p2']);
    expect(har.log.entries.map((e) => e.pageref)).toEqual(['p2']);
    expect(har.log._analyticsDebugger?.events).toEqual([]);
  });
});

describe('HAR import', () => {
  it('round-trips an export into the same timeline', () => {
    const original = capture();
    const { timeline, creator, ignored } = roundTrip(timelineToHar(original, CREATOR));
    expect(creator).toBe('Analytics Debugger 0.2.0');
    expect(ignored).toBe(0);
    expect(normalized(timeline)).toEqual(normalized(original));
    expect(timeline.events.map((e) => e.seq)).toEqual(original.events.map((_, i) => i));
    // Fresh ids, since decoded rows are cached by id.
    expect(timeline.events.every((e) => e.id.startsWith('test:'))).toBe(true);
  });

  it('round-trips into the same rows and checks', () => {
    const original = capture();
    const { timeline } = roundTrip(timelineToHar(original, CREATOR));
    const rows = (t: TabTimeline) => buildGroups(t).map((g) => ({ url: g.page.url, env: g.env, rows: g.rows.map((r) => [r.type, r.ts]) }));
    expect(rows(timeline)).toEqual(rows(original));
    const issues = (t: TabTimeline) => [...analyze(buildGroups(t)).values()].map((list) => list.map((i) => i.message));
    expect(issues(timeline)).toEqual(issues(original));
  });

  it('rejects files that are not HAR', () => {
    expect(() => harToTimeline({ hello: 'world' })).toThrow(/Not a HAR file/);
    expect(() => harToTimeline('nope')).toThrow(/Not a HAR file/);
  });

  it('drops custom events of unknown kinds or on unknown pages', () => {
    const har = timelineToHar(capture(), CREATOR);
    har.log._analyticsDebugger!.events.push(
      { kind: 'hit', id: 'x', ts: T0, pageId: 'p1' } as unknown as TimelineEvent,
      { kind: 'datalayer', id: 'y', ts: T0, pageId: 'nowhere', source: 'dataLayer', payload: '{}' },
    );
    const { timeline } = roundTrip(har);
    expect(timeline.events).toHaveLength(capture().events.length);
  });
});

/** A Charles Proxy session: a web page in a desktop browser, then an iOS app. Made-up IDs and domains. */
const CHARLES_HAR = {
  log: {
    version: '1.2',
    creator: { name: 'Charles Proxy', version: '5.0' },
    entries: [
      {
        startedDateTime: '2026-10-19T17:00:00.000+07:00',
        time: 120,
        request: {
          method: 'GET',
          url: 'https://www.example.com/products/widget-a',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [
            { name: 'Accept', value: 'text/html' },
            { name: 'Sec-Fetch-Dest', value: 'document' },
          ],
          queryString: [],
          headersSize: 410,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
          content: { size: 5120, mimeType: 'text/html; charset=utf-8', text: '<!doctype html><title>Widget A</title>' },
          redirectURL: '',
          headersSize: 220,
          bodySize: 5120,
        },
        cache: {},
        timings: { dns: 1, connect: 10, ssl: 8, send: 0, wait: 90, receive: 11 },
      },
      {
        startedDateTime: '2026-10-19T17:00:00.300+07:00',
        time: 30,
        request: {
          method: 'GET',
          url: 'https://www.example.com/static/app.js',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [{ name: 'Referer', value: 'https://www.example.com/products/widget-a' }],
          queryString: [],
          headersSize: 300,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: { size: 900, mimeType: 'application/javascript' },
          redirectURL: '',
          headersSize: 200,
          bodySize: 900,
        },
        cache: {},
        timings: { send: 0, wait: 20, receive: 10 },
      },
      {
        // AppMeasurement's first request gets a 302 for the ID; Charles records both legs.
        startedDateTime: '2026-10-19T17:00:00.500+07:00',
        time: 40,
        request: {
          method: 'GET',
          url: 'https://example.sc.omtrdc.net/b/ss/exampleprod/1/JS-2.27.0/s9001?AQB=1&pageName=pdp%3Awidget-a&events=scAdd&AQE=1',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [{ name: 'Referer', value: 'https://www.example.com/' }],
          queryString: [],
          headersSize: 500,
          bodySize: 0,
        },
        response: {
          status: 302,
          statusText: 'Found',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: { size: 0, mimeType: '' },
          redirectURL: '/b/ss/exampleprod/1/JS-2.27.0/s9001?AQB=1&pageName=pdp%3Awidget-a&events=scAdd&AQE=1&mid=1',
          headersSize: 200,
          bodySize: 0,
        },
        cache: {},
        timings: { send: 0, wait: 30, receive: 10 },
      },
      {
        startedDateTime: '2026-10-19T17:00:00.560+07:00',
        time: 40,
        request: {
          method: 'GET',
          url: 'https://example.sc.omtrdc.net/b/ss/exampleprod/1/JS-2.27.0/s9001?AQB=1&pageName=pdp%3Awidget-a&events=scAdd&AQE=1&mid=1',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [{ name: 'Referer', value: 'https://www.example.com/' }],
          queryString: [],
          headersSize: 500,
          bodySize: 0,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: { size: 43, mimeType: 'image/gif' },
          redirectURL: '',
          headersSize: 200,
          bodySize: 43,
        },
        cache: {},
        timings: { send: 0, wait: 30, receive: 10 },
      },
      {
        // GA4 batch with form params instead of text.
        startedDateTime: '2026-10-19T17:00:01.000+07:00',
        time: 25,
        request: {
          method: 'POST',
          url: 'https://www.example.com/g/collect?v=2&tid=G-EXAMPLE1&cid=555.666',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [{ name: 'Referer', value: 'https://www.example.com/products/widget-a' }],
          queryString: [],
          postData: { mimeType: 'text/plain', params: [
              { name: 'en', value: 'view_item' },
              { name: 'ep.contact', value: 'jane.doe@example.com' },
            ] },
          headersSize: 400,
          bodySize: 30,
        },
        response: {
          status: 204,
          statusText: 'No Content',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: { size: 0, mimeType: '' },
          redirectURL: '',
          headersSize: 100,
          bodySize: 0,
        },
        cache: {},
        timings: { send: 0, wait: 20, receive: 5 },
      },
      {
        // The iOS app: Mobile SDK hits have no Referer.
        startedDateTime: '2026-10-19T17:05:00.000+07:00',
        time: 80,
        request: {
          method: 'POST',
          url: 'https://example.sc.omtrdc.net/b/ss/exampleappprod/0/IOSN030100/s4242',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [{ name: 'User-Agent', value: 'ExampleApp/3.1 CFNetwork' }],
          queryString: [],
          postData: {
            mimeType: 'application/x-www-form-urlencoded',
            text: 'ndh=1&pageName=App%3AHome&c.&a.&AppID=ExampleApp%203.1&.a&.c&events=event5',
          },
          headersSize: 300,
          bodySize: 80,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: { size: 0, mimeType: 'application/json' },
          redirectURL: '',
          headersSize: 100,
          bodySize: 0,
        },
        cache: {},
        timings: { send: 0, wait: 70, receive: 10 },
      },
      {
        startedDateTime: '2026-10-19T17:05:00.400+07:00',
        time: 60,
        request: {
          method: 'POST',
          url: 'https://edge.adobedc.net/ee/v1/interact?configId=aaaaaaaa-1111-2222-3333-444444444444',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          queryString: [],
          postData: {
            mimeType: 'application/json',
            text: '{"events":[{"xdm":{"eventType":"web.webpagedetails.pageViews","web":{"webPageDetails":{"name":"App:Home"}}}}]}',
          },
          headersSize: 300,
          bodySize: 120,
        },
        response: {
          status: 200,
          statusText: 'OK',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: [],
          content: { size: 2, mimeType: 'application/json' },
          redirectURL: '',
          headersSize: 100,
          bodySize: 2,
        },
        cache: {},
        timings: { send: 0, wait: 50, receive: 10 },
      },
    ],
  },
};

describe('HAR import from Charles', () => {
  const { timeline, creator, ignored } = harToTimeline(CHARLES_HAR, 'charles');
  const groups = buildGroups(timeline);

  it('keeps the analytics requests and names the tool', () => {
    expect(creator).toBe('Charles Proxy 5.0');
    expect(ignored).toBe(1); // app.js
    expect(timeline.events.map((e) => (e.kind === 'hit' ? e.vendor : e.kind))).toEqual([
      'adobe-analytics',
      'ga4',
      'adobe-analytics',
      'adobe-websdk',
    ]);
  });

  it('groups by the document request and referrer, and app hits on their own page', () => {
    expect(timeline.pages.map((p) => p.url)).toEqual(['https://www.example.com/products/widget-a', NO_PAGE]);
    expect(groups.map((g) => g.rows.length)).toEqual([2, 2]);
    expect(timeline.pages[0]!.ts).toBe(Date.UTC(2026, 9, 19, 10, 0, 0));
  });

  it('folds a redirect into the request it led to', () => {
    const aa = timeline.events[0]!;
    expect(aa).toMatchObject({
      kind: 'hit',
      status: 200,
      redirectedFrom: 'https://example.sc.omtrdc.net/b/ss/exampleprod/1/JS-2.27.0/s9001?AQB=1&pageName=pdp%3Awidget-a&events=scAdd&AQE=1',
    });
  });

  it('decodes and checks the hits like live ones', () => {
    const hits = groups.flatMap((g) => g.rows).filter((r) => r.type === 'hit');
    expect(hits.map((r) => r.decoded.eventName)).toEqual(['s.t', 'view_item', 's.t', 'web.webpagedetails.pageViews']);
    const app = hits[2]!.decoded;
    expect(app.groups.flatMap((g) => g.rows).find((r) => r.key === 'a.AppID')?.value).toBe('ExampleApp 3.1');
    const issues = analyze(groups);
    const messages = (i: number) => (issues.get(hits[i]!.key) ?? []).map((x) => x.message).join('\n');
    expect(messages(0)).toMatch(/scAdd without products/);
    expect(messages(1)).toMatch(/email address in contact/);
  });
});

describe('HAR import from DevTools', () => {
  it('uses the HAR pages', () => {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'WebInspector', version: '537.36' },
        pages: [
          { startedDateTime: '2026-10-19T10:00:00.000Z', id: 'page_1', title: 'https://www.example.com/', pageTimings: {} },
          { startedDateTime: '2026-10-19T10:01:00.000Z', id: 'page_2', title: 'https://www.example.com/next', pageTimings: {} },
        ],
        entries: ['page_1', 'page_2', 'page_1'].map((pageref, i) => ({
          pageref,
          startedDateTime: new Date(Date.UTC(2026, 9, 19, 10, i, 30)).toISOString(),
          time: 10,
          _resourceType: 'ping',
          request: { method: 'GET', url: `https://www.example.com/g/collect?v=2&tid=G-TEST1&en=e${i}`, headers: [] },
          response: { status: 204, content: {} },
        })),
      },
    };
    const { timeline } = harToTimeline(har, 'dt');
    expect(timeline.pages.map((p) => p.url)).toEqual(['https://www.example.com/', 'https://www.example.com/next']);
    expect(timeline.events.map((e) => e.pageId)).toEqual(['dt:p0', 'dt:p1', 'dt:p0']);
  });
});
