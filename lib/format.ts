export function hostOf(url: string | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function displayUrl(url: string): string {
  if (!url) return '(page loaded before capture started)';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

export function compactJson(value: unknown, max = 140): string {
  const s = JSON.stringify(value) ?? '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body.split(/\r?\n/).join('\n');
  }
}

/** `2026-09-28T14:02:11Z` -> local date and time without seconds. */
export function shortDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
