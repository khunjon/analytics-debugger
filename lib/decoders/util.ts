import type { ParamGroup, ParamRow } from './types';

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Ordered query-string parse. Unlike URLSearchParams it keeps `+` literal (AppMeasurement and gtag
 * both encode spaces as %20) and keeps valueless keys, which Adobe uses as context-data markers.
 */
export function parseQuery(qs: string): [string, string][] {
  const out: [string, string][] = [];
  for (const part of qs.replace(/^\?/, '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    out.push(i < 0 ? [safeDecode(part), ''] : [safeDecode(part.slice(0, i)), safeDecode(part.slice(i + 1))]);
  }
  return out;
}

export function queryOf(url: string): string {
  const i = url.indexOf('?');
  return i < 0 ? '' : url.slice(i + 1);
}

export function formatScalar(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** Flatten nested JSON into dot/bracket paths: `web.webPageDetails.name`, `productListItems[0].SKU`. */
export function flatten(value: unknown, prefix = '', out: [string, string][] = []): [string, string][] {
  if (value === null || typeof value !== 'object') {
    out.push([prefix, formatScalar(value)]);
  } else if (Array.isArray(value)) {
    if (value.length === 0) out.push([prefix, '[]']);
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
  } else {
    const keys = Object.keys(value);
    if (keys.length === 0 && prefix) out.push([prefix, '{}']);
    for (const k of keys) flatten((value as Record<string, unknown>)[k], prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

export function group(title: string, rows: ParamRow[]): ParamGroup[] {
  return rows.length ? [{ title, rows }] : [];
}

/** Sort keys like v2, v10, v100 numerically. */
export function byTrailingNumber(a: ParamRow, b: ParamRow): number {
  const na = Number(a.key.match(/\d+$/)?.[0] ?? 0);
  const nb = Number(b.key.match(/\d+$/)?.[0] ?? 0);
  return na - nb;
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
