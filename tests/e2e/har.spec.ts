/// <reference types="chrome" />

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { BUILT_EXTENSION, launchWithExtension, SHOTS, startSite, timelineFor } from './helpers';

let site: Awaited<ReturnType<typeof startSite>>;
let context: BrowserContext;
let worker: Worker;

test.beforeAll(async () => {
  site = await startSite();
  ({ context, worker } = await launchWithExtension(BUILT_EXTENSION));
});

test.afterAll(async () => {
  await context?.close();
  site?.close();
});

/** What a page section shows: its header line and each row's text, issues included. */
const sectionText = async (panel: Page) => ({
  meta: (await panel.locator('.page .page-meta').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ')),
  env: await panel.locator('.page .page-env').allInnerTexts(),
  rows: (await panel.locator('.page .row').allInnerTexts()).map((s) => s.replace(/\s+/g, ' ')),
});

test('exports the timeline as HAR and re-imports it into the same view', async () => {
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  await page.waitForTimeout(800);
  await page.click('#atc');
  await page.waitForTimeout(600);

  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, `${site.origin}/`);
  const extensionId = new URL(worker.url()).host;
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 460, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`);
  await expect(panel.locator('.row', { hasText: 'add to cart (custom link)' })).toBeVisible();
  const live = await sectionText(panel);
  fs.mkdirSync(SHOTS, { recursive: true });
  await panel.screenshot({ path: path.join(SHOTS, 'har-live.png') });

  // Export from the page header.
  const [download] = await Promise.all([
    panel.waitForEvent('download'),
    panel.locator('.page.latest .page-header').getByRole('button', { name: 'Export' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^127\.0\.0\.1_\d+-\d{4}-\d\d-\d\d-\d{4}\.har$/);
  const file = path.join(SHOTS, 'fixture-store.har');
  await download.saveAs(file);
  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  const stored = await timelineFor(worker, `${site.origin}/`);
  const hits = stored.events.filter((e) => e.kind === 'hit');
  expect(har.log.version).toBe('1.2');
  expect(har.log.creator.name).toBe('Analytics Debugger');
  expect(har.log.pages).toHaveLength(1);
  expect(har.log.entries).toHaveLength(hits.length);
  const webSdk = har.log.entries.find((e: { request: { url: string } }) => e.request.url.includes('/ee/v1/interact'));
  expect(webSdk.request.method).toBe('POST');
  expect(webSdk.request.postData.text).toContain('"xdm"');
  expect(webSdk.response.status).toBe(204);

  // The toolbar's Export saves every page of the tab.
  const [all] = await Promise.all([panel.waitForEvent('download'), panel.locator('.toolbar').getByRole('button', { name: 'Export' }).click()]);
  expect(JSON.parse(fs.readFileSync(await all.path(), 'utf8')).log.entries).toHaveLength(hits.length);

  // Something that isn't a HAR is refused in the panel.
  const input = panel.locator('input[type=file]');
  await input.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not json') });
  await expect(panel.locator('.banner.error')).toContainText("notes.txt isn't a HAR file");

  // Open capture… opens the file in its own read-only window.
  const [capture] = await Promise.all([context.waitForEvent('page'), input.setInputFiles(file)]);
  await capture.setViewportSize({ width: 460, height: 900 });
  await expect(capture.locator('.row', { hasText: 'add to cart (custom link)' })).toBeVisible();
  await expect(capture.locator('.tab-host')).toHaveText('fixture-store.har');
  await expect(capture.locator('.pill.imported')).toBeVisible();
  await expect(capture.getByRole('button', { name: 'Clear' })).toHaveCount(0);
  expect(await sectionText(capture)).toEqual(live);
  await capture.screenshot({ path: path.join(SHOTS, 'har-imported.png') });

  // An in-place refresh (as after a panel-only update) keeps the capture.
  await capture.reload();
  await expect(capture.locator('.row', { hasText: 'add to cart (custom link)' })).toBeVisible();
  expect(await sectionText(capture)).toEqual(live);
  const leftover = await worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('capture:')));
  expect(leftover).toEqual([]);
});
