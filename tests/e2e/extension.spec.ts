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
});

test('side panel renders the decoded timeline', async () => {
  const site = await context.newPage();
  await site.goto(`${origin}/`);
  await site.waitForTimeout(800);
  await site.click('#atc');
  await site.waitForTimeout(400);

  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` }))[0]?.id, origin);
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 460, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);

  await expect(panel.locator('.row .title', { hasText: 's.tl' })).toBeVisible();
  await expect(panel.locator('.row', { hasText: 'add to cart (custom link)' })).toBeVisible();
  await expect(panel.locator('.row .title', { hasText: 'add_to_cart' })).toBeVisible();
  await expect(panel.locator('.row .title', { hasText: '"Add to cart"' })).toBeVisible();
  fs.mkdirSync(SHOTS, { recursive: true });
  await panel.screenshot({ path: path.join(SHOTS, 'panel-timeline.png') });

  // Expand the AA page view and check the decoded variables.
  await panel.locator('.row', { hasText: 'pdp:widget-a' }).filter({ hasText: 's.t' }).first().locator('.row-head').click();
  await expect(panel.locator('.params .label', { hasText: 'eVar1' })).toBeVisible();
  await expect(panel.locator('.params .note', { hasText: '= pdp:widget-a' })).toBeVisible();
  await expect(panel.locator('.params .label', { hasText: 'prop5' })).toBeVisible();
  await panel.screenshot({ path: path.join(SHOTS, 'panel-expanded.png') });

  // Filtering and search.
  await panel.getByRole('button', { name: /^Data layer/ }).click();
  await expect(panel.locator('.row .badge', { hasText: 'ACDL' })).toHaveCount(0);
  await panel.getByRole('button', { name: /^Data layer/ }).click();
  await panel.getByPlaceholder('Search events, variables, values…').fill('scAdd');
  await expect(panel.locator('.row')).toHaveCount(1);

  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.getByPlaceholder('Search events, variables, values…').fill('');
  await panel.screenshot({ path: path.join(SHOTS, 'panel-dark.png') });
});
