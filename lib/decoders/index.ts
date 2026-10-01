import { adobeAnalytics } from './adobe-analytics';
import { adobeWebSdk } from './adobe-websdk';
import { ga4 } from './ga4';
import type { CapturedRequest, DecodedEvent, Decoder, VendorId } from './types';

/** Add a vendor by writing a Decoder, listing it here, and adding its URL matcher in match.ts. */
export const decoders: Decoder[] = [adobeAnalytics, adobeWebSdk, ga4];

const byId = new Map(decoders.map((d) => [d.id, d]));

export function decoderFor(id: VendorId): Decoder {
  return byId.get(id)!;
}

export function decodeRequest(vendor: VendorId, req: CapturedRequest): DecodedEvent[] {
  try {
    return decoderFor(vendor).decode(req);
  } catch (err) {
    return [
      {
        vendor,
        eventName: '(decode error)',
        summary: [String(err)],
        groups: [{ title: 'Raw', rows: [{ key: 'url', value: req.url }] }],
      },
    ];
  }
}

export { matchVendor } from './match';
export type { CapturedRequest, DecodedEvent, Decoder, VendorId } from './types';
