export type VendorId = 'adobe-analytics' | 'adobe-websdk' | 'ga4' | 'adobe-target' | 'optimizely' | 'pixel';

export interface ParamRow {
  /** The key as it appears on the wire, e.g. `v12` or `ep.transaction_id`. */
  key: string;
  /** Friendly name, e.g. `eVar12`. Omitted when the key is already readable. */
  label?: string;
  value: string;
  /** Extra context shown muted next to the value, e.g. a resolved `D=` reference. */
  note?: string;
}

export interface ParamGroup {
  title: string;
  rows: ParamRow[];
}

/** One analytics event. A single request can carry several (GA4 batches, Web SDK event arrays). */
export interface DecodedEvent {
  vendor: VendorId;
  /** Primary label: `s.t`, `s.tl`, `add_to_cart`, `web.webpagedetails.pageViews`. */
  eventName: string;
  /** Secondary label: page name, link name, page title. */
  detail?: string;
  account?: string;
  accountLabel?: string;
  /** Short highlights shown under the row title. */
  summary: string[];
  groups: ParamGroup[];
}

export interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

export interface Decoder {
  id: VendorId;
  label: string;
  short: string;
  decode(req: CapturedRequest): DecodedEvent[];
}
