const INTERACTIVE = [
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'label',
  '[role=button]',
  '[role=link]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=checkbox]',
  '[role=option]',
  '[onclick]',
].join(',');

function clean(s: string | null | undefined, max = 120): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Visible label for an element. Never reads what a user typed into a text field. */
function textOf(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return clean(aria);
  if (el instanceof HTMLInputElement) {
    if (['submit', 'button', 'reset'].includes(el.type)) return clean(el.value);
    if (['checkbox', 'radio'].includes(el.type)) {
      return clean(`${el.labels?.[0]?.innerText || el.name || el.id} (${el.checked ? 'checked' : 'unchecked'})`);
    }
    return clean(el.labels?.[0]?.innerText || el.placeholder || el.name || el.type);
  }
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    return clean(el.labels?.[0]?.innerText || el.name || el.id);
  }
  const text = el instanceof HTMLElement ? el.innerText : el.textContent;
  if (clean(text)) return clean(text);
  const img = el.querySelector('img[alt]');
  return clean(img?.getAttribute('alt') || el.getAttribute('title'));
}

/** Short, readable selector: up to three levels, stopping at the nearest id. */
function shortSelector(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; cur && i < 3; i++) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      parts.unshift(`${part}#${CSS.escape(cur.id)}`);
      break;
    }
    const classes = [...cur.classList].filter((c) => !/[:[\]/]/.test(c)).slice(0, 2);
    if (classes.length) part += `.${classes.map((c) => CSS.escape(c)).join('.')}`;
    parts.unshift(part);
    cur = cur.parentElement;
    if (!cur || cur === document.body || cur === document.documentElement) break;
  }
  return parts.join(' > ');
}

function dataAttrs(el: Element): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let n = 0;
  for (const attr of el.attributes) {
    if (!attr.name.startsWith('data-') || n >= 8) continue;
    out[attr.name] = clean(attr.value, 100);
    n++;
  }
  return n ? out : undefined;
}

export interface ElementDescription {
  tag: string;
  text: string;
  selector: string;
  href?: string;
  dataAttrs?: Record<string, string>;
}

export function describeTarget(target: EventTarget | null): ElementDescription | undefined {
  const start = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!start) return undefined;
  const el = start.closest(INTERACTIVE) ?? start;
  return {
    tag: el.tagName.toLowerCase(),
    text: textOf(el),
    selector: shortSelector(el),
    href: el instanceof HTMLAnchorElement && el.href ? el.href : undefined,
    dataAttrs: dataAttrs(el),
  };
}

export function describeForm(form: HTMLFormElement, submitter: HTMLElement | null): ElementDescription {
  const name = form.getAttribute('name') || form.id || form.getAttribute('action') || 'form';
  const button = submitter ? textOf(submitter) : '';
  return {
    tag: 'form',
    text: button ? `${name} via "${button}"` : name,
    selector: shortSelector(form),
    dataAttrs: dataAttrs(form),
  };
}
