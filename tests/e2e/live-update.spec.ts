/// <reference types="node" />
/// <reference types="chrome" />

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { BUILT_EXTENSION, describeEvent, launchWithExtension, readyWorker, startSite, timelineFor } from './helpers';

// Installs a copy of the built extension with a build.json, then plays the part of scripts/deploy.mjs
// by rewriting build.json the way a panel-only or core deploy would.

let site: Awaited<ReturnType<typeof startSite>>;
let dir: string;
let context: BrowserContext;
let worker: Worker;

const writeBuild = (core: string, panel: string) =>
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ source: `${core}${panel}`, core, panel, builtAt: Date.now() }));

test.beforeAll(async () => {
  site = await startSite();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adbg-live-'));
  fs.cpSync(BUILT_EXTENSION, dir, { recursive: true });
  writeBuild('core-1', 'panel-1');
  ({ context, worker } = await launchWithExtension(dir));
});

test.afterAll(async () => {
  await context?.close();
  site?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('panel-only updates refresh the panel; core updates reload the extension and keep the timeline', async () => {
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  await page.waitForTimeout(800);
  await page.click('#atc');
  await page.waitForTimeout(400);
  const before = await timelineFor(worker, site.origin);
  expect(before.events.filter((e) => e.kind === 'interaction')).toHaveLength(1);

  // Panel-only deploy: the open panel reloads itself and the extension keeps running.
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url: `${url}/*` }))[0]?.id, site.origin);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html?tabId=${tabId}`);
  await expect(panel.locator('.row .title', { hasText: 's.tl' })).toBeVisible();
  await panel.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
  writeBuild('core-1', 'panel-2');
  await expect.poll(() => panel.evaluate(() => (window as unknown as { marker?: number }).marker ?? 0)).toBe(0);
  await expect(panel.locator('.pill.updated')).toBeVisible();
  await expect(panel.locator('.row .title', { hasText: 's.tl' })).toBeVisible();
  expect(await worker.evaluate(() => 'still the same worker')).toBe('still the same worker');

  // Core deploy: the extension reloads itself and the new instance restores the timeline.
  const restarted = context.waitForEvent('serviceworker');
  writeBuild('core-2', 'panel-2');
  worker = await readyWorker(await restarted);
  await expect.poll(async () => (await timelineFor(worker, site.origin))?.events.length ?? 0).toBe(before.events.length);

  // Without reloading the page, clicks still reach the new instance, exactly once each.
  await expect
    .poll(async () => {
      await page.click('#atc');
      await page.waitForTimeout(300);
      const t = await timelineFor(worker, site.origin);
      return t.events.filter((e) => e.kind === 'interaction').length;
    })
    .toBeGreaterThan(1);
  await page.waitForTimeout(500);
  const after = await timelineFor(worker, site.origin);
  const clicks = after.events.filter((e) => e.kind === 'interaction').map(describeEvent);
  const pushes = after.events.filter((e) => e.kind === 'datalayer' && e.payload.includes('cart.add'));
  expect(pushes.length).toBe(clicks.length);
  expect(after.pages).toHaveLength(1);

  // And it settles: no reload loop.
  await page.waitForTimeout(2500);
  expect(context.serviceWorkers()).toHaveLength(1);
  expect(await worker.evaluate(() => 'alive')).toBe('alive');
});
