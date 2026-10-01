import type { DecodedEvent } from './decoders/types';

/** Values that differ on every hit by design: timestamps, counters, request IDs. */
export const VOLATILE_KEYS = new Set(['t', 'ts', '_s', '_et', 'tfd', '_id', 'timestamp', 'requestId', 'uuid']);

export interface DiffRow {
  key: string;
  label?: string;
  before?: string;
  after?: string;
}

export interface HitDiff {
  changed: DiffRow[];
  added: DiffRow[];
  removed: DiffRow[];
  /** How many variables are the same in both. */
  same: number;
  /** Volatile keys left out of the comparison. */
  ignored: string[];
}

/** Rows by key. A key that repeats (rare) gets `#2`, `#3` so each occurrence is compared. */
function byKey(d: DecodedEvent): Map<string, { label?: string; value: string }> {
  const out = new Map<string, { label?: string; value: string }>();
  for (const g of d.groups) {
    for (const r of g.rows) {
      let key = r.key;
      for (let n = 2; out.has(key); n++) key = `${r.key} #${n}`;
      out.set(key, { label: r.label, value: r.note && r.value.startsWith('D=') ? `${r.value} (${r.note})` : r.value });
    }
  }
  return out;
}

const isVolatile = (key: string) => VOLATILE_KEYS.has(key.split('.').pop()!);

export function diffDecoded(before: DecodedEvent, after: DecodedEvent): HitDiff {
  const a = byKey(before);
  const b = byKey(after);
  const diff: HitDiff = { changed: [], added: [], removed: [], same: 0, ignored: [] };
  for (const [key, row] of b) {
    if (isVolatile(key)) {
      diff.ignored.push(key);
      continue;
    }
    const old = a.get(key);
    if (!old) diff.added.push({ key, label: row.label, after: row.value });
    else if (old.value !== row.value) diff.changed.push({ key, label: row.label, before: old.value, after: row.value });
    else diff.same++;
  }
  for (const [key, row] of a) {
    if (!b.has(key) && !isVolatile(key)) diff.removed.push({ key, label: row.label, before: row.value });
  }
  return diff;
}
