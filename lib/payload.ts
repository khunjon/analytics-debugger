import type { DataLayerEvent, EnvEvent } from './types';

const payloadCache = new Map<string, unknown>();

/** The parsed JSON of a data layer push or environment snapshot. Shared: clone before changing it. */
export function parsePayload(e: DataLayerEvent | EnvEvent): unknown {
  if (payloadCache.has(e.id)) return payloadCache.get(e.id);
  let value: unknown;
  try {
    value = JSON.parse(e.payload);
  } catch {
    value = e.payload;
  }
  if (payloadCache.size > 5000) payloadCache.clear();
  payloadCache.set(e.id, value);
  return value;
}

/** GTM's own events (gtm.js, gtm.dom, gtm.load, gtm.timer, gtm.scrollDepth, …), hidden by default. */
export function isGtmInternal(e: DataLayerEvent): boolean {
  if (e.source !== 'dataLayer') return false;
  const p = parsePayload(e) as { event?: unknown } | null;
  return typeof p?.event === 'string' && p.event.startsWith('gtm.');
}

/** Sources that report a whole object each time (a snapshot) rather than one push. */
export const SNAPSHOT_SOURCES = new Set(['digitalData']);
