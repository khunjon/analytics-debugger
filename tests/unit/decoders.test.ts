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
    ['https://edge.adobedc.net/ee/v1/privacy/set-consent?configId=abc', 'adobe-websdk'],
    ['https://example.tt.omtrdc.net/rest/v1/delivery?client=example&sessionId=s1&version=2.11.0', 'adobe-target'],
    ['https://example.tt.omtrdc.net/m2/example/mbox/json?mbox=target-global-mbox', 'adobe-target'],
    ['https://logx.optimizely.com/v1/events', 'optimizely'],
    ['https://www.facebook.com/tr/?id=1234567890&ev=PageView', 'pixel'],
    ['https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123456789/?label=abc', 'pixel'],
    ['https://www.google.com/pagead/1p-conversion/123456789/?label=abc', 'pixel'],
    ['https://ad.doubleclick.net/activity;src=1234;type=sales;cat=purch;ord=1', 'pixel'],
    ['https://bat.bing.com/action/0?ti=12345&evt=pageLoad', 'pixel'],
  ])('%s -> %s', (url, vendor) => {
    expect(matchVendor(url)).toBe(vendor);
  });

  it.each([
    'https://stats.g.doubleclick.net/g/collect?v=2&tid=G-ABC123',
    'https://www.google-analytics.com/collect?v=1&tid=UA-1-1',
    'https://www.example.com/products/widget',
    'https://edge.adobedc.net/ee/v1/identity/acquire',
    'chrome-extension://abc/sidepanel.html',
    'https://www.facebook.com/plugins/like.php',
    'https://cdn.optimizely.com/js/123.js',
    'https://example.tt.omtrdc.net/rest/v1/delivery',
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

  it('splits events into numeric values, serialization IDs and built-in names', () => {
    const [d] = decodeRequest('adobe-analytics', {
      url: 'https://m.example.com/b/ss/rs/1/JS-2.27.0/s1?events=purchase%2Cevent5%3D2.5%2Cevent1%3Aabc123%2CscAdd&-g=%2Fmore',
      method: 'GET',
    });
    expect(rowsOf(d!, 'Events')).toEqual([
      { key: 'events.purchase', value: '1', note: 'Orders, units and revenue' },
      { key: 'events.event5', value: '2.5', note: undefined },
      { key: 'events.event1', value: '1', note: 'serialized, ID abc123' },
      { key: 'events.scAdd', value: '1', note: 'Cart additions' },
    ]);
    expect(rowsOf(d!, 'Page').find((r) => r.key === '-g')?.label).toBe('Page URL (continued)');
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

  it('decodes the Consent Mode v2 signals in gcd', () => {
    const [d] = decodeRequest('ga4', {
      url: 'https://www.example.com/g/collect?v=2&tid=G-ABC123&en=page_view&gcs=G100&gcd=13r3p3l3v5',
      method: 'POST',
    });
    expect(rowsOf(d!, 'Consent').filter((r) => r.key.startsWith('gcd.'))).toEqual([
      { key: 'gcd.ad_storage', label: 'ad_storage', value: 'granted', note: 'denied by default, granted by update' },
      { key: 'gcd.analytics_storage', label: 'analytics_storage', value: 'denied', note: 'denied by default, no update' },
      { key: 'gcd.ad_user_data', label: 'ad_user_data', value: 'not set', note: 'no default, no update' },
      { key: 'gcd.ad_personalization', label: 'ad_personalization', value: 'granted', note: 'granted by default and by update' },
    ]);
  });

  it('flags an item with neither item_id nor item_name', () => {
    const [d] = decodeRequest('ga4', {
      url: 'https://www.example.com/g/collect?v=2&tid=G-ABC123&en=add_to_cart&pr1=pr9.99~qt1',
      method: 'POST',
    });
    expect(rowsOf(d!, 'Ecommerce')[0]).toMatchObject({ value: '(no item_id or item_name)', note: 'price: 9.99 · quantity: 1' });
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

  it('decodes a setConsent call', () => {
    const [d] = decodeRequest('adobe-websdk', {
      url: 'https://edge.adobedc.net/ee/v1/privacy/set-consent?configId=abc',
      method: 'POST',
      body: JSON.stringify({
        consent: [{ standard: 'Adobe', version: '2.0', value: { collect: { val: 'n' }, metadata: { time: '2026-10-01T00:00:00Z' } } }],
        identityMap: { ECID: [{ id: '123' }] },
      }),
    });
    expect(d).toMatchObject({ eventName: 'setConsent', detail: 'collect=n', account: 'abc' });
    expect(valueOf(d!, 'consent[0].value.collect.val')).toBe('n');
  });
});

describe('Adobe Target', () => {
  it('decodes each part of an at.js 2 delivery request', () => {
    const events = decodeRequest('adobe-target', {
      url: 'https://example.tt.omtrdc.net/rest/v1/delivery?client=example&sessionId=s1&version=2.11.0',
      method: 'POST',
      body: JSON.stringify({
        id: { tntId: 'tnt-1', marketingCloudVisitorId: 'ecid-1' },
        experienceCloud: { analytics: { logging: 'server_side', supplementalDataId: 'sdid-1' } },
        execute: {
          pageLoad: { parameters: { pageType: 'pdp' } },
          mboxes: [{ index: 0, name: 'hero-banner', parameters: { slot: 'top' } }],
        },
        prefetch: { views: [{ parameters: {} }] },
        notifications: [{ id: 'n1', type: 'display', mbox: { name: 'hero-banner' }, tokens: ['t1'] }],
      }),
    });
    expect(events.map((e) => [e.eventName, e.detail])).toEqual([
      ['pageLoad', 'execute'],
      ['mbox: hero-banner', 'execute'],
      ['views', 'prefetch'],
      ['notification: display', 'hero-banner'],
    ]);
    expect(events[0]).toMatchObject({ account: 'example', summary: ['1 parameter'] });
    expect(valueOf(events[1]!, 'parameters.slot')).toBe('top');
    expect(valueOf(events[0]!, 'experienceCloud.analytics.logging')).toBe('server_side');
  });

  it('decodes an at.js 1 mbox request', () => {
    const [d] = decodeRequest('adobe-target', {
      url: 'https://example.tt.omtrdc.net/m2/example/mbox/json?mbox=target-global-mbox&mboxSession=s1&pageType=pdp',
      method: 'GET',
    });
    expect(d).toMatchObject({ eventName: 'mbox: target-global-mbox', account: 'example' });
    expect(rowsOf(d!, 'Parameters')).toEqual([{ key: 'pageType', value: 'pdp' }]);
  });
});

describe('Optimizely', () => {
  const body = JSON.stringify({
    account_id: '111',
    project_id: '222',
    revision: '42',
    client_name: 'js',
    visitors: [
      {
        visitor_id: 'oeu123',
        session_id: 'AUTO',
        attributes: [{ e: null, k: '', t: 'first_session', v: true }],
        snapshots: [
          {
            decisions: [{ c: '300', x: '301', v: '302', h: false }],
            events: [{ e: '300', y: 'client_activation', u: 'uuid-1', t: 1759300000000 }],
          },
        ],
      },
    ],
  });

  it('expands the compressed keys of Optimizely Web events', () => {
    const [d] = decodeRequest('optimizely', { url: 'https://logx.optimizely.com/v1/events', method: 'POST', body });
    expect(d).toMatchObject({ eventName: 'client_activation', account: '222', accountLabel: 'Project', summary: ['1 decision'] });
    expect(valueOf(d!, 'decisions[0].variation_id')).toBe('302');
    expect(valueOf(d!, 'entity_id')).toBe('300');
  });

  it('names IDs from the page snapshot', async () => {
    const { withOptimizelyNames } = await import('@/lib/decoders/optimizely');
    const [d] = decodeRequest('optimizely', { url: 'https://logx.optimizely.com/v1/events', method: 'POST', body });
    const named = withOptimizelyNames(d!, { '300': 'Hero test', '302': 'Variation B' });
    expect(named.detail).toBe('Hero test');
    expect(rowsOf(named, 'Decisions').find((r) => r.key.endsWith('variation_id'))?.note).toBe('Variation B');
  });
});

describe('Marketing pixels', () => {
  it.each([
    ['https://www.facebook.com/tr/?id=1234567890&ev=Purchase&cd[value]=10', 'Purchase', 'Meta Pixel', '1234567890'],
    ['https://googleads.g.doubleclick.net/pagead/viewthroughconversion/123456789/?label=AbC', 'conversion AbC', 'Google Ads', 'AW-123456789'],
    ['https://ad.doubleclick.net/activity;src=1234;type=sales;cat=purch;ord=1', 'sales/purch', 'Floodlight', 'DC-1234'],
    ['https://bat.bing.com/action/0?ti=12345&evt=pageLoad', 'pageLoad', 'Microsoft UET', '12345'],
  ])('%s', (url, eventName, detail, account) => {
    const [d] = decodeRequest('pixel', { url, method: 'GET' });
    expect(d).toMatchObject({ eventName, detail, account });
  });

  it('reads TikTok events from the JSON body', () => {
    const [d] = decodeRequest('pixel', {
      url: 'https://analytics.tiktok.com/api/v2/pixel',
      method: 'POST',
      body: JSON.stringify({ event: 'AddToCart', context: { pixel: { code: 'C123' } } }),
    });
    expect(d).toMatchObject({ eventName: 'AddToCart', detail: 'TikTok Pixel', account: 'C123' });
  });
});

describe('decode errors', () => {
  it('keep the body for inspection', async () => {
    const { decoders } = await import('@/lib/decoders');
    const ga4 = decoders.find((d) => d.id === 'ga4')!;
    const original = ga4.decode;
    ga4.decode = () => {
      throw new Error('boom');
    };
    try {
      const [d] = decodeRequest('ga4', { url: 'https://www.example.com/g/collect', method: 'POST', body: 'en=x' });
      expect(d).toMatchObject({ eventName: '(decode error)', summary: ['Error: boom'] });
      expect(valueOf(d!, 'body')).toBe('en=x');
    } finally {
      ga4.decode = original;
    }
  });
});
