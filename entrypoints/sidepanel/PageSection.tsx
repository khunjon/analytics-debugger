import { memo, useState } from 'react';
import { decoderFor, type DecodedEvent } from '@/lib/decoders';
import { decodedToMarkdown, pageToMarkdown } from '@/lib/markdown';
import type { DataLayerEvent, HitEvent, InteractionEvent } from '@/lib/types';
import {
  badgeFor,
  clockTime,
  dataLayerTitle,
  hitStatus,
  parsePayload,
  relativeTime,
  rowCategory,
  type PageGroup,
  type Row,
} from '@/lib/view';

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, key: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    });
  };
  return { copied, copy };
}

function displayUrl(url: string): string {
  if (!url) return '(page loaded before capture started)';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}

function compactJson(value: unknown, max = 140): string {
  const s = JSON.stringify(value) ?? '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---------------------------------------------------------------------------------------------

interface PageSectionProps {
  group: PageGroup;
  isLatest: boolean;
  collapsed: boolean;
  onTogglePage: (id: string) => void;
  expanded: Set<string>;
  onToggleRow: (key: string) => void;
}

export function PageSection({ group, isLatest, collapsed, onTogglePage, expanded, onToggleRow }: PageSectionProps) {
  const { page, rows } = group;
  const { copied, copy } = useCopy();
  const hits = rows.filter((r) => r.type === 'hit').length;
  return (
    <section className={`page${isLatest ? ' latest' : ''}`}>
      <div className="page-header">
        <button
          type="button"
          className="page-toggle"
          onClick={() => onTogglePage(page.id)}
          aria-expanded={!collapsed}
          title={page.url}
        >
          <span className="caret" aria-hidden>
            {collapsed ? '▸' : '▾'}
          </span>
          <span className="page-url">{displayUrl(page.url)}</span>
        </button>
        <span className="page-meta" title={new Date(page.ts).toLocaleString()}>
          {clockTime(page.ts).slice(0, 8)} · {hits} hit{hits === 1 ? '' : 's'}
        </span>
        <button type="button" className="link" onClick={() => copy(pageToMarkdown(group), page.id)}>
          {copied === page.id ? 'Copied' : 'Copy'}
        </button>
      </div>
      {!collapsed &&
        (rows.length ? (
          rows.map((row) => (
            <EventRow
              key={row.key}
              row={row}
              pageTs={page.ts}
              expanded={expanded.has(row.key)}
              onToggle={onToggleRow}
            />
          ))
        ) : (
          <div className="no-rows">No matching events on this page.</div>
        ))}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------

function rowText(row: Row): { title: string; detail?: string; summary?: string } {
  switch (row.type) {
    case 'hit': {
      const batch = row.of > 1 ? `${row.index + 1} of ${row.of} in request` : '';
      return {
        title: row.decoded.eventName,
        detail: row.decoded.detail,
        summary: [...row.decoded.summary, batch].filter(Boolean).join(' · '),
      };
    }
    case 'datalayer': {
      const p = parsePayload(row.event);
      return {
        title: dataLayerTitle(row.event),
        summary: p && typeof p === 'object' ? compactJson(p) : undefined,
      };
    }
    case 'interaction':
      return {
        title: row.event.text ? `"${row.event.text}"` : `<${row.event.tag}>`,
        summary: `${row.event.selector}${row.event.href ? ` → ${row.event.href}` : ''}`,
      };
    case 'nav':
      return { title: pathOf(row.event.url), detail: row.event.how === 'hash' ? 'hash change' : 'history change' };
  }
}

interface EventRowProps {
  row: Row;
  pageTs: number;
  expanded: boolean;
  onToggle: (key: string) => void;
}

const EventRow = memo(function EventRow({ row, pageTs, expanded, onToggle }: EventRowProps) {
  const { title, detail, summary } = rowText(row);
  const status = row.type === 'hit' ? hitStatus(row.event) : undefined;
  const late = row.type === 'datalayer' && row.event.late;
  return (
    <div className={`row cat-${rowCategory(row)}${expanded ? ' open' : ''}`}>
      <button type="button" className="row-head" onClick={() => onToggle(row.key)} aria-expanded={expanded}>
        <span className="time" title={`${clockTime(row.ts)}${late ? ' (approximate: picked up by polling)' : ''}`}>
          {late ? '≈' : ''}
          {relativeTime(row.ts, pageTs)}
        </span>
        <span className="badge">{badgeFor(row)}</span>
        <span className="main">
          <span className="title">
            {title}
            {detail && <span className="detail"> {detail}</span>}
          </span>
          {summary && <span className="summary">{summary}</span>}
          {status?.tone === 'error' && <span className="status-error">{status.label}</span>}
        </span>
      </button>
      {expanded && (
        <div className="row-body">
          {row.type === 'hit' && <HitDetail hit={row.event} decoded={row.decoded} />}
          {row.type === 'datalayer' && <DataLayerDetail event={row.event} />}
          {row.type === 'interaction' && <InteractionDetail event={row.event} />}
          {row.type === 'nav' && <div className="mono wrap">{row.event.url}</div>}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------------------------

const COLLAPSED_GROUPS = new Set(['Technical', 'Auto-collected', 'Request']);

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body.split(/\r?\n/).join('\n');
  }
}

function HitDetail({ hit, decoded }: { hit: HitEvent; decoded: DecodedEvent }) {
  const [raw, setRaw] = useState(false);
  const { copied, copy } = useCopy();
  const status = hitStatus(hit);
  const meta = [
    decoderFor(decoded.vendor).label,
    decoded.account && `${decoded.accountLabel ?? 'Account'}: ${decoded.account}`,
    `${hit.method} ${hit.resourceType}`,
    hit.redirectedFrom && 'redirected',
    hit.partial && `captured as it finished${hit.method === 'GET' ? '' : ', request body unavailable'}`,
  ].filter(Boolean);

  return (
    <>
      <div className="detail-bar">
        <span className="meta">
          {meta.join(' · ')} · <span className={`status-${status.tone}`}>{status.label}</span>
        </span>
        <span className="actions">
          <button type="button" className="link" onClick={() => copy(decodedToMarkdown(decoded, hit), 'md')}>
            {copied === 'md' ? 'Copied' : 'Copy as Markdown'}
          </button>
          <button type="button" className="link" onClick={() => copy(hit.url, 'url')}>
            {copied === 'url' ? 'Copied' : 'Copy URL'}
          </button>
          <button type="button" className="link" onClick={() => setRaw((r) => !r)}>
            {raw ? 'Decoded' : 'Raw'}
          </button>
        </span>
      </div>
      {raw ? (
        <>
          <pre className="raw">{hit.url}</pre>
          {hit.body && <pre className="raw">{prettyBody(hit.body)}</pre>}
        </>
      ) : (
        decoded.groups.map((g) => (
          <details key={g.title} className="param-group" open={!COLLAPSED_GROUPS.has(g.title)}>
            <summary>
              {g.title} <span className="count">{g.rows.length}</span>
            </summary>
            <table className="params">
              <tbody>
                {g.rows.map((r, i) => (
                  <tr key={`${r.key}:${i}`}>
                    <th>
                      <span className="label">{r.label ?? r.key}</span>
                      {r.label && r.label !== r.key && <span className="key">{r.key}</span>}
                    </th>
                    <td>
                      {r.value === '' ? <em className="empty-value">(empty)</em> : <span className="value">{r.value}</span>}
                      {r.note && <span className="note">{r.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))
      )}
    </>
  );
}

function DataLayerDetail({ event }: { event: DataLayerEvent }) {
  const { copied, copy } = useCopy();
  const json = JSON.stringify(parsePayload(event), null, 2);
  return (
    <>
      <div className="detail-bar">
        <span className="meta">
          {event.source}
          {event.late && ' · captured by polling, time is approximate'}
        </span>
        <span className="actions">
          <button type="button" className="link" onClick={() => copy(json, 'json')}>
            {copied === 'json' ? 'Copied' : 'Copy JSON'}
          </button>
        </span>
      </div>
      <pre className="raw">{json}</pre>
    </>
  );
}

function InteractionDetail({ event }: { event: InteractionEvent }) {
  const rows: [string, string][] = [
    ['Element', `<${event.tag}>`],
    ['Text', event.text || '(none)'],
    ['Selector', event.selector],
    ...(event.href ? [['Link', event.href] as [string, string]] : []),
    ...Object.entries(event.dataAttrs ?? {}),
    ...(event.synthetic ? [['Note', 'Dispatched by a script, not the user'] as [string, string]] : []),
  ];
  return (
    <table className="params">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>
              <span className="label">{k}</span>
            </th>
            <td>
              <span className="value">{v}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
