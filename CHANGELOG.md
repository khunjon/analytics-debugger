# Changelog

Each release's section becomes its GitHub release notes, so add one before tagging (`## <version>`, matching `package.json`).

## 0.2.0

**Adobe Tags rules on the timeline.** From the first "Library Loaded" rule, each rule shows as `fired`, `condition not met` (with the condition and its settings) or `action failed`, so you see the rules that did nothing as well as the ones that sent a hit.

**What's loaded, per page.** The page header shows the Adobe Tags property, environment (anything but production is highlighted) and build date, the GTM containers with their environment or preview mode, and the active Optimizely experiments and variations.

**Checks.** Rows flag common mistakes, with a count in the page header: duplicate page views, Adobe values over their byte limits, product events missing from `events`, purchases without a `purchaseID`, AA hits sent before the Experience Cloud ID was ready, GA4 names and values over their limits, ecommerce events missing `transaction_id`, `currency` or items, email addresses in any hit, and hits sent while consent was denied or before it was given.

**Consent.** gtag, OneTrust, Cookiebot and Web SDK `setConsent` defaults and updates are marked on the timeline.

**Watch variables.** Type variable names in the search box (`eVar12, events, page_location`) to keep only the hits and data layer pushes that carry them, with their values inline and changes highlighted.

**Compare.** An expanded hit can list what changed since the previous hit of the same kind: changed, added and removed variables, leaving out values that change on every hit.

**Data layer state at each hit.** `dataLayer` merged the way GTM does, `adobeDataLayer` the way the Adobe Client Data Layer does, and the latest `digitalData`.

**More vendors.** Adobe Target (at.js 1 and 2) and Optimizely (`logx` events, with experiment and variation names) are decoded. Web SDK `setConsent`, GA4 consent mode (`gcd`) and an Adobe Analytics events breakdown were added to the existing decoders. Marketing pixels (Meta, Google Ads, Floodlight, TikTok, LinkedIn, Pinterest, Microsoft UET, X) are recognized and named.

**Timeline.** Rows that follow a click within two seconds are nested under it. GTM's own events (`gtm.js`, `gtm.dom`, …) are hidden until you switch on **GTM internals**.

**Faster and safer.** Timelines are stored in chunks, so a new event rewrites one small chunk instead of the whole tab. Events from the page are rebuilt field by field before they're stored. The extension listens only to request types that can carry a hit.

## 0.1.0

First release: a side panel timeline of clicks, data layer pushes and analytics hits grouped by page, decoding Adobe Analytics, Adobe Web SDK and GA4 (including server-side GTM endpoints).
