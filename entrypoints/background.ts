import { browser, type Browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { matchVendor } from '@/lib/decoders/match';
import type { VendorId } from '@/lib/decoders/types';
import {
  clearTimeline,
  commitPage,
  emptyTimeline,
  findHit,
  hitsOnLatestPage,
  insertEvent,
  newId,
  resolvePage,
  trim,
} from '@/lib/timeline';
import { HANDOFF_KEY, LOADED_CORE_KEY, readBuild } from '@/lib/live-update';
import { tabKey, type HitEvent, type RuntimeMessage, type TabTimeline, type TimelineEvent } from '@/lib/types';

const MAX_BODY = 200_000;
const ALL_URLS = { urls: ['<all_urls>'] };

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

export default defineBackground(() => {
  // The service worker can be stopped at any time, so chrome.storage.session is the source of truth.
  // This cache only avoids re-reading it on every event while the worker is alive.
  const cache = new Map<number, TabTimeline>();
  const loading = new Map<number, Promise<TabTimeline>>();
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
  void checkBuild();
  setInterval(() => void checkBuild(), 1000);

  // ---- Timeline storage ----

  function load(tabId: number): Promise<TabTimeline> {
    const cached = cache.get(tabId);
    if (cached) return Promise.resolve(cached);
    let pending = loading.get(tabId);
    if (!pending) {
      pending = ready.then(() => browser.storage.session.get(tabKey(tabId))).then((stored) => {
        const t = (stored[tabKey(tabId)] as TabTimeline | undefined) ?? emptyTimeline(tabId);
        cache.set(tabId, t);
        loading.delete(tabId);
        return t;
      });
      loading.set(tabId, pending);
    }
    return pending;
  }

  /** Mutate a tab's timeline. Return false from `mutate` when nothing changed to skip the write. */
  async function update(tabId: number, mutate: (t: TabTimeline) => boolean | void): Promise<void> {
    const t = await load(tabId);
    if (mutate(t) === false) return;
    t.rev++;
    t.updated = Date.now();
    dirty.add(tabId);
    flushTimer ??= setTimeout(flush, 50);
  }

  async function write(t: TabTimeline): Promise<void> {
    trim(t);
    try {
      await browser.storage.session.set({ [tabKey(t.tabId)]: t });
    } catch {
      // Over the session storage quota: drop the least recently updated other tabs, then this tab's oldest half.
      await evictOtherTabs(t.tabId);
      trim(t, JSON.stringify(t).length / 2);
      await browser.storage.session.set({ [tabKey(t.tabId)]: t }).catch(() => {});
    }
  }

  async function flush(): Promise<void> {
    flushTimer = undefined;
    const tabIds = [...dirty];
    dirty.clear();
    for (const tabId of tabIds) {
      const t = cache.get(tabId);
      if (!t) continue;
      await write(t);
      const hits = hitsOnLatestPage(t);
      browser.action.setBadgeText({ tabId, text: hits ? String(hits) : '' }).catch(() => {});
    }
  }

  async function evictOtherTabs(keep: number): Promise<void> {
    const all = await browser.storage.session.get(null);
    const others = Object.entries(all)
      .filter(([k]) => k.startsWith('tab:') && k !== tabKey(keep))
      .map(([k, v]) => ({ key: k, updated: (v as TabTimeline).updated ?? 0 }))
      .sort((a, b) => a.updated - b.updated);
    const victims = others.slice(0, Math.max(1, Math.ceil(others.length / 2)));
    for (const v of victims) cache.delete(Number(v.key.slice(4)));
    if (victims.length) await browser.storage.session.remove(victims.map((v) => v.key));
  }

  async function forget(tabId: number): Promise<void> {
    cache.delete(tabId);
    dirty.delete(tabId);
    await browser.storage.session.remove(tabKey(tabId));
  }

  // ---- Network hits ----

  type RequestDetails = Pick<
    Browser.webRequest.WebRequestDetails,
    'requestId' | 'url' | 'method' | 'type' | 'tabId' | 'frameId' | 'parentDocumentId' | 'timeStamp' | 'initiator'
  > & { documentId?: string };

  function addHit(t: TabTimeline, d: RequestDetails, vendor: VendorId, extra: Partial<HitEvent>): HitEvent {
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
    insertEvent(t, hit);
    return hit;
  }

  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return undefined;
      const vendor = matchVendor(details.url);
      if (!vendor) return undefined;
      const body = readBody(details.requestBody);
      void update(details.tabId, (t) => {
        const existing = findHit(t, details.requestId);
        if (existing) {
          // Redirects reuse the request id (Adobe's first-party cookie redirect, for example).
          existing.redirectedFrom = existing.url;
          existing.url = details.url;
          return;
        }
        addHit(t, details, vendor, { body });
      });
      return undefined;
    },
    ALL_URLS,
    ['requestBody'],
  );

  const recordOutcome = (d: RequestDetails & { statusCode?: number; error?: string }) => {
    if (d.tabId < 0) return;
    const vendor = matchVendor(d.url);
    if (!vendor) return;
    void update(d.tabId, (t) => {
      // No start event means the worker was still starting when the request began (right after the
      // extension is installed or reloaded). Record it anyway rather than silently dropping a hit.
      const hit = findHit(t, d.requestId) ?? addHit(t, d, vendor, { partial: true });
      if (d.error) hit.error = d.error;
      else hit.status = d.statusCode;
    });
  };
  browser.webRequest.onCompleted.addListener((d) => recordOutcome(d), ALL_URLS);
  browser.webRequest.onErrorOccurred.addListener((d) => recordOutcome(d), ALL_URLS);

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
      void update(d.tabId, (t) => {
        const page = resolvePage(t, { documentId: d.documentId, frameId: 0, ts: d.timeStamp, url: d.url });
        insertEvent(t, { kind: 'nav', id: newId(), ts: d.timeStamp, pageId: page.id, url: d.url, how });
      });
    };
  browser.webNavigation.onHistoryStateUpdated.addListener(recordSameDocumentNav('history'));
  browser.webNavigation.onReferenceFragmentUpdated.addListener(recordSameDocumentNav('hash'));

  // ---- Page events (data layer, clicks) and panel requests ----

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as RuntimeMessage;
    if (msg?.type === 'adbg:page-event') {
      const tabId = sender.tab?.id;
      if (tabId == null) return undefined;
      void update(tabId, (t) => {
        const page = resolvePage(t, {
          documentId: sender.documentId,
          frameId: sender.frameId,
          ts: msg.event.ts,
          url: sender.url,
        });
        if (!page.committed && sender.frameId === 0 && sender.url) page.url = sender.url;
        insertEvent(t, { ...msg.event, id: newId(), pageId: page.id, frameId: sender.frameId } as TimelineEvent);
      });
      return undefined;
    }
    if (msg?.type === 'adbg:check-build') {
      void checkBuild();
      return undefined;
    }
    if (msg?.type === 'adbg:clear') {
      void update(msg.tabId, (t) => clearTimeline(t)).then(() => sendResponse(true));
      return true;
    }
    return undefined;
  });

  browser.tabs.onRemoved.addListener((tabId) => void forget(tabId));
  browser.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    const t = await load(removedTabId);
    await forget(removedTabId);
    await update(addedTabId, (target) => {
      Object.assign(target, { ...t, tabId: addedTabId, rev: target.rev });
    });
  });
});
