import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installHooks } from '@/lib/page-hooks';
import type { PageEvent } from '@/lib/types';

describe('page hooks', () => {
  let win: any;
  let events: PageEvent[];
  let clock: number;
  let hooks: ReturnType<typeof installHooks>;

  beforeEach(() => {
    vi.useFakeTimers();
    win = {};
    events = [];
    clock = 1000;
  });

  afterEach(() => {
    hooks?.stop();
    vi.useRealTimers();
  });

  const install = () => {
    hooks = installHooks(win, (e) => events.push(e), { now: () => clock, dom: false });
  };
  const payloads = () => events.map((e) => (e.kind === 'datalayer' ? JSON.parse(e.payload) : null));
  const parsed = () => events.map((e) => (e.kind === 'datalayer' ? { ...e, payload: JSON.parse(e.payload) } : e));

  it('reports items already in the data layer as late, then pushes exactly', () => {
    win.dataLayer = [{ pageType: 'pdp' }];
    install();
    clock = 2000;
    win.dataLayer.push({ event: 'cart.add' });
    expect(parsed()).toEqual([
      { kind: 'datalayer', source: 'dataLayer', ts: 1000, payload: { pageType: 'pdp' }, late: true },
      { kind: 'datalayer', source: 'dataLayer', ts: 2000, payload: { event: 'cart.add' } },
    ]);
  });

  it('picks up a data layer created after install', () => {
    install();
    win.adobeDataLayer = [];
    vi.advanceTimersByTime(50);
    win.adobeDataLayer.push({ event: 'page loaded' });
    expect(parsed()).toMatchObject([{ source: 'adobeDataLayer', payload: { event: 'page loaded' } }]);
  });

  it('does not duplicate when GTM wraps our wrapper and we wrap GTM', () => {
    win.dataLayer = [];
    install();
    const ours = win.dataLayer.push;
    // GTM-style: keep the previous push and call through to it
    win.dataLayer.push = function (...args: unknown[]) {
      return ours.apply(this, args);
    };
    win.dataLayer.push({ event: 'one' });
    hooks.check();
    win.dataLayer.push({ event: 'two' });
    expect(payloads()).toEqual([{ event: 'one' }, { event: 'two' }]);
  });

  it('catches pushes from a replacement that bypasses the previous push', () => {
    win.adobeDataLayer = [];
    install();
    // Adobe Client Data Layer style: calls Array.prototype.push directly
    win.adobeDataLayer.push = function (...args: unknown[]) {
      return Array.prototype.push.apply(this, args);
    };
    win.adobeDataLayer.push({ event: 'missed by wrapper' });
    expect(events).toHaveLength(0);
    hooks.check();
    win.adobeDataLayer.push({ event: 'after rewrap' });
    expect(parsed()).toMatchObject([
      { payload: { event: 'missed by wrapper' }, late: true },
      { payload: { event: 'after rewrap' } },
    ]);
    expect((events[1] as { late?: boolean }).late).toBeUndefined();
  });

  it('restarts when the data layer array is replaced', () => {
    win.dataLayer = [{ a: 1 }];
    install();
    win.dataLayer = [{ b: 2 }];
    hooks.check();
    expect(payloads()).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('serializes gtag arguments objects as arrays', () => {
    win.dataLayer = [];
    install();
    (function gtag(..._args: unknown[]) {
      // eslint-disable-next-line prefer-rest-params
      win.dataLayer.push(arguments);
    })('event', 'add_to_cart', { value: 10 });
    expect(payloads()).toEqual([['event', 'add_to_cart', { value: 10 }]]);
  });

  it('records Adobe Tags direct calls', () => {
    const track = vi.fn();
    win._satellite = { track };
    install();
    win._satellite.track('add-to-cart', { sku: 'A1' });
    expect(track).toHaveBeenCalledWith('add-to-cart', { sku: 'A1' });
    expect(parsed()).toMatchObject([{ source: '_satellite.track', payload: { identifier: 'add-to-cart', detail: { sku: 'A1' } } }]);
  });

  it('leaves the alloy stub alone and wraps the loaded instance', () => {
    const stub = Object.assign(() => Promise.resolve(), { q: [] as unknown[] });
    win.__alloyNS = ['alloy'];
    win.alloy = stub;
    install();
    expect(win.alloy).toBe(stub);

    const instance = vi.fn(() => Promise.resolve());
    win.alloy = instance;
    hooks.check();
    win.alloy('sendEvent', { xdm: { eventType: 'web.webpagedetails.pageViews' } });
    expect(instance).toHaveBeenCalledOnce();
    expect(parsed()).toMatchObject([
      { source: 'alloy()', payload: { command: 'sendEvent', options: { xdm: { eventType: 'web.webpagedetails.pageViews' } } } },
    ]);
  });

  /** What Adobe Tags' Turbine does: assign _satellite, then call each monitor as rules run. */
  const loadTagsLibrary = () => {
    win._satellite = win._satellite || {};
    win._satellite.container = {};
    return (type: string, event: object) => {
      for (const m of win._satellite._monitors ?? []) m[type]?.(event);
    };
  };

  it('traces Adobe Tags rules from the first rule the library runs', () => {
    install();
    expect(win._satellite).toBeUndefined();
    const notify = loadTagsLibrary();
    // Back to a plain property once the library has assigned it.
    expect(Object.getOwnPropertyDescriptor(win, '_satellite')).toMatchObject({ writable: true });

    const pageLoad = { id: 'RL1', name: 'Page load' };
    const click = { id: 'RL2', name: 'Add to cart click' };
    const condition = { modulePath: 'core/src/lib/conditions/path.js', settings: { paths: [{ value: '/cart' }] }, negate: false };
    notify('ruleTriggered', { rule: pageLoad });
    notify('ruleTriggered', { rule: click });
    notify('ruleConditionFailed', { rule: click, condition });
    notify('ruleCompleted', { rule: pageLoad });

    expect(events.map((e) => e.kind === 'rule' && [e.phase, e.run, e.ruleName])).toEqual([
      ['triggered', 1, 'Page load'],
      ['triggered', 2, 'Add to cart click'],
      ['condition-failed', 2, 'Add to cart click'],
      ['completed', 1, 'Page load'],
    ]);
    expect(events[2]).toMatchObject({ component: 'core/src/lib/conditions/path.js', settings: '{"paths":[{"value":"/cart"}]}' });
  });

  it('adds the monitor to a _satellite that already exists', () => {
    win._satellite = { track: vi.fn() };
    install();
    win._satellite._monitors[0].ruleCompleted({ rule: { name: 'Late rule' } });
    expect(events).toMatchObject([{ kind: 'rule', phase: 'completed', ruleName: 'Late rule' }]);
  });

  it('never lets a broken rule event reach the library', () => {
    install();
    const notify = loadTagsLibrary();
    expect(() => notify('ruleTriggered', { rule: { get name() { throw new Error('no'); } } })).not.toThrow();
    expect(() => notify('ruleCompleted', null as never)).not.toThrow();
  });

  it('snapshots digitalData when it changes, and when a rule or direct call runs', () => {
    win.digitalData = { page: { name: 'home' } };
    install();
    clock = 1600;
    vi.advanceTimersByTime(600);
    win.digitalData.page.name = 'cart';
    clock = 1700;
    const notify = loadTagsLibrary();
    notify('ruleTriggered', { rule: { name: 'Cart view' } });
    const snapshots = events.filter((e) => e.kind === 'datalayer' && e.source === 'digitalData');
    expect(snapshots.map((e) => JSON.parse((e as { payload: string }).payload).page.name)).toEqual(['home', 'cart']);
    // The snapshot lands just before the rule that read it.
    expect(events.at(-2)).toMatchObject({ source: 'digitalData' });
    expect(events.at(-1)).toMatchObject({ kind: 'rule' });
  });

  it('reports the Adobe Tags build and GTM containers once each, and again when they change', () => {
    install();
    loadTagsLibrary();
    Object.assign(win._satellite, {
      property: { name: 'Example Store', id: 'PR1' },
      environment: { stage: 'staging' },
      buildInfo: { buildDate: '2026-09-28T14:02:00Z', turbineVersion: '28.2.0' },
    });
    win.google_tag_manager = { 'GTM-ABC123': {}, 'G-XYZ789': {}, dataLayer: {} };
    clock = 1600;
    hooks.snapshot();
    clock = 2200;
    hooks.snapshot();
    const env = events.filter((e) => e.kind === 'env').map((e) => ({ source: (e as { source: string }).source, info: JSON.parse((e as { payload: string }).payload) }));
    expect(env).toEqual([
      {
        source: 'adobe-tags',
        info: { property: 'Example Store', propertyId: 'PR1', environment: 'staging', buildDate: '2026-09-28T14:02:00Z', turbineVersion: '28.2.0' },
      },
      { source: 'gtm', info: { containers: [{ id: 'GTM-ABC123' }, { id: 'G-XYZ789' }] } },
    ]);
  });

  it('reports active Optimizely experiments with names for their IDs', () => {
    win.optimizely = {
      get: (what: string) =>
        what === 'state'
          ? { getExperimentStates: () => ({ '301': { experimentName: 'Hero test', variation: { id: '302', name: 'Variation B' } } }) }
          : { campaigns: { '300': { name: 'Hero campaign' } }, events: { '400': { apiName: 'add_to_cart' } } },
    };
    install();
    const [env] = events.filter((e) => e.kind === 'env');
    expect(JSON.parse((env as { payload: string }).payload)).toEqual({
      active: [{ experimentId: '301', experiment: 'Hero test', variationId: '302', variation: 'Variation B' }],
      names: { '300': 'Hero campaign', '400': 'add_to_cart', '301': 'Hero test', '302': 'Variation B' },
    });
  });

  it('polls fast while the page loads, then slows down', () => {
    install();
    win.dataLayer = [];
    vi.advanceTimersByTime(50);
    win.dataLayer.push({ event: 'early' });
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(70_000);
    // After a minute a replaced data layer is picked up within a second, not 50 ms.
    win.dataLayer = [{ event: 'replaced' }];
    vi.advanceTimersByTime(500);
    expect(events).toHaveLength(1);
    vi.advanceTimersByTime(600);
    expect(events).toHaveLength(2);
  });

  it('never lets a serialization problem break the page push', () => {
    win.dataLayer = [];
    install();
    const cyclic: any = { name: 'x', fn: () => 1 };
    cyclic.self = cyclic;
    expect(() => win.dataLayer.push(cyclic)).not.toThrow();
    expect(payloads()).toEqual([{ name: 'x', fn: '[function fn]', self: '[circular]' }]);
  });
});
