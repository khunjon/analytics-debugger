import type { CapturedRequest, DecodedEvent, Decoder, ParamRow } from './types';
import { flatten, group, parseQuery, queryOf } from './util';

type Json = Record<string, any>;

function rowsOf(value: unknown, prefix: string): ParamRow[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'object' && Object.keys(value).length === 0) return [];
  return flatten(value, prefix).map(([key, v]) => ({ key, value: v }));
}

/** Parameters, profile parameters, order and product details of one mbox, view or page load request. */
function requestGroups(item: Json) {
  return [
    ...group('Parameters', rowsOf(item.parameters, 'parameters')),
    ...group('Profile parameters', rowsOf(item.profileParameters, 'profileParameters')),
    ...group('Order', rowsOf(item.order, 'order')),
    ...group('Product', rowsOf(item.product, 'product')),
  ];
}

/** at.js 2 sends one JSON request that can carry a page load, several mboxes, prefetches and notifications. */
function decodeDelivery(url: URL, payload: Json | undefined): DecodedEvent[] {
  const client = url.searchParams.get('client') ?? undefined;
  const shared = [
    ...group('Identity', rowsOf(payload?.id, 'id')),
    ...group('Analytics (A4T)', rowsOf(payload?.experienceCloud, 'experienceCloud')),
    ...group('Context', rowsOf(payload?.context, 'context')),
    ...group('Request', [
      { key: 'endpoint', label: 'Endpoint', value: `${url.host}${url.pathname}` },
      ...['sessionId', 'version'].flatMap((k) => (url.searchParams.get(k) ? [{ key: k, value: url.searchParams.get(k)! }] : [])),
      ...rowsOf(payload?.requestId, 'requestId'),
      ...rowsOf(payload?.property, 'property'),
    ]),
  ];
  const event = (eventName: string, detail: string | undefined, groups: DecodedEvent['groups'], summary: string[] = []): DecodedEvent => ({
    vendor: 'adobe-target',
    eventName,
    detail,
    account: client,
    accountLabel: 'Client code',
    summary,
    groups: [...groups, ...shared],
  });
  const params = (item: Json) => Object.keys(item?.parameters ?? {}).length;
  const paramSummary = (item: Json) => (params(item) ? [`${params(item)} parameter${params(item) === 1 ? '' : 's'}`] : []);

  const events: DecodedEvent[] = [];
  const execute = payload?.execute ?? {};
  if (execute.pageLoad) events.push(event('pageLoad', 'execute', requestGroups(execute.pageLoad), paramSummary(execute.pageLoad)));
  for (const mbox of Array.isArray(execute.mboxes) ? execute.mboxes : []) {
    events.push(event(`mbox: ${mbox?.name ?? '(no name)'}`, 'execute', requestGroups(mbox), paramSummary(mbox)));
  }
  const prefetch = payload?.prefetch ?? {};
  if (prefetch.pageLoad) events.push(event('pageLoad', 'prefetch', requestGroups(prefetch.pageLoad)));
  for (const view of Array.isArray(prefetch.views) ? prefetch.views : []) {
    events.push(event(`views${view?.name ? `: ${view.name}` : ''}`, 'prefetch', requestGroups(view)));
  }
  for (const mbox of Array.isArray(prefetch.mboxes) ? prefetch.mboxes : []) {
    events.push(event(`mbox: ${mbox?.name ?? '(no name)'}`, 'prefetch', requestGroups(mbox)));
  }
  for (const n of Array.isArray(payload?.notifications) ? payload.notifications : []) {
    const target = n?.mbox?.name ?? n?.view?.name;
    events.push(event(`notification: ${n?.type ?? 'unknown'}`, target, group('Notification', rowsOf(n, ''))));
  }
  if (events.length === 0) events.push(event(payload ? '(request without mboxes)' : '(unreadable body)', undefined, []));
  return events;
}

/** at.js 1: `/m2/{client}/mbox/json?mbox=target-global-mbox&mboxSession=...&...` */
function decodeMbox(url: URL, req: CapturedRequest): DecodedEvent[] {
  const params = parseQuery(queryOf(req.url));
  if (req.body && req.method === 'POST') params.push(...parseQuery(req.body));
  const mbox = params.find(([k]) => k === 'mbox')?.[1];
  const client = url.pathname.split('/')[2];
  const isParam = (k: string) => !k.startsWith('mbox') || k === 'mboxParam';
  return [
    {
      vendor: 'adobe-target',
      eventName: `mbox: ${mbox ?? '(no name)'}`,
      account: client,
      accountLabel: 'Client code',
      summary: [],
      groups: [
        ...group('Parameters', params.filter(([k]) => isParam(k)).map(([key, value]) => ({ key, value }))),
        ...group(
          'Request',
          [['endpoint', `${url.host}${url.pathname}`] as [string, string], ...params.filter(([k]) => !isParam(k))].map(
            ([key, value]) => ({ key, value }),
          ),
        ),
      ],
    },
  ];
}

function decode(req: CapturedRequest): DecodedEvent[] {
  const url = new URL(req.url);
  if (url.pathname.includes('/mbox/')) return decodeMbox(url, req);
  let payload: Json | undefined;
  try {
    payload = req.body ? JSON.parse(req.body) : undefined;
  } catch {
    payload = undefined;
  }
  return decodeDelivery(url, payload);
}

export const adobeTarget: Decoder = {
  id: 'adobe-target',
  label: 'Adobe Target',
  short: 'Target',
  decode,
};
