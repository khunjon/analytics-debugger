import { defineContentScript } from 'wxt/utils/define-content-script';
import { installHooks } from '@/lib/page-hooks';
import { PAGE_EVENT_NAME } from '@/lib/types';

const INSTALLED = Symbol.for('analytics-debugger.hooks-installed');

// Runs in the page's JavaScript world so it can see window.dataLayer, _satellite and alloy.
// It has no extension APIs, so events go to relay.content.ts as JSON strings on a DOM event.
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    // The background re-injects this into open tabs after the extension reloads. Hooks from before
    // the reload are still running, so installing a second set would report everything twice.
    const win = window as unknown as Record<symbol, boolean>;
    if (win[INSTALLED]) return;
    win[INSTALLED] = true;
    installHooks(window, (event) => {
      document.dispatchEvent(new CustomEvent(PAGE_EVENT_NAME, { detail: JSON.stringify(event) }));
    });
  },
});
