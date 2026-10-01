import { useContext, useMemo, useState } from 'react';
import type { Issue } from '@/lib/checks';
import { dataLayerStates, type LayerState } from '@/lib/datalayer-state';
import { decoderFor } from '@/lib/decoders';
import type { ParamRow } from '@/lib/decoders/types';
import { flatten } from '@/lib/decoders/util';
import { diffDecoded, type DiffRow } from '@/lib/diff';
import { displayUrl, prettyBody } from '@/lib/format';
import { decodedToMarkdown } from '@/lib/markdown';
import { SNAPSHOT_SOURCES } from '@/lib/payload';
import type { InteractionEvent } from '@/lib/types';
import {
  clockTime,
  componentName,
  hitStatus,
  parsePayload,
  previousHit,
  relativeTime,
  ruleOutcome,
  type HitRow,
  type PageGroup,
  type Row,
} from '@/lib/view';
import { paramMatches } from '@/lib/watch';
import { TimelineContext } from './context';
import { useCopy } from './hooks';

const COLLAPSED_GROUPS = new Set(['Technical', 'Auto-collected', 'Request', 'Context']);
const MAX_STATE_ROWS = 400;

export function IssueList({ issues }: { issues: Issue[] }) {
  return (
    <ul className="issues">
      {issues.map((i, n) => (
        <li key={n} className={i.level}>
          {i.message}
        </li>
      ))}
    </ul>
  );
}

function ParamTable({ rows, highlight }: { rows: ParamRow[]; highlight?: (r: ParamRow) => boolean }) {
  return (
    <table className="params">
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.key}:${i}`} className={highlight?.(r) ? 'watched' : undefined}>
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
  );
}

function ParamGroup({ title, rows, open, highlight }: { title: string; rows: ParamRow[]; open: boolean; highlight?: (r: ParamRow) => boolean }) {
  return (
    <details className="param-group" open={open}>
      <summary>
        {title} <span className="count">{rows.length}</span>
      </summary>
      <ParamTable rows={rows} highlight={highlight} />
    </details>
  );
}

/** The page group a row belongs to, unfiltered, and the rows before it. */
function useRowsBefore(row: Row): { group?: PageGroup; before: Row[] } {
  const groups = useContext(TimelineContext);
  return useMemo(() => {
    const group = groups.find((g) => g.rows.some((r) => r.key === row.key));
    if (!group) return { before: [] };
    const index = group.rows.findIndex((r) => r.key === row.key);
    return { group, before: group.rows.slice(0, index) };
  }, [groups, row.key]);
}

const pushesIn = (rows: Row[]) => rows.flatMap((r) => (r.type === 'datalayer' ? [r.event] : []));

function stateRows(state: unknown): ParamRow[] {
  const pairs = flatten(state);
  const rows = pairs.slice(0, MAX_STATE_ROWS).map(([key, value]) => ({ key, value }));
  if (pairs.length > MAX_STATE_ROWS) rows.push({ key: '…', value: `${pairs.length - MAX_STATE_ROWS} more` });
  return rows;
}

function LayerStates({ states, label }: { states: LayerState[]; label: string }) {
  return (
    <>
      {states.map((s) => (
        <ParamGroup key={s.source} title={`${s.source} ${label}`} rows={stateRows(s.state)} open={false} />
      ))}
    </>
  );
}

// ---- Hits ----

function DiffTable({ title, rows, kind }: { title: string; rows: DiffRow[]; kind: 'changed' | 'added' | 'removed' }) {
  if (!rows.length) return null;
  return (
    <details className="param-group" open>
      <summary>
        {title} <span className="count">{rows.length}</span>
      </summary>
      <table className={`params diff ${kind}`}>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th>
                <span className="label">{r.label ?? r.key}</span>
                {r.label && r.label !== r.key && <span className="key">{r.key}</span>}
              </th>
              <td>
                {r.before !== undefined && <span className="before">{r.before || '(empty)'}</span>}
                {r.after !== undefined && <span className="after">{r.after || '(empty)'}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

function HitDiffView({ row }: { row: HitRow }) {
  const groups = useContext(TimelineContext);
  const previous = useMemo(() => previousHit(groups, row), [groups, row]);
  if (!previous) return <p className="muted">No earlier {decoderFor(row.event.vendor).label} hit on this tab to compare with.</p>;
  const diff = diffDecoded(previous.row.decoded, row.decoded);
  const nothing = !diff.changed.length && !diff.added.length && !diff.removed.length;
  return (
    <>
      <p className="muted">
        Compared with {previous.row.decoded.eventName}
        {previous.row.decoded.detail ? ` (${previous.row.decoded.detail})` : ''} at {relativeTime(previous.row.ts, previous.page.ts)} on{' '}
        {displayUrl(previous.page.url)}. {diff.same} the same
        {diff.ignored.length ? `; ignoring ${diff.ignored.join(', ')}, which change on every hit` : ''}.
      </p>
      {nothing && <p className="muted">No differences.</p>}
      <DiffTable title="Changed" rows={diff.changed} kind="changed" />
      <DiffTable title="Only in this hit" rows={diff.added} kind="added" />
      <DiffTable title="Only in the earlier hit" rows={diff.removed} kind="removed" />
    </>
  );
}

type HitView = 'decoded' | 'raw' | 'diff';

export function HitDetail({ row, watchTerms, issues }: { row: HitRow; watchTerms: string[]; issues?: Issue[] }) {
  const { event: hit, decoded } = row;
  const watched = (r: ParamRow) => watchTerms.some((t) => paramMatches(r, t));
  const [view, setView] = useState<HitView>('decoded');
  const { copied, copy } = useCopy();
  const { before } = useRowsBefore(row);
  const states = useMemo(() => (view === 'decoded' ? dataLayerStates(pushesIn(before)) : []), [before, view]);
  const status = hitStatus(hit);
  const meta = [
    decoderFor(decoded.vendor).label,
    decoded.account && `${decoded.accountLabel ?? 'Account'}: ${decoded.account}`,
    `${hit.method} ${hit.resourceType}`,
    hit.redirectedFrom && 'redirected',
    hit.partial && `captured as it finished${hit.method === 'GET' ? '' : ', request body unavailable'}`,
  ].filter(Boolean);
  const toggle = (v: HitView) => setView((current) => (current === v ? 'decoded' : v));

  return (
    <>
      <div className="detail-bar">
        <span className="meta">
          {meta.join(' · ')} · <span className={`status-${status.tone}`}>{status.label}</span>
        </span>
        <span className="actions">
          <button type="button" className="link" onClick={() => copy(decodedToMarkdown(decoded, hit, '####', issues), 'md')}>
            {copied === 'md' ? 'Copied' : 'Copy as Markdown'}
          </button>
          <button type="button" className="link" onClick={() => copy(hit.url, 'url')}>
            {copied === 'url' ? 'Copied' : 'Copy URL'}
          </button>
          <button type="button" className="link" aria-pressed={view === 'diff'} onClick={() => toggle('diff')}>
            {view === 'diff' ? 'Decoded' : 'Compare'}
          </button>
          <button type="button" className="link" aria-pressed={view === 'raw'} onClick={() => toggle('raw')}>
            {view === 'raw' ? 'Decoded' : 'Raw'}
          </button>
        </span>
      </div>
      {view === 'raw' && (
        <>
          <pre className="raw">{hit.url}</pre>
          {hit.body && <pre className="raw">{prettyBody(hit.body)}</pre>}
        </>
      )}
      {view === 'diff' && <HitDiffView row={row} />}
      {view === 'decoded' && (
        <>
          {decoded.groups.map((g) => (
            <ParamGroup
              key={g.title}
              title={g.title}
              rows={g.rows}
              open={!COLLAPSED_GROUPS.has(g.title) || g.rows.some(watched)}
              highlight={watched}
            />
          ))}
          <LayerStates states={states} label="when this hit was sent" />
        </>
      )}
    </>
  );
}

// ---- Data layer ----

export function DataLayerDetail({ row }: { row: Extract<Row, { type: 'datalayer' }> }) {
  const { event } = row;
  const { copied, copy } = useCopy();
  const [showState, setShowState] = useState(false);
  const { before } = useRowsBefore(row);
  const json = JSON.stringify(parsePayload(event), null, 2);
  const merged = event.source === 'dataLayer' || event.source === 'adobeDataLayer';
  const state = useMemo(
    () => (showState ? dataLayerStates([...pushesIn(before), event]).find((s) => s.source === event.source) : undefined),
    [showState, before, event],
  );
  return (
    <>
      <div className="detail-bar">
        <span className="meta">
          {event.source}
          {event.late && ' · captured by polling, time is approximate'}
          {SNAPSHOT_SOURCES.has(event.source) && row.changed?.length ? ` · changed: ${row.changed.join(', ')}` : ''}
        </span>
        <span className="actions">
          {merged && (
            <button type="button" className="link" aria-pressed={showState} onClick={() => setShowState((s) => !s)}>
              {showState ? 'This push' : 'State after this push'}
            </button>
          )}
          <button type="button" className="link" onClick={() => copy(state ? JSON.stringify(state.state, null, 2) : json, 'json')}>
            {copied === 'json' ? 'Copied' : 'Copy JSON'}
          </button>
        </span>
      </div>
      <pre className="raw">{state ? JSON.stringify(state.state, null, 2) : json}</pre>
    </>
  );
}

// ---- Clicks and rules ----

function KeyValues({ rows }: { rows: [string, string][] }) {
  return <ParamTable rows={rows.map(([key, value]) => ({ key, value }))} />;
}

export function InteractionDetail({ event }: { event: InteractionEvent }) {
  return (
    <KeyValues
      rows={[
        ['Element', `<${event.tag}>`],
        ['Text', event.text || '(none)'],
        ['Selector', event.selector],
        ...(event.href ? [['Link', event.href] as [string, string]] : []),
        ...Object.entries(event.dataAttrs ?? {}),
        ...(event.synthetic ? [['Note', 'Dispatched by a script, not the user'] as [string, string]] : []),
      ]}
    />
  );
}

export function RuleDetail({ row }: { row: Extract<Row, { type: 'rule' }> }) {
  const end = row.outcome ?? (row.event.phase === 'triggered' ? undefined : row.event);
  const outcome = ruleOutcome(row);
  return (
    <>
      <KeyValues
        rows={[
          ['Rule', row.event.ruleName],
          ...(row.event.ruleId ? [['Rule ID', row.event.ruleId] as [string, string]] : []),
          ['Outcome', outcome.label],
          ...(end?.component
            ? [
                [end.phase === 'action-failed' ? 'Action' : 'Condition', `${end.negate ? 'not ' : ''}${componentName(end.component)}`] as [string, string],
                ['Module', end.component] as [string, string],
                ['Settings', end.settings ?? ''] as [string, string],
              ]
            : []),
          ...(end ? [['Finished', `${clockTime(end.ts)} (${end.ts - row.event.ts} ms after it was triggered)`] as [string, string]] : []),
        ]}
      />
    </>
  );
}
