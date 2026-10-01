import type { CapturedRequest, DecodedEvent, Decoder, ParamRow } from './types';
import { flatten, group } from './util';

type Json = Record<string, any>;

function rowsOf(value: unknown, prefix: string, label?: (key: string) => string | undefined): ParamRow[] {
  if (value === undefined) return [];
  if (value && typeof value === 'object' && Object.keys(value).length === 0) return [];
  return flatten(value, prefix).map(([key, v]) => ({ key, label: label?.(key), value: v }));
}

/** `_experience.analytics.customDimensions.eVars.eVar5` -> `eVar5`, `...event1to100.event3.value` -> `event3`. */
function xdmAnalyticsLabel(key: string): string | undefined {
  const m = key.match(/\.(eVar\d+|prop\d+|event\d+)(?:\.value)?$/);
  return m?.[1];
}

function decodeEvent(ev: Json, requestRows: ParamRow[], configId: string | undefined): DecodedEvent {
  const xdm: Json = ev.xdm ?? {};
  const data: Json = ev.data ?? {};
  const { __adobe, ...restData } = data;
  const { analytics, ...restAdobe } = (__adobe ?? {}) as Json;
  const {
    identityMap,
    _experience,
    device,
    environment,
    placeContext,
    implementationDetails,
    timestamp,
    ...restXdm
  } = xdm;
  const { analytics: xdmAnalytics, ...restExperience } = (_experience ?? {}) as Json;
  const xdmMain = Object.keys(restExperience).length ? { ...restXdm, _experience: restExperience } : restXdm;
  const autoCollected = Object.fromEntries(
    Object.entries({ device, environment, placeContext, implementationDetails, timestamp }).filter(([, v]) => v !== undefined),
  );

  const eventType: string | undefined = xdm.eventType;
  const isLink = /linkclick/i.test(eventType ?? '') || Boolean(xdm.web?.webInteraction) || Boolean(analytics?.linkName);
  const detail = isLink
    ? xdm.web?.webInteraction?.name ?? analytics?.linkName
    : xdm.web?.webPageDetails?.name ?? analytics?.pageName;

  const analyticsRows = rowsOf(analytics, '');
  const products = Array.isArray(xdm.productListItems) ? xdm.productListItems.length : 0;
  const summary = [
    analytics?.events && `events=${analytics.events}`,
    analyticsRows.length && `${analyticsRows.length} analytics vars`,
    xdm.commerce && `commerce: ${Object.keys(xdm.commerce).join(', ')}`,
    products && `${products} product${products === 1 ? '' : 's'}`,
    ev.query?.personalization && 'personalization query',
  ].filter((s): s is string => Boolean(s));

  return {
    vendor: 'adobe-websdk',
    eventName: eventType ?? '(no eventType)',
    detail: typeof detail === 'string' ? detail : undefined,
    account: configId,
    accountLabel: 'Datastream',
    summary,
    groups: [
      ...group('Adobe Analytics (data.__adobe.analytics)', analyticsRows),
      ...group('XDM', rowsOf(xdmMain, '')),
      ...group('XDM analytics fields', rowsOf(xdmAnalytics, '_experience.analytics', xdmAnalyticsLabel)),
      ...group('Data', [...rowsOf(restData, ''), ...rowsOf(restAdobe, '__adobe')]),
      ...group('Identity', rowsOf(identityMap, 'identityMap')),
      ...group('Query', rowsOf(ev.query, 'query')),
      ...group('Auto-collected', rowsOf(autoCollected, '')),
      ...group('Request', requestRows),
    ],
  };
}

function decode(req: CapturedRequest): DecodedEvent[] {
  const url = new URL(req.url);
  const configId = url.searchParams.get('configId') ?? undefined;
  let payload: Json | undefined;
  try {
    payload = req.body ? JSON.parse(req.body) : undefined;
  } catch {
    payload = undefined;
  }

  const requestRows: ParamRow[] = [
    { key: 'endpoint', label: 'Edge endpoint', value: `${url.host}${url.pathname}` },
    ...(configId ? [{ key: 'configId', label: 'Datastream ID', value: configId }] : []),
    ...(url.searchParams.get('requestId') ? [{ key: 'requestId', value: url.searchParams.get('requestId')! }] : []),
    ...rowsOf(payload?.meta?.configOverrides, 'meta.configOverrides'),
    ...rowsOf(payload?.meta?.state?.domain, 'meta.state.domain'),
    ...rowsOf(payload?.query, 'query'),
  ];

  const events: Json[] = Array.isArray(payload?.events) ? payload.events : [];
  if (events.length === 0) {
    return [
      {
        vendor: 'adobe-websdk',
        eventName: payload ? '(request without events)' : '(unreadable body)',
        account: configId,
        accountLabel: 'Datastream',
        summary: [],
        groups: group('Request', requestRows),
      },
    ];
  }
  return events.map((ev) => decodeEvent(ev, requestRows, configId));
}

export const adobeWebSdk: Decoder = {
  id: 'adobe-websdk',
  label: 'Adobe Web SDK',
  short: 'WebSDK',
  decode,
};
