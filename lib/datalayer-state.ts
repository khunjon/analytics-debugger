import { flatten } from './decoders/util';
import { parsePayload, SNAPSHOT_SOURCES } from './payload';
import type { DataLayerEvent } from './types';

type Json = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
/** serialize() turns undefined into this marker. */
const isNil = (v: unknown) => v === null || v === undefined || v === '[undefined]';

/** `{'page.name': 'x'}` -> `{page: {name: 'x'}}`, as GTM's data model expands dotted keys. */
function expandDotted(item: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(item)) {
    const path = key.split('.');
    let target = out;
    for (const part of path.slice(0, -1)) target = (isPlainObject(target[part]) ? target[part] : (target[part] = {})) as Json;
    target[path[path.length - 1]!] = value;
  }
  return out;
}

/** Google's data-layer-helper merge, which GTM's data model uses: objects and arrays merge recursively, unless `_clear` is set. */
function gtmMerge(from: Json | unknown[], to: Json | unknown[]) {
  const allowMerge = !(from as Json)._clear;
  for (const [key, value] of Object.entries(from)) {
    if (key === '_clear') continue;
    const target = to as Json;
    if (allowMerge && Array.isArray(value)) {
      if (!Array.isArray(target[key])) target[key] = [];
      gtmMerge(value, target[key] as unknown[]);
    } else if (allowMerge && isPlainObject(value)) {
      if (!isPlainObject(target[key])) target[key] = {};
      gtmMerge(value, target[key] as Json);
    } else {
      target[key] = value;
    }
  }
}

/** Apply one `dataLayer.push()` to GTM's data model. */
export function applyGtmPush(state: Json, item: unknown): void {
  if (Array.isArray(item)) {
    // Commands. Of these only `set` changes the model; gtag's own (config, event, consent) don't.
    const [command, a, b] = item;
    if (command === 'set') applyGtmPush(state, isPlainObject(a) ? a : typeof a === 'string' ? { [a]: b } : undefined);
    return;
  }
  if (isPlainObject(item)) gtmMerge(expandDotted(item), state);
}

/** The Adobe Client Data Layer's merge: objects merge, arrays are replaced, null or undefined removes a key. */
function acdlMerge(from: Json, to: Json) {
  for (const [key, value] of Object.entries(from)) {
    if (isNil(value)) delete to[key];
    else if (isPlainObject(value)) {
      if (!isPlainObject(to[key])) to[key] = {};
      acdlMerge(value, to[key] as Json);
    } else to[key] = value;
  }
}

/** Apply one `adobeDataLayer.push()`. An event's `event` and `eventInfo` aren't part of the state. */
export function applyAcdlPush(state: Json, item: unknown): void {
  if (!isPlainObject(item)) return;
  if (typeof item.event === 'string') {
    const { event: _event, eventInfo: _eventInfo, ...data } = item;
    acdlMerge(data, state);
  } else {
    acdlMerge(item, state);
  }
}

export interface LayerState {
  source: string;
  state: unknown;
}

const MERGES: Record<string, (state: Json, item: unknown) => void> = {
  dataLayer: applyGtmPush,
  adobeDataLayer: applyAcdlPush,
};

/** Each data layer's computed state after the given pushes, in order. Snapshot sources (digitalData) show their latest value. */
export function dataLayerStates(events: DataLayerEvent[]): LayerState[] {
  const states = new Map<string, unknown>();
  for (const e of events) {
    if (SNAPSHOT_SOURCES.has(e.source)) {
      states.set(e.source, parsePayload(e));
      continue;
    }
    const merge = MERGES[e.source];
    if (!merge) continue;
    const state = (states.get(e.source) as Json | undefined) ?? {};
    // Payloads are shared and cached; merge a copy.
    merge(state, structuredClone(parsePayload(e)));
    states.set(e.source, state);
  }
  return [...states].map(([source, state]) => ({ source, state }));
}

/** Paths whose values differ between two snapshots, shortened to two levels and cut at arrays: `page.pageInfo`, `cart`. */
export function changedPaths(before: unknown, after: unknown, max = 6): string[] {
  const a = new Map(flatten(before));
  const b = new Map(flatten(after));
  const out = new Set<string>();
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) === b.get(key)) continue;
    out.add(key.split('[')[0]!.split('.').slice(0, 2).join('.') || '(root)');
  }
  const list = [...out];
  return list.length > max ? [...list.slice(0, max), `${list.length - max} more`] : list;
}
