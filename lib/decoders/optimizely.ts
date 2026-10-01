import type { CapturedRequest, DecodedEvent, Decoder, ParamRow } from './types';
import { flatten, formatScalar, group } from './util';

type Json = Record<string, any>;

// Optimizely Web compresses the Event API's field names; the SDKs send them in full.
const EVENT_KEYS: Record<string, string> = { e: 'entity_id', y: 'type', u: 'uuid', t: 'timestamp', k: 'key', a: 'tags', n: 'name' };
const DECISION_KEYS: Record<string, string> = { c: 'campaign_id', x: 'experiment_id', v: 'variation_id', h: 'is_campaign_holdback' };
const ATTRIBUTE_KEYS: Record<string, string> = { e: 'entity_id', k: 'key', t: 'type', v: 'value' };

const expand = (obj: unknown, keys: Record<string, string>): Json =>
  obj && typeof obj === 'object' ? Object.fromEntries(Object.entries(obj).map(([k, v]) => [keys[k] ?? k, v])) : {};

function rowsOf(value: unknown, prefix: string): ParamRow[] {
  if (value === undefined || value === null) return [];
  return flatten(value, prefix).map(([key, v]) => ({ key, value: v }));
}

function decodeEvent(ev: Json, decisions: Json[], visitor: Json, payload: Json): DecodedEvent {
  const event = expand(ev, EVENT_KEYS);
  const attributes = (Array.isArray(visitor.attributes) ? visitor.attributes : []).map((a: unknown) => expand(a, ATTRIBUTE_KEYS));
  const eventName = String(event.key || event.type || '(no event key)');
  const tags = event.tags && typeof event.tags === 'object' ? Object.keys(event.tags).length : 0;
  return {
    vendor: 'optimizely',
    eventName,
    detail: typeof event.name === 'string' ? event.name : undefined,
    account: formatScalar(payload.project_id ?? payload.account_id),
    accountLabel: payload.project_id ? 'Project' : 'Account',
    summary: [
      decisions.length && `${decisions.length} decision${decisions.length === 1 ? '' : 's'}`,
      tags && `${tags} tag${tags === 1 ? '' : 's'}`,
      event.revenue !== undefined && `revenue=${event.revenue}`,
    ].filter((s): s is string => Boolean(s)),
    groups: [
      ...group('Event', rowsOf(event, '')),
      ...group('Decisions', decisions.flatMap((d, i) => rowsOf(d, `decisions[${i}]`))),
      ...group(
        'Attributes',
        attributes.map((a: Json) => ({ key: String(a.key ?? a.entity_id), label: a.type, value: formatScalar(a.value) })),
      ),
      ...group('Visitor', [
        ...rowsOf(visitor.visitor_id, 'visitor_id'),
        ...rowsOf(visitor.session_id, 'session_id'),
      ]),
      ...group(
        'Request',
        ['account_id', 'project_id', 'revision', 'client_name', 'client_version', 'anonymize_ip', 'enrich_decisions'].flatMap((k) =>
          rowsOf(payload[k], k),
        ),
      ),
    ],
  };
}

function decode(req: CapturedRequest): DecodedEvent[] {
  let payload: Json | undefined;
  try {
    payload = req.body ? JSON.parse(req.body) : undefined;
  } catch {
    payload = undefined;
  }
  const events: DecodedEvent[] = [];
  for (const visitor of Array.isArray(payload?.visitors) ? payload!.visitors : []) {
    for (const snapshot of Array.isArray(visitor?.snapshots) ? visitor.snapshots : []) {
      const decisions = (Array.isArray(snapshot?.decisions) ? snapshot.decisions : []).map((d: unknown) => expand(d, DECISION_KEYS));
      for (const ev of Array.isArray(snapshot?.events) ? snapshot.events : []) events.push(decodeEvent(ev, decisions, visitor, payload!));
    }
  }
  if (events.length) return events;
  return [
    {
      vendor: 'optimizely',
      eventName: payload ? '(request without events)' : '(unreadable body)',
      summary: [],
      groups: group('Request', rowsOf(payload ?? {}, '')),
    },
  ];
}

/**
 * Hits carry only IDs. The page's `optimizely.get('data')` maps them to names; the panel passes that
 * map in here, so each ID gets its name as a note and an unnamed event takes the name of its entity.
 */
export function withOptimizelyNames(d: DecodedEvent, names: Record<string, string>): DecodedEvent {
  let named = false;
  const groups = d.groups.map((g) => ({
    ...g,
    rows: g.rows.map((r) => {
      const name = /(?:^|\.)(?:entity_id|campaign_id|experiment_id|variation_id)$/.test(r.key) ? names[r.value] : undefined;
      if (!name || r.note) return r;
      named = true;
      return { ...r, note: name };
    }),
  }));
  if (!named) return d;
  const entity = d.groups.find((g) => g.title === 'Event')?.rows.find((r) => r.key === 'entity_id')?.value;
  return { ...d, groups, detail: d.detail ?? (entity ? names[entity] : undefined) };
}

export const optimizely: Decoder = {
  id: 'optimizely',
  label: 'Optimizely',
  short: 'Opti',
  decode,
};
