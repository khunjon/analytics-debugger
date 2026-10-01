import { flatten, formatScalar } from './decoders/util';
import type { PageGroup, Row } from './view';

/**
 * Search bar terms, comma separated. A term that names a variable present in the timeline (by wire
 * key or friendly label: `eVar12`, `v12`, `pageName`, `page_location`, `ep.method`, `product.sku`)
 * is watched: matching rows show just that variable's value. Any other term filters rows as text.
 * Quoting a term ("events") forces a text search.
 */
export interface QueryTerms {
  watch: string[];
  text: string[];
}

export interface Param {
  key: string;
  label?: string;
  value: string;
}

export interface WatchCell {
  term: string;
  matches: Param[];
  /** The value differs from the previous row of the same source that carried this variable. */
  changed: boolean;
}

/** Case, spaces, underscores, dots and dashes don't matter: `page_location` matches "Page location". */
const normalize = (s: string) => s.toLowerCase().replace(/[\s_.\-]/g, '');

function splitTerms(query: string): { term: string; quoted: boolean }[] {
  return query
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const quoted = /^(["']).*\1$/.test(t) && t.length > 1;
      return { term: quoted ? t.slice(1, -1).trim() : t, quoted };
    })
    .filter((t) => t.term);
}

export function paramMatches(param: Param, term: string): boolean {
  const n = normalize(term);
  if (normalize(param.key) === n) return true;
  if (param.label && normalize(param.label) === n) return true;
  // A dotted term matches the end of a nested path: `webPageDetails.name` -> `web.webPageDetails.name`.
  const t = term.toLowerCase();
  return t.includes('.') && param.key.toLowerCase().endsWith(`.${t}`);
}

/** gtag('event', 'add_to_cart', {...}) pushes arrive as arrays; give them readable keys. */
function dataLayerParams(payload: unknown): Param[] {
  if (Array.isArray(payload) && typeof payload[0] === 'string') {
    const [command, name, params] = payload;
    const head: Param[] = [{ key: command, value: formatScalar(name) }];
    return params && typeof params === 'object' ? [...head, ...toParams(flatten(params))] : head;
  }
  return payload && typeof payload === 'object' ? toParams(flatten(payload)) : [];
}

const toParams = (pairs: [string, string][]): Param[] => pairs.map(([key, value]) => ({ key, value }));

const paramCache = new Map<string, Param[]>();
export function paramsOf(row: Row, parsePayload: (row: Extract<Row, { type: 'datalayer' }>) => unknown): Param[] {
  if (row.type === 'hit') {
    // Watch the value an Adobe dynamic variable resolves to (`D=pageName`), not the reference itself.
    return row.decoded.groups.flatMap((g) =>
      g.rows.map((r) =>
        r.value.startsWith('D=') && r.note?.startsWith('= ') ? { ...r, value: `${r.note.slice(2)} (${r.value})` } : r,
      ),
    );
  }
  if (row.type !== 'datalayer') return [];
  let params = paramCache.get(row.event.id);
  if (!params) {
    params = dataLayerParams(parsePayload(row));
    if (paramCache.size > 5000) paramCache.clear();
    paramCache.set(row.event.id, params);
  }
  return params;
}

/** Classify the query's terms against the variables that actually appear in these groups. */
export function parseTerms(query: string, groups: PageGroup[], params: (row: Row) => Param[]): QueryTerms {
  const terms = splitTerms(query);
  if (!terms.length) return { watch: [], text: [] };
  const candidates = terms.filter((t) => !t.quoted).map((t) => t.term);
  const known = new Set<string>();
  outer: for (const g of groups) {
    for (const row of g.rows) {
      for (const p of params(row)) {
        for (const c of candidates) if (!known.has(c) && paramMatches(p, c)) known.add(c);
        if (known.size === candidates.length) break outer;
      }
    }
  }
  return {
    watch: terms.filter((t) => !t.quoted && known.has(t.term)).map((t) => t.term),
    text: terms.filter((t) => t.quoted || !known.has(t.term)).map((t) => t.term.toLowerCase()),
  };
}

/** Where a value comes from, so changes are compared like for like (AA eVar12 vs AA eVar12). */
export function watchSource(row: Row): string {
  if (row.type === 'hit') return row.event.vendor;
  if (row.type === 'datalayer') return `datalayer:${row.event.source}`;
  return row.type;
}

export function watchCells(
  params: Param[],
  terms: string[],
  source: string,
  lastValues: Map<string, string>,
): WatchCell[] {
  return terms.map((term) => {
    const matches = params.filter((p) => paramMatches(p, term));
    let changed = false;
    if (matches.length) {
      const value = matches.map((m) => m.value).join(' | ');
      const key = `${source}|${normalize(term)}`;
      const previous = lastValues.get(key);
      changed = previous !== undefined && previous !== value;
      lastValues.set(key, value);
    }
    return { term, matches, changed };
  });
}
