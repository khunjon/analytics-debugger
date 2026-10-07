import type { EnvSource, PageEvent, RuleEvent } from './types';

/**
 * Any script on a page can dispatch the event the relay listens for, so the background rebuilds each
 * page event from the fields its kind allows. A page can't add hits or other kinds, set ids or
 * pages, or store an oversized payload.
 */

/** Longest data layer or environment payload kept, in characters. */
export const MAX_PAYLOAD = 500_000;
const MAX_TEXT = 2000;

const RULE_PHASES = new Set<RuleEvent['phase']>(['triggered', 'completed', 'condition-failed', 'action-failed']);
const ENV_SOURCES = new Set<EnvSource>(['adobe-tags', 'gtm', 'optimizely']);

const text = (v: unknown, max = MAX_TEXT) => (typeof v === 'string' ? (v.length > max ? `${v.slice(0, max - 1)}…` : v) : undefined);
const payload = (v: unknown) => {
  if (typeof v !== 'string') return undefined;
  return v.length > MAX_PAYLOAD ? JSON.stringify(`[payload too large: ${Math.round(v.length / 1000)} KB]`) : v;
};
const optional = <K extends string>(key: K, v: string | undefined) => (v === undefined ? {} : ({ [key]: v } as Record<K, string>));

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v).slice(0, 20)) {
    const s = text(value, 200);
    if (s !== undefined) out[k.slice(0, 100)] = s;
  }
  return out;
}

export function sanitizePageEvent(raw: unknown): PageEvent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const e = raw as Record<string, unknown>;
  const ts = e.ts;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return undefined;

  switch (e.kind) {
    case 'datalayer': {
      const source = text(e.source, 100);
      const p = payload(e.payload);
      if (source === undefined || p === undefined) return undefined;
      return { kind: 'datalayer', ts, source, payload: p, ...(e.late === true ? { late: true } : {}) };
    }
    case 'interaction': {
      if (e.action !== 'click' && e.action !== 'submit') return undefined;
      const dataAttrs = stringRecord(e.dataAttrs);
      return {
        kind: 'interaction',
        action: e.action,
        ts,
        text: text(e.text) ?? '',
        selector: text(e.selector) ?? '',
        tag: text(e.tag, 50) ?? '',
        ...optional('href', text(e.href)),
        ...(dataAttrs && Object.keys(dataAttrs).length ? { dataAttrs } : {}),
        ...(e.synthetic === true ? { synthetic: true } : {}),
      };
    }
    case 'rule': {
      const phase = e.phase as RuleEvent['phase'];
      if (!RULE_PHASES.has(phase) || typeof e.run !== 'number') return undefined;
      return {
        kind: 'rule',
        phase,
        run: e.run,
        ts,
        ruleName: text(e.ruleName, 500) ?? '(unnamed rule)',
        ...optional('ruleId', text(e.ruleId, 200)),
        ...optional('component', text(e.component, 500)),
        ...optional('settings', text(e.settings)),
        ...(e.negate === true ? { negate: true } : {}),
      };
    }
    case 'env': {
      const source = e.source as EnvSource;
      const p = payload(e.payload);
      if (!ENV_SOURCES.has(source) || p === undefined) return undefined;
      return { kind: 'env', ts, source, payload: p };
    }
    default:
      return undefined;
  }
}
