import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { hostOf } from '@/lib/format';
import { harToTimeline, timelineToHar } from '@/lib/har';
import type { TabTimeline } from '@/lib/types';

/** An imported HAR file, as the capture window shows it. */
export interface Capture {
  name: string;
  creator?: string;
  /** Requests in the file that no decoder recognized. */
  ignored: number;
  timeline: TabTimeline;
}

const STORE_PREFIX = 'capture:';
/** The capture window keeps its file here, so an in-place refresh after an update still shows it. */
const KEPT_KEY = 'adbg.capture';

const stamp = (ts: number) => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
};

/** Save a timeline, or some of its pages, as a .har file. */
export function downloadHar(t: TabTimeline, pageIds?: Set<string>): void {
  const har = timelineToHar(t, { name: 'Analytics Debugger', version: browser.runtime.getManifest().version }, pageIds);
  const first = t.pages.find((p) => !pageIds || pageIds.has(p.id));
  const host = hostOf(first?.url).replace(/[^\w.-]+/g, '_') || 'capture';
  const url = URL.createObjectURL(new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${host}-${stamp(first?.ts ?? Date.now())}.har`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Read a HAR file and open it in its own window. The window picks the capture up from storage.local,
 * which has its own quota, so a big file doesn't crowd out the live timelines in storage.session.
 */
export async function openCapture(file: File): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error(`${file.name} isn't a HAR file (it isn't JSON).`);
  }
  const { timeline, creator, ignored } = harToTimeline(parsed);
  if (!timeline.events.length) throw new Error(`No analytics requests in ${file.name}.`);
  const capture: Capture = { name: file.name, creator, ignored, timeline };

  // Captures waiting for a window that never opened.
  const stale = Object.keys(await browser.storage.local.get(null)).filter((k) => k.startsWith(STORE_PREFIX));
  if (stale.length) await browser.storage.local.remove(stale);
  const id = crypto.randomUUID();
  await browser.storage.local.set({ [`${STORE_PREFIX}${id}`]: JSON.stringify(capture) });
  await browser.windows.create({
    url: `${browser.runtime.getURL('/sidepanel.html')}?capture=${id}`,
    type: 'popup',
    width: 560,
    height: 900,
  });
}

/** The capture this window was opened for. `null` while loading, `undefined` once it's gone. */
export function useCapture(id: string): Capture | null | undefined {
  const [capture, setCapture] = useState<Capture | null | undefined>(null);
  useEffect(() => {
    void (async () => {
      try {
        const kept = sessionStorage.getItem(KEPT_KEY);
        if (kept) return setCapture(JSON.parse(kept) as Capture);
      } catch {
        /* storage unavailable */
      }
      const key = `${STORE_PREFIX}${id}`;
      const raw = (await browser.storage.local.get(key))[key];
      if (typeof raw !== 'string') return setCapture(undefined);
      setCapture(JSON.parse(raw) as Capture);
      try {
        sessionStorage.setItem(KEPT_KEY, raw);
        await browser.storage.local.remove(key);
      } catch {
        // Too big for sessionStorage: leave it in storage.local so a refresh still finds it.
      }
    })();
  }, [id]);
  return capture;
}
