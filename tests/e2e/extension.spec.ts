/// <reference types="chrome" />

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Worker } from '@playwright/test';
import {
  BUILT_EXTENSION,
  describeEvent as describe,
  launchWithExtension,
  SHOTS,
  startSite,
  timelineFor as timelineIn,
} from './helpers';

let site: Awaited<ReturnType<typeof startSite>>;
let origin: string;
let context: BrowserContext;
let worker: Worker;

test.beforeAll(async () => {
  site = await startSite();
  origin = site.origin;
  ({ context, worker } = await launchWithExtension(BUILT_EXTENSION));
});

test.afterAll(async () => {
  await context?.close();
  site?.close();
});

const timelineFor = (url: string) => timelineIn(worker, url);

test('captures hits, data layer, clicks and navigation, grouped by page', async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await page.waitForTimeout(800);
  await page.click('#atc');
  await page.waitForTimeout(400);
  await page.click('#spa');
  await page.waitForTimeout(300);
  await page.goto(`${origin}/page2.html`);
  await page.waitForTimeout(800);

  const t = await timelineFor(origin);
  expect(t.pages.map((p) => new URL(p.url).pathname)).toEqual(['/', '/page2.html']);
  const [first, second] = t.pages;
  const onFirst = t.events.filter((e) => e.pageId === first!.id).map(describe);
  const onSecond = t.events.filter((e) => e.pageId === second!.id).map(describe);

  // Page-load hits, decoded later in the panel, all completed.
  expect(onFirst).toContain('hit:adobe-analytics:s111:204');
  expect(onFirst).toContain('hit:ga4:collect:204');
  expect(onFirst).toContain('hit:adobe-websdk:interact:204');
  expect(onFirst).toContain('hit:adobe-target:delivery:204');

  // Adobe Tags rules, from the first one the library runs, and what's loaded on the page.
  expect(onFirst.filter((s) => s.startsWith('rule:'))).toEqual([
    'rule:triggered:Library loaded: set up',
    'rule:completed:Library loaded: set up',
    'rule:triggered:Checkout page view',
    'rule:condition-failed:Checkout page view',
    'rule:triggered:Page load: product detail',
    'rule:completed:Page load: product detail',
    'rule:triggered:Cart add',
    'rule:completed:Cart add',
  ]);
  expect(onFirst).toContain('env:adobe-tags');
  expect(onFirst).toContain('env:gtm');
  expect(onFirst.filter((s) => s.startsWith('dl:digitalData'))).toHaveLength(2);

  // Data layer, including the pushes made before the hooks could wrap push.
  expect(onFirst.some((s) => s.startsWith('dl:dataLayer:{"pageType":"pdp"'))).toBe(true);
  expect(onFirst.some((s) => s.startsWith('dl:dataLayer:["config","G-TEST123"]'))).toBe(true);
  expect(onFirst.some((s) => s.startsWith('dl:adobeDataLayer:{"page"'))).toBe(true);
  expect(onFirst.some((s) => s.startsWith('dl:_satellite.track:{"identifier":"pdp-loaded"'))).toBe(true);

  // Cause and effect: the click lands before the push and hits it triggered.
  const click = onFirst.indexOf('click:Add to cart');
  const push = onFirst.findIndex((s) => s.startsWith('dl:adobeDataLayer:{"event":"cart.add"'));
  const linkHit = onFirst.indexOf('hit:adobe-analytics:s222:204');
  expect(click).toBeGreaterThanOrEqual(0);
  expect(push).toBeGreaterThan(click);
  expect(linkHit).toBeGreaterThan(push);

  expect(onFirst).toContain('nav:/cart');

  // The unload beacon belongs to the page that sent it, not the next one.
  const unload = t.events.find((e) => e.kind === 'hit' && e.url.includes('en=user_engagement'));
  expect(unload?.pageId).toBe(first!.id);

  expect(onSecond).toEqual(['hit:adobe-analytics:s333:204']);
  expect(t.events.filter((e) => e.kind === 'datalayer').every((e) => e.pageId === first!.id)).toBe(true);

  // Stored as a record plus chunks of events, not one big value.
  const keys = await worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)));
  const tabKeys = keys.filter((k) => k.startsWith(`tab:${t.tabId}`));
  expect(tabKeys).toContain(`tab:${t.tabId}`);
  expect(tabKeys.length).toBeGreaterThan(1);
});

test('the panel reads a timeline stored before chunking, as handed over by an older version', async () => {
  const page = await context.newPage();
  await page.goto(`${origin}/page2.html?legacy`);
  await page.waitForTimeout(500);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${origin}/page2.html?legacy`);
  // The old format: one record with the events inline, no chunks, no seq numbers.
  const current = await timelineFor(origin + '/page2.html?legacy');
  const { nextSeq: _nextSeq, ...legacy } = { ...current, events: current.events.map(({ seq: _seq, ...e }) => e) };
  await worker.evaluate(
    async ({ id, record }) => {
      const all = await chrome.storage.session.get(null);
      await chrome.storage.session.remove(Object.keys(all).filter((k) => k.startsWith(`tab:${id}:`)));
      await chrome.storage.session.set({ [`tab:${id}`]: record });
    },
    { id: tabId, record: legacy },
  );
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html?tabId=${tabId}`);
  await expect(panel.locator('.row', { hasText: 's.t' }).locator('.detail')).toHaveText(' cart');
  await panel.close();
  await page.close();
});

test('side panel renders the decoded timeline', async () => {
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  await site.waitForTimeout(800);
  await site.click('#atc');
  await site.waitForTimeout(400);

  // This test's tab: the previous test's tab is on the same origin, but at /page2.html.
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/` }))[0]?.id, origin);
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 460, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);

  await expect(panel.locator('.row .title', { hasText: 's.tl' })).toBeVisible();
  await expect(panel.locator('.row', { hasText: 'add to cart (custom link)' })).toBeVisible();
  await expect(panel.locator('.row .title', { hasText: 'add_to_cart' })).toBeVisible();
  await expect(panel.locator('.row .title', { hasText: '"Add to cart"' })).toBeVisible();
  await expect(panel.locator('.row .title', { hasText: 'pageLoad' })).toBeVisible();

  // What's loaded on the page, in its header.
  const env = panel.locator('.page.latest .page-env');
  await expect(env).toContainText('Fixture Store');
  await expect(env.locator('.tag', { hasText: 'development' })).toBeVisible();
  await expect(env).toContainText('GTM-FIXTURE');
  await expect(env.locator('.tag', { hasText: 'env-5' })).toBeVisible();

  // Tags rules with their outcome; a click's effects are nested under it.
  await expect(panel.locator('.row.rule-ok', { hasText: 'Page load: product detail' })).toContainText('fired');
  await expect(panel.locator('.row.rule-failed', { hasText: 'Checkout page view' })).toContainText('condition not met: core: path');
  await expect(panel.locator('.row.nested', { hasText: 'Cart add' })).toBeVisible();
  await expect(panel.locator('.row.nested', { hasText: 's.tl' })).toBeVisible();

  // Consent markers, the digitalData change, and a check on a hit.
  await expect(panel.locator('.row .tag.consent')).toHaveCount(2);
  await expect(panel.locator('.row', { hasText: 'cart.items changed' }).locator('.badge')).toHaveText('digitalData');
  // The page's own _satellite is a plain property again once the library has set it.
  expect(await site.evaluate(() => Object.getOwnPropertyDescriptor(window, '_satellite')?.writable)).toBe(true);
  await expect(panel.locator('.row', { hasText: 'view_cart' }).locator('.issue-line')).toContainText('No items');

  // GTM's own events are hidden until switched on.
  await expect(panel.locator('.row .title', { hasText: 'event: gtm.js' })).toHaveCount(0);
  await panel.getByRole('button', { name: /^GTM internals/ }).click();
  await expect(panel.locator('.row .title', { hasText: 'event: gtm.js' })).toBeVisible();
  await panel.getByRole('button', { name: /^GTM internals/ }).click();
  fs.mkdirSync(SHOTS, { recursive: true });
  await panel.screenshot({ path: path.join(SHOTS, 'panel-timeline.png') });

  // Expand the AA page view and check the decoded variables.
  await panel.locator('.row', { hasText: 'pdp:widget-a' }).filter({ hasText: 's.t' }).first().locator('.row-head').click();
  await expect(panel.locator('.params .label', { hasText: 'eVar1' })).toBeVisible();
  await expect(panel.locator('.params .note', { hasText: '= pdp:widget-a' })).toBeVisible();
  await expect(panel.locator('.params .label', { hasText: 'prop5' })).toBeVisible();
  await expect(panel.locator('.row.open .param-group summary', { hasText: 'adobeDataLayer when this hit was sent' })).toBeVisible();
  await panel.screenshot({ path: path.join(SHOTS, 'panel-expanded.png') });
  await panel.locator('.row.open .row-head').click();

  // Compare the link hit with the page view before it.
  const linkHit = panel.locator('.row', { hasText: 'add to cart (custom link)' });
  await linkHit.locator('.row-head').click();
  await linkHit.getByRole('button', { name: 'Compare' }).click();
  await expect(linkHit.locator('.row-body')).toContainText('Compared with s.t (pdp:widget-a)');
  await expect(linkHit.locator('.params.added .label', { hasText: 'Link name' })).toBeVisible();
  await expect(linkHit.locator('.params.changed .label', { hasText: 'Events' })).toBeVisible();
  await panel.screenshot({ path: path.join(SHOTS, 'panel-compare.png') });
  await linkHit.locator('.row-head').click();

  // Filtering and search.
  await panel.getByRole('button', { name: /^Data layer/ }).click();
  await expect(panel.locator('.row .badge', { hasText: 'ACDL' })).toHaveCount(0);
  await panel.getByRole('button', { name: /^Data layer/ }).click();
  const search = panel.locator('input.search');
  await search.fill('scAdd');
  await expect(panel.locator('.row')).toHaveCount(1);

  // Watching variables: only hits that carry them, with their values inline; clicks stay for context.
  await search.fill('events, eVar1');
  await expect(panel.locator('.watch-hint code')).toHaveText(['events', 'eVar1']);
  await expect(panel.locator('.watch-item', { hasText: 'prodView' })).toBeVisible();
  await expect(panel.locator('.watch-item.changed', { hasText: 'scAdd' })).toBeVisible();
  await expect(panel.locator('.watch-item', { hasText: 'pdp:widget-a (D=pageName)' })).toBeVisible();
  await expect(panel.locator('.row .title', { hasText: '"Add to cart"' })).toBeVisible();
  await expect(panel.locator('.row .badge', { hasText: 'GA4' })).toHaveCount(0);
  await panel.screenshot({ path: path.join(SHOTS, 'panel-watch.png') });

  // An event filter plus a watch.
  await search.fill('page_view, page_location');
  await expect(panel.locator('.row')).toHaveCount(1);
  await expect(panel.locator('.row .watch-key')).toHaveText('page_location');

  await panel.emulateMedia({ colorScheme: 'dark' });
  await search.fill('');
  await panel.screenshot({ path: path.join(SHOTS, 'panel-dark.png') });
});
