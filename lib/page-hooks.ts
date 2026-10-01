import { describeForm, describeTarget } from './describe-element';
import { serialize } from './serialize';
import type { PageEvent } from './types';

const WRAPPED = Symbol.for('analytics-debugger.wrapped');
const DATA_LAYERS = ['dataLayer', 'adobeDataLayer'];

type AnyFn = ((...args: unknown[]) => unknown) & { [WRAPPED]?: true };

const toJson = (value: unknown) => JSON.stringify(serialize(value)) ?? 'null';

export interface HookOptions {
  now?: () => number;
  /** Set false in tests that run without a DOM. */
  dom?: boolean;
}

/**
 * Runs in the page's own JavaScript context. Watches data layers, Adobe Tags direct calls and Web SDK
 * commands, plus clicks and form submits, and reports each through `emit`.
 *
 * Wrapping is deliberately conservative: every wrapper calls straight through to the function it
 * replaced, and data layer items are read from the array itself (tracked by index), so stacked
 * wrappers from GTM or the Adobe Client Data Layer never produce duplicates or change behavior.
 */
export function installHooks(win: any, emit: (e: PageEvent) => void, opts: HookOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const tracked = new Map<string, { arr: unknown[]; seen: number }>();

  function flush(name: string, ts: number, late: boolean) {
    const t = tracked.get(name);
    if (!t) return;
    if (t.arr.length < t.seen) t.seen = t.arr.length;
    while (t.seen < t.arr.length) {
      const item = t.arr[t.seen++];
      emit({ kind: 'datalayer', source: name, ts, payload: toJson(item), ...(late ? { late: true } : {}) });
    }
  }

  function wrap(fn: AnyFn, before?: (args: unknown[], ts: number) => void, after?: (ts: number) => void): AnyFn {
    const wrapped: AnyFn = function (this: unknown, ...args: unknown[]) {
      const ts = now();
      try {
        before?.(args, ts);
      } catch {
        /* never break the page */
      }
      try {
        return fn.apply(this, args);
      } finally {
        try {
          after?.(ts);
        } catch {
          /* never break the page */
        }
      }
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    return wrapped;
  }

  function check() {
    const ts = now();
    for (const name of DATA_LAYERS) {
      let arr: unknown;
      try {
        arr = win[name];
      } catch {
        continue;
      }
      if (!Array.isArray(arr)) continue;
      let t = tracked.get(name);
      if (!t || t.arr !== arr) {
        t = { arr, seen: 0 };
        tracked.set(name, t);
      }
      // Anything pushed before we wrapped push, or by code that bypasses it.
      flush(name, ts, true);
      const push = (arr as unknown as { push: AnyFn }).push;
      if (typeof push === 'function' && !push[WRAPPED]) {
        try {
          (arr as unknown as { push: AnyFn }).push = wrap(push, undefined, (at) => flush(name, at, false));
        } catch {
          /* frozen array */
        }
      }
    }

    try {
      const satellite = win._satellite;
      if (satellite && typeof satellite.track === 'function' && !satellite.track[WRAPPED]) {
        satellite.track = wrap(satellite.track, (args, at) =>
          emit({ kind: 'datalayer', source: '_satellite.track', ts: at, payload: toJson({ identifier: args[0], detail: args[1] }) }),
        );
      }
    } catch {
      /* ignore */
    }

    try {
      const names: unknown = win.__alloyNS;
      for (const n of Array.isArray(names) ? names : []) {
        const fn = win[n];
        // Leave the pre-load stub alone: it queues commands on its own `.q` property, which the library reads.
        if (typeof fn === 'function' && !fn[WRAPPED] && !Array.isArray(fn.q)) {
          win[n] = wrap(fn, (args, at) =>
            emit({ kind: 'datalayer', source: `${n}()`, ts: at, payload: toJson({ command: args[0], options: args[1] }) }),
          );
        }
      }
    } catch {
      /* ignore */
    }
  }

  check();
  let interval = setInterval(check, 50);
  const slowDown = setTimeout(() => {
    clearInterval(interval);
    interval = setInterval(check, 250);
  }, 10_000);

  let observer: MutationObserver | undefined;
  if (opts.dom !== false) {
    // Capture phase on window runs before the site's own handlers, so the click lands ahead of
    // the data layer pushes and hits it causes.
    win.addEventListener(
      'click',
      (e: MouseEvent) => {
        try {
          const d = describeTarget(e.target);
          if (d) emit({ kind: 'interaction', action: 'click', ts: now(), ...d, ...(e.isTrusted ? {} : { synthetic: true }) });
        } catch {
          /* ignore */
        }
      },
      true,
    );
    win.addEventListener(
      'submit',
      (e: SubmitEvent) => {
        try {
          if (e.target instanceof HTMLFormElement) {
            emit({ kind: 'interaction', action: 'submit', ts: now(), ...describeForm(e.target, e.submitter), ...(e.isTrusted ? {} : { synthetic: true }) });
          }
        } catch {
          /* ignore */
        }
      },
      true,
    );
    // Inline tag snippets create the data layer while the document parses. A mutation callback runs
    // right after each inserted script, which wraps push much sooner than the timer would.
    observer = new MutationObserver(check);
    observer.observe(win.document, { childList: true, subtree: true });
    win.addEventListener('load', () => setTimeout(() => observer?.disconnect(), 10_000), { once: true });
  }

  return {
    check,
    stop() {
      clearInterval(interval);
      clearTimeout(slowDown);
      observer?.disconnect();
    },
  };
}
