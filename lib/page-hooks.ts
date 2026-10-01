import { describeForm, describeTarget } from './describe-element';
import { serialize } from './serialize';
import type { EnvSource, PageEvent, RuleEvent } from './types';

const WRAPPED = Symbol.for('analytics-debugger.wrapped');
const DATA_LAYERS = ['dataLayer', 'adobeDataLayer'];
/** digitalData, tag manager and Optimizely snapshots: at most this often while polling. */
const SNAPSHOT_EVERY = 500;
const MAX_SETTINGS = 300;
/** Optimizely ID -> name entries per snapshot. Snapshots are stored per page, so this bounds their size. */
const MAX_NAMES = 500;

type AnyFn = ((...args: unknown[]) => unknown) & { [WRAPPED]?: true };
type Json = Record<string, any>;

const toJson = (value: unknown) => JSON.stringify(serialize(value)) ?? 'null';
const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export interface HookOptions {
  now?: () => number;
  /** Set false in tests that run without a DOM. */
  dom?: boolean;
}

/**
 * Runs in the page's own JavaScript context. Watches data layers, Adobe Tags direct calls and rules,
 * Web SDK commands, clicks and form submits, and snapshots digitalData and what's loaded on the page
 * (Adobe Tags build, GTM containers, Optimizely experiments). Reports each through `emit`.
 *
 * Wrapping is deliberately conservative: every wrapper calls straight through to the function it
 * replaced, and data layer items are read from the array itself (tracked by index), so stacked
 * wrappers from GTM or the Adobe Client Data Layer never produce duplicates or change behavior.
 */
export function installHooks(win: any, emit: (e: PageEvent) => void, opts: HookOptions = {}) {
  const now = opts.now ?? (() => Date.now());
  const dom = opts.dom !== false;
  const tracked = new Map<string, { arr: unknown[]; seen: number }>();
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* never break the page */
    }
  };

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
      guard(() => before?.(args, ts));
      try {
        return fn.apply(this, args);
      } finally {
        guard(() => after?.(ts));
      }
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    return wrapped;
  }

  // ---- digitalData (CEDDL): a plain object rather than a push-based layer, so snapshot it when it changes ----

  let lastDigitalData: string | undefined;
  let lastDigitalDataAt = -Infinity;
  function snapshotDigitalData(ts: number) {
    const dd = win.digitalData;
    if (!dd || typeof dd !== 'object') return;
    // Rules triggered together (several on DOM Ready) see the same object; serialize it once.
    if (ts - lastDigitalDataAt < 5) return;
    lastDigitalDataAt = ts;
    const payload = toJson(dd);
    if (payload === lastDigitalData) return;
    lastDigitalData = payload;
    emit({ kind: 'datalayer', source: 'digitalData', ts, payload });
  }

  // ---- Adobe Tags rules, through the library's monitor hooks ----

  let runs = 0;
  // Each rule's runs still waiting for an outcome, oldest first. Turbine reports exactly one outcome per run.
  const waiting = new WeakMap<object, number[]>();
  const queueFor = (rule: object) => {
    let q = waiting.get(rule);
    if (!q) waiting.set(rule, (q = []));
    return q;
  };

  function reportRule(phase: RuleEvent['phase'], e: Json | undefined, component?: Json) {
    const rule = e?.rule;
    if (!rule || typeof rule !== 'object') return;
    const ts = now();
    let run: number;
    if (phase === 'triggered') {
      run = ++runs;
      queueFor(rule).push(run);
      // The rule's conditions and actions read the data layer as it is right now.
      snapshotDigitalData(ts);
    } else {
      run = queueFor(rule).shift() ?? ++runs;
    }
    emit({
      kind: 'rule',
      phase,
      run,
      ts,
      ruleName: String(rule.name ?? rule.id ?? '(unnamed rule)'),
      ...(rule.id ? { ruleId: String(rule.id) } : {}),
      ...(component
        ? {
            component: String(component.modulePath ?? 'unknown'),
            settings: truncate(toJson(component.settings ?? {}), MAX_SETTINGS),
            ...(component.negate ? { negate: true } : {}),
          }
        : {}),
    });
  }

  // Turbine calls monitors without a try/catch, so these must never throw.
  const monitor = {
    ruleTriggered: (e: Json) => guard(() => reportRule('triggered', e)),
    ruleCompleted: (e: Json) => guard(() => reportRule('completed', e)),
    ruleConditionFailed: (e: Json) => guard(() => reportRule('condition-failed', e, e?.condition)),
    ruleActionFailed: (e: Json) => guard(() => reportRule('action-failed', e, e?.action)),
  };

  function attachMonitor(satellite: unknown) {
    if (!satellite || typeof satellite !== 'object') return;
    const s = satellite as Json;
    if (s._monitors === undefined) s._monitors = [];
    if (Array.isArray(s._monitors) && !s._monitors.includes(monitor)) s._monitors.push(monitor);
  }

  /**
   * Turbine reads `_satellite._monitors` each time a rule runs, so the monitor has to be on the object
   * before the library's first rules ("Library Loaded") run. The library starts with
   * `window._satellite = window._satellite || {}`: catch that assignment, add the monitor, and turn
   * `_satellite` back into a plain property. `window._satellite` stays undefined until then.
   */
  function trapSatellite() {
    if (Object.getOwnPropertyDescriptor(win, '_satellite')) return;
    let value: unknown;
    try {
      Object.defineProperty(win, '_satellite', {
        configurable: true,
        enumerable: true,
        get: () => value,
        set(v: unknown) {
          value = v;
          if (!v || typeof v !== 'object') return;
          guard(() => attachMonitor(v));
          guard(() => Object.defineProperty(win, '_satellite', { value: v, writable: true, configurable: true, enumerable: true }));
        },
      });
    } catch {
      /* window not extensible; check() attaches later */
    }
  }

  // ---- Environment: what's loaded on the page ----

  const lastEnv: Partial<Record<EnvSource, string>> = {};
  function emitEnv(source: EnvSource, info: unknown, ts: number) {
    if (!info) return;
    // Plain objects built here from strings: no need for serialize(), which would mark undefined fields.
    const payload = JSON.stringify(info);
    if (lastEnv[source] === payload) return;
    lastEnv[source] = payload;
    emit({ kind: 'env', source, ts, payload });
  }

  function tagsInfo() {
    const s = win._satellite;
    if (!s?.buildInfo) return undefined;
    return {
      property: s.property?.name,
      propertyId: s.property?.id,
      environment: s.environment?.stage,
      buildDate: s.buildInfo.buildDate,
      turbineVersion: s.buildInfo.turbineVersion,
    };
  }

  function gtmInfo() {
    const containers = new Map<string, { id: string; environment?: string; preview?: boolean }>();
    const gtm = win.google_tag_manager;
    if (gtm && typeof gtm === 'object') {
      for (const id of Object.keys(gtm)) if (/^(?:GTM|G|GT|AW|DC)-[A-Z0-9]+$/.test(id)) containers.set(id, { id });
    }
    if (dom) {
      // gtm.js URLs say which environment (gtm_preview=env-N) and whether preview mode is on (gtm_debug).
      for (const script of win.document.querySelectorAll('script[src*="gtm.js?"]')) {
        const url = new URL(script.src, win.location.href);
        const id = url.searchParams.get('id');
        if (!id) continue;
        const env = url.searchParams.get('gtm_preview') ?? undefined;
        containers.set(id, {
          id,
          ...(env ? { environment: env } : {}),
          ...(url.searchParams.has('gtm_debug') ? { preview: true } : {}),
        });
      }
    }
    return containers.size ? { containers: [...containers.values()] } : undefined;
  }

  let optimizelyActive: string | undefined;
  function optimizelyInfo(ts: number) {
    const o = win.optimizely;
    if (!o || typeof o.get !== 'function') return;
    const states: Json = o.get('state')?.getExperimentStates?.({ isActive: true }) ?? {};
    const active = Object.entries(states).map(([id, s]: [string, Json]) => ({
      experimentId: id,
      experiment: s?.experimentName,
      campaign: s?.campaignName,
      variationId: s?.variation?.id,
      variation: s?.variation?.name,
      ...(s?.isInExperimentHoldback ? { holdback: true } : {}),
    }));
    const key = JSON.stringify(active);
    if (key === optimizelyActive) return;
    optimizelyActive = key;
    // Names for the IDs in Optimizely's hits, gathered only when the active experiments change.
    const names: Record<string, string> = {};
    let count = 0;
    const add = (id: unknown, entity: Json | undefined) => {
      const name = entity?.name ?? entity?.apiName;
      if (id != null && typeof name === 'string' && count++ < MAX_NAMES) names[String(id)] = name;
    };
    const data: Json = o.get('data') ?? {};
    for (const kind of ['campaigns', 'experiments', 'variations', 'events', 'pages', 'audiences']) {
      for (const [id, entity] of Object.entries((data[kind] ?? {}) as Json)) {
        add(id, entity);
        for (const v of Array.isArray(entity?.variations) ? entity.variations : []) add(v?.id, v);
      }
    }
    for (const a of active) {
      add(a.experimentId, { name: a.experiment });
      add(a.variationId, { name: a.variation });
    }
    emitEnv('optimizely', { active, names }, ts);
  }

  let lastSnapshot = -Infinity;
  function snapshot() {
    const ts = now();
    if (ts - lastSnapshot < SNAPSHOT_EVERY) return;
    lastSnapshot = ts;
    guard(() => snapshotDigitalData(ts));
    guard(() => emitEnv('adobe-tags', tagsInfo(), ts));
    guard(() => emitEnv('gtm', gtmInfo(), ts));
    guard(() => optimizelyInfo(ts));
  }

  // ---- Wrapping: data layers, _satellite.track, alloy ----

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

    guard(() => {
      const satellite = win._satellite;
      attachMonitor(satellite);
      if (satellite && typeof satellite.track === 'function' && !satellite.track[WRAPPED]) {
        satellite.track = wrap(satellite.track, (args, at) => {
          snapshotDigitalData(at);
          emit({ kind: 'datalayer', source: '_satellite.track', ts: at, payload: toJson({ identifier: args[0], detail: args[1] }) });
        });
      }
    });

    guard(() => {
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
    });
  }

  trapSatellite();
  check();
  snapshot();
  const tick = () => {
    check();
    snapshot();
  };
  // Fast while the page loads, then slower, then a heartbeat for late tags and replaced data layers.
  let interval = setInterval(tick, 50);
  const every = (ms: number) => {
    clearInterval(interval);
    interval = setInterval(tick, ms);
  };
  const slowDowns = [setTimeout(() => every(250), 10_000), setTimeout(() => every(1000), 60_000)];

  let observer: MutationObserver | undefined;
  if (dom) {
    // Capture phase on window runs before the site's own handlers, so the click lands ahead of
    // the data layer pushes and hits it causes.
    win.addEventListener(
      'click',
      (e: MouseEvent) => {
        guard(() => {
          const d = describeTarget(e.target);
          if (d) emit({ kind: 'interaction', action: 'click', ts: now(), ...d, ...(e.isTrusted ? {} : { synthetic: true }) });
        });
      },
      true,
    );
    win.addEventListener(
      'submit',
      (e: SubmitEvent) => {
        guard(() => {
          if (e.target instanceof HTMLFormElement) {
            emit({ kind: 'interaction', action: 'submit', ts: now(), ...describeForm(e.target, e.submitter), ...(e.isTrusted ? {} : { synthetic: true }) });
          }
        });
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
    snapshot,
    stop() {
      clearInterval(interval);
      slowDowns.forEach(clearTimeout);
      observer?.disconnect();
    },
  };
}
