import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { matchVendor } from '@/lib/decoders/match';
import type { VendorId } from '@/lib/decoders/types';
import {
  assembleTimeline,
  chunkEvents,
  chunkOf,
  clearTimeline,
  commitPage,
  emptyTimeline,
  findHit,
  hitsOnLatestPage,
  insertEvent,
  MAX_BYTES,
  newId,
  resolvePage,
  storedRecord,
  trim,
} from '@/lib/timeline';
import { HANDOFF_KEY, LOADED_CORE_KEY, readBuild } from '@/lib/live-update';
import { sanitizePageEvent } from '@/lib/page-event';
import {
  chunkKey,
  tabKey,
  type HitEvent,
  type RuntimeMessage,
  type StoredTimeline,
  type TabTimeline,
  type TimelineEvent,
} from '@/lib/types';

const MAX_BODY = 200_000;
// Every request type that can carry an analytics hit (beacons are 'ping', Floodlight iframes are
// 'sub_frame'). Leaving out pages, stylesheets, fonts and media spares the worker most other requests.
const HIT_REQUESTS: Browser.webRequest.RequestFilter = {
  urls: ['<all_urls>'],
  types: ['sub_frame', 'script', 'image', 'xmlhttprequest', 'ping', 'object', 'other'],
};

function readBody(body: Browser.webRequest.OnBeforeRequestDetails['requestBody']): string | undefined {
  if (!body) return undefined;
  if (body.raw?.length) {
    const chunks = body.raw.flatMap((part) => (part.bytes ? [new Uint8Array(part.bytes)] : []));
    if (!chunks.length) return undefined;
    const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const c of chunks) {
      all.set(c, offset);
      offset += c.length;
    }
    const text = new TextDecoder().decode(all);
    return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
  }
  if (body.formData) {
    return Object.entries(body.formData)
      .flatMap(([k, values]) =>
        values.map((v) => {
          const text = typeof v === 'string' ? v : new TextDecoder().decode(v);
          return `${encodeURIComponent(k)}=${encodeURIComponent(text)}`;
        }),
      )
      .join('&');
  }
  return undefined;
}

/** A tab's timeline in memory, plus what it takes to write back only what changed. */
interface Tab {
  t: TabTimeline;
  /** Chunks in storage, with their size in bytes when last written. */
  stored: Map<number, number>;
  /** Chunks to rewrite on the next flush. */
  changed: Set<number>;
}

type Touch = (e: TimelineEvent) => void;

export default defineBackground(() => {
  // The service worker can be stopped at any time, so chrome.storage.session is the source of truth.
  // This cache only avoids re-reading it on every event while the worker is alive.
  const cache = new Map<number, Tab>();
  const loading = new Map<number, Promise<Tab>>();
  const dirty = new Set<number>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  browser.action.setBadgeBackgroundColor({ color: '#3b3b3b' }).catch(() => {});

  // ---- Live updates: scripts/deploy.mjs writes build.json; a changed core hash means reload ----

  let reloading = false;
  let reattached = false;

  // Restore the timelines the previous instance handed off before anything else reads storage.
  const ready: Promise<void> = (async () => {
    const { [HANDOFF_KEY]: handoff } = await browser.storage.local.get(HANDOFF_KEY);
    if (!handoff) return;
    await browser.storage.local.remove(HANDOFF_KEY);
    const { savedAt, data } = handoff as { savedAt: number; data: Record<string, unknown> };
    if (Date.now() - savedAt < 60_000) await browser.storage.session.set(data);
    void reattachTabs();
  })().catch(() => {});

  async function checkBuild(): Promise<void> {
    if (reloading) return;
    const build = await readBuild();
    if (!build) return;
    await ready;
    const { [LOADED_CORE_KEY]: loaded } = await browser.storage.session.get(LOADED_CORE_KEY);
    if (!loaded) await browser.storage.session.set({ [LOADED_CORE_KEY]: build.core });
    else if (loaded !== build.core) await reloadKeepingTimelines();
  }

  async function reloadKeepingTimelines(): Promise<void> {
    if (reloading) return;
    reloading = true;
    clearTimeout(flushTimer);
    await flush();
    const all = await browser.storage.session.get(null);
    const data = Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith('tab:')));
    await browser.storage.local.set({ [HANDOFF_KEY]: { savedAt: Date.now(), data } });
    browser.runtime.reload();
  }

  /**
   * After an install or reload, content scripts in open tabs are orphaned. Give each tab a fresh relay
   * so clicks and data layer pushes keep flowing without a page reload. The page-world hooks from
   * before the reload keep working (they don't depend on the extension) and re-injecting them is a no-op.
   */
  async function reattachTabs(): Promise<void> {
    if (reattached) return;
    reattached = true;
    const tabs = await browser.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    await Promise.all(
      tabs.map(async ({ id: tabId, discarded }) => {
        if (tabId == null || discarded) return;
        const ping: RuntimeMessage = { type: 'adbg:ping' };
        const alive = await browser.tabs.sendMessage(tabId, ping).then(Boolean, () => false);
        if (alive) return;
        await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/relay.js'] }).catch(() => {});
        await browser.scripting
          .executeScript({ target: { tabId }, files: ['/content-scripts/page-hooks.js'], world: 'MAIN' })
          .catch(() => {});
      }),
    );
  }

  browser.runtime.onInstalled.addListener(() => void reattachTabs());
  // Release builds have no build.json: check once and stop.
  const buildPoll = setInterval(() => void checkBuild(), 1000);
  void readBuild().then((build) => {
    if (build) void checkBuild();
    else clearInterval(buildPoll);
  });

  // ---- Timeline storage ----

  async function readTab(tabId: number): Promise<Tab> {
    await ready;
    const key = tabKey(tabId);
    const record = (await browser.storage.session.get(key))[key] as StoredTimeline | undefined;
    if (!record) return { t: emptyTimeline(tabId), stored: new Map(), changed: new Set() };
    const keys = (record.chunks ?? []).map((c) => chunkKey(tabId, c));
    const chunks = keys.length ? await browser.storage.session.get(keys) : {};
    const chunk = (c: number) => chunks[chunkKey(tabId, c)] as TimelineEvent[] | undefined;
    const t = assembleTimeline(record, chunk);
    const stored = new Map((record.chunks ?? []).map((c) => [c, JSON.stringify(chunk(c) ?? []).length]));
    // A record from before chunking keeps its events inline: rewrite them as chunks.
    return { t, stored, changed: new Set(record.chunks ? [] : t.events.map(chunkOf)) };
  }

  function load(tabId: number): Promise<Tab> {
    const cached = cache.get(tabId);
    if (cached) return Promise.resolve(cached);
    let pending = loading.get(tabId);
    if (!pending) {
      pending = readTab(tabId).then((tab) => {
        cache.set(tabId, tab);
        loading.delete(tabId);
        return tab;
      });
      loading.set(tabId, pending);
    }
    return pending;
  }

  /**
   * Mutate a tab's timeline. `mutate` calls `touch` on every event it adds or changes, so the flush
   * rewrites just their chunks, and returns false when nothing changed to skip the write.
   */
  async function update(tabId: number, mutate: (t: TabTimeline, touch: Touch) => boolean | void): Promise<void> {
    const tab = await load(tabId);
    const touch: Touch = (e) => tab.changed.add(chunkOf(e));
    if (mutate(tab.t, touch) === false) return;
    tab.t.rev++;
    tab.t.updated = Date.now();
    dirty.add(tabId);
    flushTimer ??= setTimeout(flush, 50);
  }

  const add = (t: TabTimeline, touch: Touch, e: TimelineEvent) => {
    insertEvent(t, e);
    touch(e);
  };

  const storedBytes = (tab: Tab) => [...tab.stored.values()].reduce((a, b) => a + b, 0);

  async function writeChanges(tab: Tab): Promise<void> {
    const { t } = tab;
    for (const e of trim(t, MAX_BYTES, storedBytes(tab))) tab.changed.add(chunkOf(e));
    // Events that arrive while this write is in flight mark chunks for the next one.
    const writing = tab.changed;
    tab.changed = new Set();
    try {
      const byChunk = chunkEvents(t.events, writing);
      const sizes = new Map(tab.stored);
      const items: Record<string, unknown> = {};
      const gone: string[] = [];
      for (const c of writing) {
        const events = byChunk.get(c);
        if (events) {
          items[chunkKey(t.tabId, c)] = events;
          sizes.set(c, JSON.stringify(events).length);
        } else if (sizes.delete(c)) {
          gone.push(chunkKey(t.tabId, c));
        }
      }
      // One set() so the panel sees the record and its chunks change together.
      items[tabKey(t.tabId)] = storedRecord(t, sizes.keys());
      await browser.storage.session.set(items);
      tab.stored = sizes;
      if (gone.length) await browser.storage.session.remove(gone);
    } catch (err) {
      for (const c of writing) tab.changed.add(c);
      throw err;
    }
  }

  async function write(tab: Tab): Promise<void> {
    try {
      await writeChanges(tab);
    } catch {
      // Over the session storage quota: drop the least recently updated other tabs, then this tab's oldest half.
      await evictOtherTabs(tab.t.tabId);
      const bytes = storedBytes(tab);
      for (const e of trim(tab.t, bytes / 2, bytes)) tab.changed.add(chunkOf(e));
      await writeChanges(tab).catch(() => {});
    }
  }

  // Writes run one at a time: each reads and updates what the previous one stored.
  let writes: Promise<void> = Promise.resolve();
  const serially = (task: () => Promise<void>): Promise<void> => (writes = writes.then(task).catch(() => {}));

  function flush(): Promise<void> {
    flushTimer = undefined;
    return serially(async () => {
      const tabIds = [...dirty];
      dirty.clear();
      for (const tabId of tabIds) {
        const tab = cache.get(tabId);
        if (!tab) continue;
        await write(tab);
        const hits = hitsOnLatestPage(tab.t);
        browser.action.setBadgeText({ tabId, text: hits ? String(hits) : '' }).catch(() => {});
      }
    });
  }

  async function evictOtherTabs(keep: number): Promise<void> {
    const all = await browser.storage.session.get(null);
    const tabs = new Map<number, { updated: number; keys: string[] }>();
    for (const [key, value] of Object.entries(all)) {
      const m = key.match(/^tab:(\d+)(:\d+)?$/);
      if (!m || Number(m[1]) === keep) continue;
      const entry = tabs.get(Number(m[1])) ?? { updated: 0, keys: [] };
      entry.keys.push(key);
      if (!m[2]) entry.updated = (value as StoredTimeline).updated ?? 0;
      tabs.set(Number(m[1]), entry);
    }
    const victims = [...tabs].sort(([, a], [, b]) => a.updated - b.updated).slice(0, Math.max(1, Math.ceil(tabs.size / 2)));
    for (const [tabId] of victims) cache.delete(tabId);
    const keys = victims.flatMap(([, v]) => v.keys);
    if (keys.length) await browser.storage.session.remove(keys);
  }

  function forget(tabId: number): Promise<void> {
    cache.delete(tabId);
    dirty.delete(tabId);
    // After any write in flight, so it can't put the tab back.
    return serially(async () => {
      const key = tabKey(tabId);
      const record = (await browser.storage.session.get(key))[key] as StoredTimeline | undefined;
      await browser.storage.session.remove([key, ...(record?.chunks ?? []).map((c) => chunkKey(tabId, c))]);
    });
  }

  // ---- Network hits ----

  type RequestDetails = Pick<
    Browser.webRequest.WebRequestDetails,
    'requestId' | 'url' | 'method' | 'type' | 'tabId' | 'frameId' | 'parentDocumentId' | 'timeStamp' | 'initiator'
  > & { documentId?: string };

  function addHit(t: TabTimeline, touch: Touch, d: RequestDetails, vendor: VendorId, extra: Partial<HitEvent>): HitEvent {
    const page = resolvePage(t, {
      documentId: d.documentId,
      parentDocumentId: d.parentDocumentId,
      frameId: d.frameId,
      ts: d.timeStamp,
      url: d.initiator,
    });
    const hit: HitEvent = {
      kind: 'hit',
      id: newId(),
      ts: d.timeStamp,
      pageId: page.id,
      frameId: d.frameId,
      vendor,
      requestId: d.requestId,
      url: d.url,
      method: d.method,
      resourceType: d.type,
      ...extra,
    };
    add(t, touch, hit);
    return hit;
  }

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return undefined;
      const vendor = matchVendor(details.url);
      if (!vendor) return undefined;
      const body = readBody(details.requestBody);
      void update(details.tabId, (t, touch) => {
        const existing = findHit(t, details.requestId);
        if (existing) {
          // Redirects reuse the request id (Adobe's first-party cookie redirect, for example).
          existing.redirectedFrom = existing.url;
          existing.url = details.url;
          touch(existing);
          return;
        }
        addHit(t, touch, details, vendor, { body });
      });
      return undefined;
    },
    HIT_REQUESTS,
    ['requestBody'],
  );

  const recordOutcome = (d: RequestDetails & { statusCode?: number; error?: string }) => {
    if (d.tabId < 0) return;
    const vendor = matchVendor(d.url);
    if (!vendor) return;
    void update(d.tabId, (t, touch) => {
      // No start event means the worker was still starting when the request began (right after the
      // extension is installed or reloaded). Record it anyway rather than silently dropping a hit.
      const hit = findHit(t, d.requestId) ?? addHit(t, touch, d, vendor, { partial: true });
      if (d.error) hit.error = d.error;
      else hit.status = d.statusCode;
      touch(hit);
    });
  };
  browser.webRequest.onCompleted.addListener((d) => recordOutcome(d), HIT_REQUESTS);
  browser.webRequest.onErrorOccurred.addListener((d) => recordOutcome(d), HIT_REQUESTS);

  // ---- Navigation ----

  browser.webNavigation.onCommitted.addListener((d) => {
    // Skip prerenders and non-web documents such as a new tab's initial about:blank.
    if (d.frameId !== 0 || d.documentLifecycle === 'prerender' || !/^(https?|file):/.test(d.url)) return;
    void update(d.tabId, (t) => {
      commitPage(t, { documentId: d.documentId, url: d.url, ts: d.timeStamp, transition: d.transitionType });
    });
  });

  const recordSameDocumentNav = (how: 'history' | 'hash') =>
    (d: { tabId: number; frameId: number; url: string; timeStamp: number; documentId?: string }) => {
      if (d.frameId !== 0) return;
      void update(d.tabId, (t, touch) => {
        const page = resolvePage(t, { documentId: d.documentId, frameId: 0, ts: d.timeStamp, url: d.url });
        add(t, touch, { kind: 'nav', id: newId(), ts: d.timeStamp, pageId: page.id, url: d.url, how });
      });
    };
  browser.webNavigation.onHistoryStateUpdated.addListener(recordSameDocumentNav('history'));
  browser.webNavigation.onReferenceFragmentUpdated.addListener(recordSameDocumentNav('hash'));

  // ---- Page events (data layer, clicks, Tags rules, environment) and panel requests ----

  const EXTENSION_ORIGIN = browser.runtime.getURL('/');

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id) return undefined;
    const msg = raw as RuntimeMessage;
    if (msg?.type === 'adbg:page-event') {
      const tabId = sender.tab?.id;
      // The relay passes on whatever the page dispatched; keep only what a real page event can hold.
      const event = sanitizePageEvent(msg.event);
      if (tabId == null || !event) return undefined;
      void update(tabId, (t, touch) => {
        const page = resolvePage(t, {
          documentId: sender.documentId,
          frameId: sender.frameId,
          ts: event.ts,
          url: sender.url,
        });
        if (!page.committed && sender.frameId === 0 && sender.url) page.url = sender.url;
        add(t, touch, { ...event, id: newId(), pageId: page.id, frameId: sender.frameId } as TimelineEvent);
      });
      return undefined;
    }
    // The rest come from the side panel (or its popped-out window), never from content scripts.
    if (!sender.url?.startsWith(EXTENSION_ORIGIN)) return undefined;
    if (msg?.type === 'adbg:check-build') {
      void checkBuild();
      return undefined;
    }
    if (msg?.type === 'adbg:clear') {
      void update(msg.tabId, (t, touch) => clearTimeline(t).forEach(touch)).then(() => sendResponse(true));
      return true;
    }
    return undefined;
  });

  browser.tabs.onRemoved.addListener((tabId) => void forget(tabId));
  browser.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    const { t } = await load(removedTabId);
    await forget(removedTabId);
    await update(addedTabId, (target, touch) => {
      const before = target.events;
      Object.assign(target, { ...t, tabId: addedTabId, rev: target.rev });
      [...before, ...target.events].forEach(touch);
    });
  });
});
