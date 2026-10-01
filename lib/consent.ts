import { describeConsentEntry } from './decoders/adobe-websdk';
import { parsePayload } from './payload';
import type { Row } from './view';

export type ConsentState = 'granted' | 'denied';

/** A consent default or update seen on the timeline. */
export interface ConsentSignal {
  phase: 'default' | 'update';
  /** Who set it: gtag, OneTrust, Cookiebot, Web SDK. */
  by: string;
  /** Effect on analytics and on advertising, when this signal settles them. */
  analytics?: ConsentState;
  ads?: ConsentState;
  summary: string;
}

type Json = Record<string, any>;

const gtagState = (v: unknown): ConsentState | undefined => (v === 'granted' || v === 'denied' ? v : undefined);

/** gtag('consent', 'default' | 'update', {...}). A default limited to some regions can't say what applies here. */
function gtagSignal(phase: unknown, settings: Json): ConsentSignal | undefined {
  if ((phase !== 'default' && phase !== 'update') || !settings || typeof settings !== 'object') return undefined;
  const regional = Array.isArray(settings.region) && settings.region.length > 0;
  const types = Object.entries(settings).filter(([k, v]) => typeof v === 'string' && k !== 'region');
  return {
    phase,
    by: 'gtag',
    analytics: regional ? undefined : gtagState(settings.analytics_storage),
    ads: regional ? undefined : gtagState(settings.ad_storage),
    summary: [types.map(([k, v]) => `${k} ${v}`).join(', '), regional && `(region ${settings.region.join(', ')})`]
      .filter(Boolean)
      .join(' '),
  };
}

/** Adobe consent entries: 2.0 `collect.val` y/n, 1.0 `general` in/out. Collect covers all Adobe data. */
function adobeSignal(consent: unknown, phase: ConsentSignal['phase']): ConsentSignal | undefined {
  if (!Array.isArray(consent)) return undefined;
  let state: ConsentState | undefined;
  for (const entry of consent as Json[]) {
    if (entry?.standard !== 'Adobe') continue;
    const collect = entry.value?.collect?.val ?? entry.value?.general;
    if (collect === 'y' || collect === 'in') state = 'granted';
    else if (collect === 'n' || collect === 'out') state = 'denied';
  }
  return { phase, by: 'Web SDK', analytics: state, ads: state, summary: consent.map((e) => describeConsentEntry(e as Json)).join('; ') };
}

/** OneTrust's default categories: C0002 performance (analytics), C0004 targeting (advertising). */
function oneTrustSignal(p: Json): ConsentSignal | undefined {
  const groups = typeof p.OnetrustActiveGroups === 'string' ? p.OnetrustActiveGroups.split(',').filter(Boolean) : undefined;
  if (!groups) return undefined;
  return {
    phase: p.event === 'OneTrustLoaded' ? 'default' : 'update',
    by: 'OneTrust',
    analytics: groups.includes('C0002') ? 'granted' : 'denied',
    ads: groups.includes('C0004') ? 'granted' : 'denied',
    summary: `active groups ${groups.join(', ') || '(none)'}`,
  };
}

const COOKIEBOT: Record<string, Pick<ConsentSignal, 'analytics' | 'ads'>> = {
  cookie_consent_statistics: { analytics: 'granted' },
  cookie_consent_marketing: { ads: 'granted' },
};

export function consentSignal(row: Row): ConsentSignal | undefined {
  if (row.type === 'hit') {
    if (row.event.vendor !== 'adobe-websdk' || row.decoded.eventName !== 'setConsent') return undefined;
    try {
      return adobeSignal(JSON.parse(row.event.body ?? '').consent, 'update');
    } catch {
      return undefined;
    }
  }
  if (row.type !== 'datalayer') return undefined;
  const p = parsePayload(row.event) as any;
  if (row.event.source === 'dataLayer') {
    if (Array.isArray(p) && p[0] === 'consent') return gtagSignal(p[1], p[2]);
    if (p?.event === 'OneTrustLoaded' || p?.event === 'OneTrustGroupsUpdated') return oneTrustSignal(p);
    const cookiebot = typeof p?.event === 'string' ? COOKIEBOT[p.event] : undefined;
    if (cookiebot) return { phase: 'update', by: 'Cookiebot', ...cookiebot, summary: p.event.replace('cookie_consent_', '') + ' allowed' };
    return undefined;
  }
  if (row.event.source.endsWith('()') && p && typeof p === 'object') {
    if (p.command === 'setConsent') return adobeSignal(p.options?.consent, 'update');
    if (p.command === 'configure' && typeof p.options?.defaultConsent === 'string') {
      const d = p.options.defaultConsent;
      // "pending" holds hits back until consent is set, so nothing should be sent before then.
      const state: ConsentState | undefined = d === 'in' ? 'granted' : d === 'out' || d === 'pending' ? 'denied' : undefined;
      return { phase: 'default', by: 'Web SDK', analytics: state, ads: state, summary: `defaultConsent ${d}` };
    }
  }
  return undefined;
}

/** Which consent a hit needs: advertising for marketing pixels, analytics for everything else. */
export function consentNeeded(row: Extract<Row, { type: 'hit' }>): 'analytics' | 'ads' | undefined {
  const { vendor } = row.event;
  if (vendor === 'adobe-websdk' && row.decoded.eventName === 'setConsent') return undefined;
  // With Consent Mode, GA4 hits carry their own consent state (gcs) and are allowed as cookieless pings.
  if (vendor === 'ga4' && row.decoded.groups.some((g) => g.rows.some((r) => r.key === 'gcs'))) return undefined;
  return vendor === 'pixel' ? 'ads' : 'analytics';
}
