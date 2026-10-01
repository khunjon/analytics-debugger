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

  it('never lets a serialization problem break the page push', () => {
    win.dataLayer = [];
    install();
    const cyclic: any = { name: 'x', fn: () => 1 };
    cyclic.self = cyclic;
    expect(() => win.dataLayer.push(cyclic)).not.toThrow();
    expect(payloads()).toEqual([{ name: 'x', fn: '[function fn]', self: '[circular]' }]);
  });
});
