/// <reference types="node" />
/// <reference types="chrome" />

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { chromium, expect, type BrowserContext, type Worker } from '@playwright/test';
import { assembleTimeline } from '../../lib/timeline';
import type { StoredTimeline, TabTimeline, TimelineEvent } from '../../lib/types';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const BUILT_EXTENSION = path.join(ROOT, '.output/chrome-mv3');
export const SHOTS = path.join(ROOT, 'test-results');
const SITE = path.join(import.meta.dirname, 'site');

/** Serves the fixture store and answers analytics endpoints with 204. */
export async function startSite(): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (/\/b\/ss\/|\/g\/collect|\/ee\/|\/rest\/v1\/delivery/.test(url.pathname)) {
      req.resume();
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/gtm.js') {
      // Stand-in for a GTM container: registers itself the way gtm.js does.
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`window.google_tag_manager = window.google_tag_manager || {}; google_tag_manager[${JSON.stringify(url.searchParams.get('id'))}] = {};`);
      return;
    }
    const file = path.join(SITE, url.pathname === '/' || url.pathname === '/cart' ? 'index.html' : url.pathname);
    if (!file.startsWith(SITE) || !fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

/** The worker target appears before its script runs; wait until the request listener is registered. */
export async function readyWorker(worker: Worker): Promise<Worker> {
  await expect
    .poll(() => worker.evaluate(() => chrome.webRequest.onBeforeRequest.hasListeners()).catch(() => false))
    .toBe(true);
  return worker;
}

export async function launchWithExtension(dir: string): Promise<{ context: BrowserContext; worker: Worker }> {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  // Match a real install, where "Load unpacked" requires Developer mode. Without it, Chrome disables an
  // unpacked extension that reloads itself ("unsupported developer extension").
  const settings = await context.newPage();
  await settings.goto('chrome://extensions');
  await settings.evaluate(() =>
    (chrome as unknown as { developerPrivate: { updateProfileConfiguration(c: object): Promise<void> } }).developerPrivate
      .updateProfileConfiguration({ inDeveloperMode: true }),
  );
  await settings.close();
  return { context, worker: await readyWorker(worker) };
}

/** The timeline the background stored for the tab at `origin`: its record plus event chunks. */
export async function timelineFor(worker: Worker, origin: string): Promise<TabTimeline> {
  const { record, chunks } = await worker.evaluate(async (prefix) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url?.startsWith(prefix));
    if (!tab?.id) throw new Error(`no tab for ${prefix}`);
    const key = `tab:${tab.id}`;
    const all = await chrome.storage.session.get(null);
    return { record: all[key], chunks: Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(`${key}:`))) };
  }, origin);
  if (!record) return record as TabTimeline;
  const stored = record as StoredTimeline;
  return assembleTimeline(stored, (c) => chunks[`tab:${stored.tabId}:${c}`] as TimelineEvent[] | undefined);
}

export const describeEvent = (e: TimelineEvent) => {
  if (e.kind === 'hit') return `hit:${e.vendor}:${new URL(e.url).pathname.split('/').pop()}:${e.status ?? e.error}`;
  if (e.kind === 'datalayer') return `dl:${e.source}:${e.payload.slice(0, 40)}`;
  if (e.kind === 'interaction') return `${e.action}:${e.text}`;
  if (e.kind === 'rule') return `rule:${e.phase}:${e.ruleName}`;
  if (e.kind === 'env') return `env:${e.source}`;
  return `nav:${new URL(e.url).pathname}`;
};
