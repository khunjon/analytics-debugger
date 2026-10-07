import { describe, expect, it } from 'vitest';
import { MAX_PAYLOAD, sanitizePageEvent } from '@/lib/page-event';

describe('page events from the relay', () => {
  it('keeps the fields of each kind', () => {
    const events = [
      { kind: 'datalayer', source: 'dataLayer', ts: 1, payload: '{"event":"x"}', late: true },
      { kind: 'interaction', action: 'click', ts: 2, text: 'Buy', selector: 'button.buy', tag: 'button', href: 'https://example.com/', dataAttrs: { 'data-sku': '1' }, synthetic: true },
      { kind: 'rule', phase: 'condition-failed', run: 3, ts: 3, ruleName: 'Page load', ruleId: 'RL1', component: 'core/src/lib/conditions/path.js', settings: '{}', negate: true },
      { kind: 'env', source: 'gtm', ts: 4, payload: '{"containers":[]}' },
    ];
    for (const e of events) expect(sanitizePageEvent(e)).toEqual(e);
  });

  it('rejects kinds a page cannot send', () => {
    expect(sanitizePageEvent({ kind: 'hit', vendor: 'ga4', url: 'https://example.com/g/collect', ts: 1 })).toBeUndefined();
    expect(sanitizePageEvent({ kind: 'nav', url: 'https://example.com/', ts: 1 })).toBeUndefined();
    expect(sanitizePageEvent({ kind: 'env', source: 'other', ts: 1, payload: '{}' })).toBeUndefined();
    expect(sanitizePageEvent({ kind: 'datalayer', source: 'dataLayer', ts: 'now', payload: '{}' })).toBeUndefined();
    expect(sanitizePageEvent('{"kind":"datalayer"}')).toBeUndefined();
  });

  it('drops fields the background assigns and fields that do not belong', () => {
    const e = sanitizePageEvent({ kind: 'datalayer', source: 'dataLayer', ts: 1, payload: '{}', id: 'x', pageId: 'p', seq: 0, vendor: 'ga4' });
    expect(e).toEqual({ kind: 'datalayer', source: 'dataLayer', ts: 1, payload: '{}' });
  });

  it('replaces an oversized payload with a note', () => {
    const e = sanitizePageEvent({ kind: 'datalayer', source: 'digitalData', ts: 1, payload: 'x'.repeat(MAX_PAYLOAD + 1) });
    expect(e).toMatchObject({ payload: '"[payload too large: 500 KB]"' });
  });
});
