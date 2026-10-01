import { useEffect, useMemo, useRef, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import type { Issue } from '@/lib/checks';
import { readBuild, type BuildInfo } from '@/lib/live-update';
import { assembleTimeline } from '@/lib/timeline';
import { chunkKey, tabKey, type RuntimeMessage, type StoredTimeline, type TabTimeline, type TimelineEvent } from '@/lib/types';

/** The tab to show: `?tabId=` when popped out, otherwise whichever tab is active in this window. */
export function useTargetTab() {
  const pinned = useMemo(() => {
    const v = new URLSearchParams(location.search).get('tabId');
    return v ? Number(v) : null;
  }, []);
  const [tabId, setTabId] = useState<number | null>(pinned);
  const [tab, setTab] = useState<Browser.tabs.Tab | null>(null);

  useEffect(() => {
    if (pinned != null) return;
    let windowId: number | undefined;
    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (info.windowId === windowId) setTabId(info.tabId);
    };
    void browser.windows.getCurrent().then(async (w) => {
      windowId = w.id;
      const [active] = await browser.tabs.query({ active: true, windowId: w.id });
      if (active?.id != null) setTabId(active.id);
    });
    browser.tabs.onActivated.addListener(onActivated);
    return () => browser.tabs.onActivated.removeListener(onActivated);
  }, [pinned]);

  useEffect(() => {
    if (tabId == null) return;
    browser.tabs.get(tabId).then(setTab, () => setTab(null));
    const onUpdated = (id: number, _info: unknown, t: Browser.tabs.Tab) => {
      if (id === tabId) setTab(t);
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => browser.tabs.onUpdated.removeListener(onUpdated);
  }, [tabId]);

  return { tabId, tab, pinned: pinned != null };
}

/**
 * Follow a tab's timeline in storage (see StoredTimeline). Change notifications carry only the chunks
 * that changed; the others keep their events, and so their rows, from before.
 */
export function useTimeline(tabId: number | null): TabTimeline | null {
  const [timeline, setTimeline] = useState<TabTimeline | null>(null);
  useEffect(() => {
    setTimeline(null);
    if (tabId == null) return;
    const recordKey = tabKey(tabId);
    const prefix = `${recordKey}:`;
    let record: StoredTimeline | undefined;
    const chunks = new Map<number, TimelineEvent[]>();
    // Keys a change notification already brought; the initial read mustn't overwrite them with older values.
    const fresh = new Set<string>();
    let loaded = false;

    const apply = (key: string, value: unknown) => {
      if (key === recordKey) record = value as StoredTimeline | undefined;
      else if (value) chunks.set(Number(key.slice(prefix.length)), value as TimelineEvent[]);
      else chunks.delete(Number(key.slice(prefix.length)));
    };
    const publish = () => setTimeline(record ? assembleTimeline(record, (c) => chunks.get(c)) : null);

    const listener = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
      if (area !== 'session') return;
      let touched = false;
      for (const [key, change] of Object.entries(changes)) {
        if (key !== recordKey && !key.startsWith(prefix)) continue;
        fresh.add(key);
        apply(key, change.newValue);
        touched = true;
      }
      if (touched && loaded) publish();
    };
    browser.storage.onChanged.addListener(listener);

    let cancelled = false;
    void (async () => {
      const first = await browser.storage.session.get(recordKey);
      if (!fresh.has(recordKey)) apply(recordKey, first[recordKey]);
      const keys = (record?.chunks ?? []).map((c) => chunkKey(tabId, c)).filter((k) => !fresh.has(k));
      if (keys.length) {
        const stored = await browser.storage.session.get(keys);
        for (const k of keys) if (!fresh.has(k)) apply(k, stored[k]);
      }
      loaded = true;
      if (!cancelled) publish();
    })();
    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(listener);
    };
  }, [tabId]);
  return timeline;
}

const UPDATED_FLAG = 'adbg.updated';

/**
 * Refresh the panel in place when only panel code changed. When background or content scripts changed,
 * nudge the background, which reloads the whole extension (closing this panel) and keeps the timelines.
 * Release builds have no build.json, so this stops after the first look. Returns true for a few
 * seconds after an in-place refresh.
 */
export function useLiveUpdates(): boolean {
  const [justUpdated, setJustUpdated] = useState(() => {
    try {
      const flagged = sessionStorage.getItem(UPDATED_FLAG) != null;
      sessionStorage.removeItem(UPDATED_FLAG);
      return flagged;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!justUpdated) return;
    const t = setTimeout(() => setJustUpdated(false), 4000);
    return () => clearTimeout(t);
  }, [justUpdated]);

  useEffect(() => {
    let loaded: BuildInfo | undefined;
    let id: ReturnType<typeof setInterval> | undefined;
    const check = async () => {
      const build = await readBuild();
      if (!build) return;
      if (!loaded) {
        loaded = build;
      } else if (build.core !== loaded.core) {
        const msg: RuntimeMessage = { type: 'adbg:check-build' };
        void browser.runtime.sendMessage(msg).catch(() => {});
      } else if (build.panel !== loaded.panel) {
        try {
          sessionStorage.setItem(UPDATED_FLAG, '1');
        } catch {
          /* storage unavailable */
        }
        location.reload();
      }
    };
    let stopped = false;
    void check().then(() => {
      if (loaded && !stopped) id = setInterval(check, 1000);
    });
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, []);

  return justUpdated;
}

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  };
  return { copied, copy };
}

/** The same array as last time while its contents are equal, so memoized rows don't re-render. */
export function useStableArray<T>(value: T[]): T[] {
  const ref = useRef(value);
  if (ref.current.length !== value.length || ref.current.some((v, i) => v !== value[i])) ref.current = value;
  return ref.current;
}

/** Issues by row key, keeping each row's previous array when its issues are unchanged. */
export function useStableIssues(issues: Map<string, Issue[]>): Map<string, Issue[]> {
  const ref = useRef(issues);
  const prev = ref.current;
  if (prev !== issues) {
    const sig = (list: Issue[]) => list.map((i) => `${i.level}:${i.message}`).join('\n');
    for (const [key, list] of issues) {
      const old = prev.get(key);
      if (old && sig(old) === sig(list)) issues.set(key, old);
    }
    ref.current = issues;
  }
  return ref.current;
}
