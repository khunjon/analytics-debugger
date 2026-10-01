const MAX_DEPTH = 10;
const MAX_KEYS = 300;
const MAX_STRING = 5000;

function describeNode(node: Node): string {
  if (typeof Element !== 'undefined' && node instanceof Element) {
    const id = node.id ? `#${node.id}` : '';
    const cls = node.classList.length ? `.${[...node.classList].slice(0, 2).join('.')}` : '';
    return `[Element <${node.tagName.toLowerCase()}${id}${cls}>]`;
  }
  return `[${node.nodeName}]`;
}

/**
 * Turn arbitrary page values (gtag Arguments objects, DOM nodes, functions, cycles) into plain JSON
 * that can cross from the page into the extension. Markers like `[function]` are display-only.
 */
export function serialize(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'undefined') return '[undefined]';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return `[${value.toString()}]`;
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;

  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[max depth]';
  if (typeof Node !== 'undefined' && obj instanceof Node) return describeNode(obj);
  if (typeof Window !== 'undefined' && obj instanceof Window) return '[Window]';
  if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? '[Invalid Date]' : obj.toISOString();
  if (obj instanceof RegExp) return obj.toString();
  if (obj instanceof Error) return `[${obj.name}: ${obj.message}]`;

  seen.add(obj);
  try {
    const tag = Object.prototype.toString.call(obj);
    if (Array.isArray(obj) || tag === '[object Arguments]') {
      return Array.from(obj as ArrayLike<unknown>, (v) => serialize(v, depth + 1, seen));
    }
    if (obj instanceof Map) {
      return Object.fromEntries([...obj].slice(0, MAX_KEYS).map(([k, v]) => [String(k), serialize(v, depth + 1, seen)]));
    }
    if (obj instanceof Set) return [...obj].slice(0, MAX_KEYS).map((v) => serialize(v, depth + 1, seen));

    const out: Record<string, unknown> = {};
    const keys = Object.keys(obj);
    for (const key of keys.slice(0, MAX_KEYS)) {
      try {
        out[key] = serialize((obj as Record<string, unknown>)[key], depth + 1, seen);
      } catch {
        out[key] = '[unreadable]';
      }
    }
    if (keys.length > MAX_KEYS) out['…'] = `${keys.length - MAX_KEYS} more keys`;
    return out;
  } finally {
    seen.delete(obj);
  }
}
