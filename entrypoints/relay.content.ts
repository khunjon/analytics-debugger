import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { PAGE_EVENT_NAME, type PageEvent, type RuntimeMessage } from '@/lib/types';

// Forwards events from page-hooks.content.ts (page world) to the background worker.
// Also injected into open tabs after the extension reloads; WXT invalidates the previous copy then,
// and ctx.addEventListener removes its listener, so events are never forwarded twice.
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  // Don't post WXT's "script started" message to the page; some sites' message handlers choke on it.
  noScriptStartedPostMessage: true,
  main(ctx) {
    ctx.addEventListener(document, PAGE_EVENT_NAME, (e: Event) => {
      const detail = (e as CustomEvent<unknown>).detail;
      if (typeof detail !== 'string') return;
      let event: PageEvent;
      try {
        event = JSON.parse(detail);
      } catch {
        return;
      }
      const msg: RuntimeMessage = { type: 'adbg:page-event', event };
      try {
        browser.runtime.sendMessage(msg).catch(() => {});
      } catch {
        // Extension was reloaded; the background re-injects a fresh relay.
      }
    });

    const onPing = (raw: unknown, _sender: unknown, sendResponse: (r: boolean) => void) => {
      if ((raw as RuntimeMessage)?.type === 'adbg:ping') sendResponse(true);
      return undefined;
    };
    browser.runtime.onMessage.addListener(onPing);
    ctx.onInvalidated(() => browser.runtime.onMessage.removeListener(onPing));
  },
});
