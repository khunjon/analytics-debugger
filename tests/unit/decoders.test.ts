import { describe, expect, it } from 'vitest';
import { decodeRequest, matchVendor } from '@/lib/decoders';
import type { DecodedEvent } from '@/lib/decoders';

const rowsOf = (d: DecodedEvent, title: string) => d.groups.find((g) => g.title === title)?.rows ?? [];
const valueOf = (d: DecodedEvent, key: string) =>
  d.groups.flatMap((g) => g.rows).find((r) => r.key === key)?.value;

describe('vendor matching', () => {
  it.each([
    ['https://metrics.example.com/b/ss/exampleprod/1/JS-2.27.0/s123?AQB=1', 'adobe-analytics'],
    ['https://example.sc.omtrdc.net/b/ss/rsid/10/JS-2.27.0/s1', 'adobe-analytics'],
    ['https://edge.adobedc.net/ee/v1/interact?configId=abc', 'adobe-websdk'],
    ['https://edge.adobedc.net/ee/irl1/v1/collect?configId=abc', 'adobe-websdk'],
    ['https://data.example.com/ee/or2/v1/interact?configId=abc', 'adobe-websdk'],
    ['https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123', 'ga4'],
    ['https://www.example.com/g/collect?v=2&tid=G-ABC123', 'ga4'],
    ['https://sst.example.com/data?v=2&tid=G-ABC123&en=page_view', 'ga4'],
  ])('%s -> %s', (url, vendor) => {
    expect(matchVendor(url)).toBe(vendor);
  });

  it.each([
    'https://stats.g.doubleclick.net/g/collect?v=2&tid=G-ABC123',
    'https://www.google-analytics.com/collect?v=1&tid=UA-1-1',
    'https://www.example.com/products/widget',
    'https://edge.adobedc.net/ee/v1/identity/acquire',
    'chrome-extension://abc/sidepanel.html',
  ])('ignores %s', (url) => {
    expect(matchVendor(url)).toBeUndefined();
  });
});

describe('Adobe Analytics', () => {
  const pageView =
    'https://metrics.example.com/b/ss/exampleprod,exampleglobal/1/JS-2.27.0-LEWM/s91234567890?AQB=1&ndh=1' +
    '&mid=12345678901234567890&ce=UTF-8&pageName=pdp%3Awidget-a' +
    '&g=https%3A%2F%2Fwww.example.com%2Fproducts%2Fwidget-a&cc=USD&ch=products' +
    '&events=prodView%2Cevent5%3D2&products=%3BSKU123%3B1%3B19.99%3Bevent10%3D5%3BeVar20%3Dred%2C%3BSKU456' +
    '&c.&a.&activitymap.&page=home&link=Add%20to%20cart&.activitymap&.a&site.&section=pdp&.site&cartId=abc&.c' +
    '&v1=D%3DpageName&v12=search%20term&v2=x&c5=pdp&v0=email_spring&s=1440x900&AQE=1';

  it('decodes a page view', () => {
    const [d] = decodeRequest('adobe-analytics', { url: pageView, method: 'GET' });
    expect(d!.eventName).toBe('s.t');
    expect(d!.detail).toBe('pdp:widget-a');
    expect(d!.account).toBe('exampleprod,exampleglobal');
    expect(d!.summary).toContain('events=prodView,event5=2');
    expect(valueOf(d!, 'version')).toBe('JS-2.27.0-LEWM');
    expect(valueOf(d!, 'v0')).toBe('email_spring');
  });

  it('labels and numerically sorts eVars and props', () => {
    const [d] = decodeRequest('adobe-analytics', { url: pageView, method: 'GET' });
    const evars = rowsOf(d!, 'eVars');
    expect(evars.map((r) => r.label)).toEqual(['eVar1', 'eVar2', 'eVar12']);
    expect(rowsOf(d!, 'Props')).toEqual([{ key: 'c5', label: 'prop5', value: 'pdp' }]);
  });

  it('resolves D= dynamic variables against the same hit', () => {
    const [d] = decodeRequest('adobe-analytics', { url: pageView, method: 'GET' });
    const evar1 = rowsOf(d!, 'eVars').find((r) => r.key === 'v1');
    expect(evar1?.note).toBe('= pdp:widget-a');
  });

  it('rebuilds nested context data and splits out Activity Map', () => {
    const [d] = decodeRequest('adobe-analytics', { url: pageView, method: 'GET' });
    expect(rowsOf(d!, 'Context data')).toEqual([
      { key: 'site.section', value: 'pdp' },
      { key: 'cartId', value: 'abc' },
    ]);
    expect(rowsOf(d!, 'Activity Map').map((r) => [r.key, r.value])).toEqual([
      ['a.activitymap.page', 'home'],
      ['a.activitymap.link', 'Add to cart'],
    ]);
  });

  it('parses the products string', () => {
    const [d] = decodeRequest('adobe-analytics', { url: pageView, method: 'GET' });
    expect(rowsOf(d!, 'Products')).toEqual([
      { key: 'product 1', value: 'SKU123', note: 'qty 1 · price 19.99 · event10=5 · eVar20=red' },
      { key: 'product 2', value: 'SKU456', note: undefined },
    ]);
  });

  it('decodes a custom link hit sent as POST', () => {
    const [d] = decodeRequest('adobe-analytics', {
      url: 'https://metrics.example.com/b/ss/exampleprod/1/JS-2.27.0/s1',
      method: 'POST',
      body: 'AQB=1&pe=lnk_o&pev2=add%20to%20cart&events=scAdd&products=%3BSKU123%3B1%3B19.99&AQE=1',
    });
    expect(d!.eventName).toBe('s.tl');
    expect(d!.detail).toBe('add to cart (custom link)');
    expect(rowsOf(d!, 'Link').find((r) => r.key === 'pe')?.note).toBe('custom link');
  });
});

describe('GA4', () => {
  it('decodes a single event in the URL', () => {
    const [d, ...rest] = decodeRequest('ga4', {
      url:
        'https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&gtm=45je5a10v9&gcs=G101&cid=123.456' +
        '&sid=1727800000&sct=3&seg=1&dl=https%3A%2F%2Fwww.example.com%2F&dt=Home&en=page_view&_ss=1' +
        '&ep.page_type=home&epn.load_ms=420&up.member_level=gold',
      method: 'POST',
    });
    expect(rest).toHaveLength(0);
    expect(d!.eventName).toBe('page_view');
    expect(d!.detail).toBe('Home');
    expect(d!.account).toBe('G-ABC123');
    expect(rowsOf(d!, 'Event parameters')).toEqual([
      { key: 'ep.page_type', label: 'page_type', value: 'home', note: undefined },
      { key: 'epn.load_ms', label: 'load_ms', value: '420', note: 'number' },
    ]);
    expect(rowsOf(d!, 'User properties')[0]).toMatchObject({ label: 'member_level', value: 'gold' });
    expect(rowsOf(d!, 'Consent').find((r) => r.key === 'gcs')?.note).toBe(
      'ad_storage denied, analytics_storage granted',
    );
  });

  it('splits a batched POST into events that share the URL params', () => {
    const events = decodeRequest('ga4', {
      url: 'https://www.example.com/g/collect?v=2&tid=G-ABC123&cid=123.456&dl=https%3A%2F%2Fwww.example.com%2Fp&dt=PDP&cu=USD',
      method: 'POST',
      body:
        'en=view_item&_et=5&epn.value=19.99&pr1=idSKU123~nmWidget%20A~pr19.99~qt1~k0color~v0red\r\n' +
        'en=add_to_cart&ep.method=button&pr1=idSKU123~nmWidget%20A~qt2',
    });
    expect(events.map((e) => e.eventName)).toEqual(['view_item', 'add_to_cart']);
    expect(events.every((e) => e.account === 'G-ABC123')).toBe(true);
    expect(valueOf(events[1]!, 'dl')).toBe('https://www.example.com/p');
    expect(valueOf(events[1]!, 'epn.value')).toBeUndefined();
    const item = rowsOf(events[0]!, 'Ecommerce').find((r) => r.key === 'pr1');
    expect(item).toEqual({
      key: 'pr1',
      label: 'Item 1',
      value: 'Widget A',
      note: 'item_id: SKU123 · price: 19.99 · quantity: 1 · color: red',
    });
  });
});

describe('Adobe Web SDK', () => {
  const body = JSON.stringify({
    events: [
      {
        xdm: {
          eventType: 'web.webpagedetails.pageViews',
          web: { webPageDetails: { name: 'home', URL: 'https://www.example.com/' } },
          identityMap: { ECID: [{ id: '123', primary: true }] },
          _experience: {
            analytics: {
              customDimensions: { eVars: { eVar5: 'logged in' } },
              event1to100: { event3: { value: 1 } },
            },
          },
          device: { screenHeight: 900 },
          timestamp: '2026-10-01T17:02:11.000Z',
        },
        data: { __adobe: { analytics: { pageName: 'home', eVar1: 'hello', events: 'event1' } }, custom: 'x' },
      },
      {
        xdm: { eventType: 'web.webinteraction.linkClicks', web: { webInteraction: { name: 'Add to cart', type: 'other' } } },
      },
    ],
    meta: { state: { domain: 'example.com' } },
  });

  it('decodes each event in the request', () => {
    const events = decodeRequest('adobe-websdk', {
      url: 'https://edge.adobedc.net/ee/irl1/v1/interact?configId=abc-123&requestId=r-1',
      method: 'POST',
      body,
    });
    expect(events.map((e) => [e.eventName, e.detail])).toEqual([
      ['web.webpagedetails.pageViews', 'home'],
      ['web.webinteraction.linkClicks', 'Add to cart'],
    ]);
    const [page] = events;
    expect(page!.account).toBe('abc-123');
    expect(page!.summary).toContain('events=event1');
    expect(rowsOf(page!, 'Adobe Analytics (data.__adobe.analytics)').map((r) => r.key)).toEqual([
      'pageName',
      'eVar1',
      'events',
    ]);
    expect(rowsOf(page!, 'XDM analytics fields').map((r) => r.label)).toEqual(['eVar5', 'event3']);
    expect(rowsOf(page!, 'Identity')[0]).toMatchObject({ key: 'identityMap.ECID[0].id', value: '123' });
    expect(rowsOf(page!, 'Data')).toEqual([{ key: 'custom', label: undefined, value: 'x' }]);
    expect(rowsOf(page!, 'Auto-collected').map((r) => r.key)).toEqual(['device.screenHeight', 'timestamp']);
  });

  it('survives an unreadable body', () => {
    const [d] = decodeRequest('adobe-websdk', {
      url: 'https://edge.adobedc.net/ee/v1/collect?configId=abc',
      method: 'POST',
      body: 'not json',
    });
    expect(d!.eventName).toBe('(unreadable body)');
  });
});
