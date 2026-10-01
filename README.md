# Analytics Debugger

[![CI](https://github.com/khunjon/analytics-debugger/actions/workflows/ci.yml/badge.svg)](https://github.com/khunjon/analytics-debugger/actions/workflows/ci.yml)

A Chrome side panel that shows what each page load and interaction actually sends. It puts clicks, data layer pushes, Adobe Tags rules and analytics hits on one timeline, grouped by page, with the hits decoded into readable variables and checked for common mistakes.

```text
▼ www.example.com/products/widget-a                     18:26:25 · 7 events · ▲ 1
  Adobe Tags  Example Store  [staging]  built Sep 28, 2026      Google  GTM-ABC123
   +0.00s  ACDL     { page }
   +0.00s  Rule     Page load: product detail  fired
   +0.01s  AA       s.t  pdp:widget-a        events=prodView · 14 eVars
   +0.01s  GA4      page_view  Widget A
   +0.87s  Click    "Add to cart"            button#atc
   +0.87s    ACDL     event: cart.add
   +0.87s    Rule     Add to cart  fired
   +0.87s    AA       s.tl  add to cart (custom link)   events=scAdd
   +0.87s    GA4      add_to_cart              method=button · 1 item
   +0.87s    GA4      view_cart
                      ▲ No items, so item reports stay empty for this event
```

**Decoded today:** Adobe Analytics (AppMeasurement), Adobe Web SDK (`interact`, `collect` and `setConsent`), GA4 (including server-side GTM endpoints on first-party domains), Adobe Target (at.js 1 and 2), and Optimizely (`logx` events). Marketing pixels (Meta, Google Ads, Floodlight, TikTok, LinkedIn, Pinterest, Microsoft UET, X) are recognized and named so you can see whether they fired.
**Watched in the page:** `dataLayer`, `adobeDataLayer`, `digitalData`, `_satellite.track()` direct calls, Adobe Tags rules, `alloy()` commands, the Adobe Tags build and GTM containers on the page, active Optimizely experiments, clicks and form submits, and SPA route changes.

## Install

**To use it:** download the latest `analytics-debugger-*-chrome.zip` from [Releases](https://github.com/khunjon/analytics-debugger/releases) and unzip it. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped folder. For a new version, replace the folder and click the reload arrow on the extension's card.

**To work on it** (and get updates that install themselves), clone the repo. Requires Node 20 or newer.

```sh
npm install
npm run deploy
```

`deploy` checks, builds and installs the extension into `dist/chrome`, then prints the one-time setup: in Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose `dist/chrome`. Pin the extension and click its icon to open the side panel. It also works in Edge, Brave and Arc.

### Updates install themselves

After the one-time setup you never touch `chrome://extensions` again. Each deploy writes a new `dist/chrome`, and the running extension notices within a second:

- **Side panel changes** (decoders, layout, labels): the open panel refreshes in place.
- **Background, content script or manifest changes:** the extension reloads itself. Captured events are kept, and open tabs keep reporting clicks and data layer pushes without a page reload. The side panel closes; click the icon to reopen it.

Deploys come from three places:

- **Claude Code** runs one automatically at the end of every turn in this project (a Stop hook in `.claude/settings.json`). If the typecheck or tests fail, nothing is installed and Claude is asked to fix it.
- **`npm run watch`** deploys on every save if you edit the code yourself.
- **`npm run deploy`** deploys once.

The installed copy is marked as a dev build so it can't be mistaken for a release: it's named **Analytics Debugger Dev** (in the side panel header, `chrome://extensions` and the toolbar tooltip) and has an inverted, orange icon. Release zips keep the normal name and icon.

A deploy only installs if the typecheck and unit tests pass, so a half-finished change never reaches your browser. Keep Developer mode on: Chrome disables an unpacked extension that reloads itself without it.

### Publishing a release

Bump `version` in `package.json`, commit, then tag and push:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The release workflow checks the tag matches `package.json`, runs the checks, and publishes the zip to Releases. To build the zip locally instead, run `npm run zip`; it lands in `.output/`.

## Using it

- The panel follows whichever tab is active. **Pop out** opens the current tab's timeline in its own window, which is handy on a second monitor.
- Hits are captured even while the panel is closed, so you can open it after the fact. The log survives navigation and is cleared when the browser closes or the tab is closed.
- Click a row to expand it. Hits show their variables grouped and labeled (`v12` shows as **eVar12**, `D=` references are resolved). Use **Raw** for the original URL and body.
- **Copy as Markdown** on a hit, or **Copy** on a page header, gives you tables ready for a ticket or client deliverable.
- The search box filters by text, so typing `scAdd` or `purchase` finds the events that contain it. Separate terms with commas to match any of them.
- **Watch variables** by typing their names in the search box, comma separated: `eVar12, events, page_location`. Only hits and data layer pushes that carry them stay, each showing just those values, with clicks and fired rules kept in between for context. A value that differs from the previous hit of the same type is highlighted, so you can see which interaction changed it. Names match the wire key or the friendly name in any spelling (`eVar12` or `v12`, `pageName` or `page name`, `page_location` or `dl`), dotted paths match nested keys (`product.sku`, `webPageDetails.name`), and Adobe `D=` references show the value they resolve to. Mix in a filter term to narrow it down: `page_view, page_location`. Quote a term (`"events"`) to search it as text instead. While watching, a page's **Copy** button copies a table of the watched values.
- **Compare** on an expanded hit lists what changed since the previous hit of the same kind on the tab (the previous `s.t`, the previous `page_view`): changed, added and removed variables, leaving out values that change on every hit, such as timestamps.
- An expanded hit ends with the **data layer state when it was sent**: `dataLayer` merged the way GTM's data model merges it, `adobeDataLayer` the way the Adobe Client Data Layer does, and the latest `digitalData`. A data layer push has **State after this push**.
- **Adobe Tags rules** appear as they run, from the first "Library Loaded" rule: `fired`, `condition not met` with the condition and its settings, or `action failed`. They come from the library's own monitoring hooks, so you see rules that did nothing as well as the ones that sent a hit.
- Each page's header shows **what's loaded**: the Adobe Tags property, its environment (anything but production is highlighted) and build date, the GTM containers with their environment or preview mode, and the active Optimizely experiments and variations. Optimizely hits show experiment and variation names instead of bare IDs.
- Rows that follow a click within two seconds are **indented under it**, so you can see what the click caused.
- **Checks** flag common mistakes on the row, with a count in the page header: duplicate page views, Adobe values over their byte limits, product events missing from `events`, purchases without a `purchaseID`, AA hits sent before the Experience Cloud ID was ready, GA4 names and values over their limits, ecommerce events missing `transaction_id`, `currency` or items, email addresses in any hit, and hits sent while consent was denied or before it was given.
- **Consent** defaults and updates (gtag, OneTrust, Cookiebot, Web SDK `setConsent`) are marked on the timeline. The consent checks assume OneTrust's default categories (C0002 for analytics, C0004 for advertising), and skip GA4 hits that carry Consent Mode, since those are allowed as cookieless pings.
- GTM's own events (`gtm.js`, `gtm.dom`, `gtm.timer`, …) are hidden until you switch on **GTM internals**.
- The toolbar badge shows how many hits the current page has sent.
- A red label on a row means the hit failed. "Blocked by an extension" means an ad blocker stopped it.

### Things to know

- Network hits are captured from the moment the extension is installed. Data layer and click tracking attach to tabs that were already open, but anything pushed before that point is only picked up once (marked `≈`), so reload a page to see its full page-load sequence.
- A `≈` before a time means the data layer push happened before the extension could wrap `push()`, usually inline code at the top of the page. It was picked up a few milliseconds later, so its time is approximate.
- Data layer and click tracking cover the top-level page only. Hits from iframes are still captured.
- Adobe Tags rules, `digitalData` and the page header's environment info need the page to load with the current version of the extension: after an update, reload the page.
- The panel shows what the browser sends, not what the server returns. Calls made later by server-side GTM or Adobe Event Forwarding happen on the server, so they don't appear. Use Charles for mobile apps.

## Development

```sh
npm run deploy       # typecheck, test, build, and install into dist/chrome (no-op if unchanged)
npm run watch        # the same on every save
npm test             # decoder, timeline and data layer hook unit tests
npm run test:e2e     # loads the extension in Chromium, drives a fixture store page, and exercises live updates
npm run typecheck
```

Icons are rendered from SVG by `node scripts/render-icons.mjs` (release icons into `public/icon/`, dev-build icons into `scripts/dev-icon/`).

The end-to-end test needs Playwright's Chromium once: `npx playwright install chromium`. Its screenshots of the panel land in `test-results/`.

### How it works

```
page (main world)            content script          background worker              side panel
─────────────────            ──────────────          ─────────────────              ──────────
page-hooks.content.ts  ───►  relay.content.ts  ───►  background.ts            ───►  sidepanel/
 wraps dataLayer.push,        forwards events         webRequest: hits                reads storage,
 _satellite.track, alloy;                             webNavigation: pages             decodes hits,
 records clicks                                       writes chrome.storage.session    renders timeline
```

- `lib/decoders/` turns a captured request into one or more events with labeled parameter groups. Decoders are pure functions, and decoding happens in the panel, so improving a decoder changes how existing captures display.
- `lib/timeline.ts` decides which page an event belongs to. It matches on the document that sent the event, so a beacon fired while leaving a page stays with that page. It also defines the storage layout: a record per tab plus the events in chunks of 50, so a new event rewrites one small chunk rather than the whole timeline.
- `lib/page-hooks.ts` must never break the site. Every wrapper calls straight through to what it replaced, and data layer items are read from the array by index, so stacked wrappers from GTM or the Adobe Client Data Layer never double-report. For Adobe Tags rules it catches the library's `window._satellite = window._satellite || {}`, adds a monitor, and turns `_satellite` back into a plain property.
- `lib/checks.ts`, `lib/consent.ts`, `lib/datalayer-state.ts` and `lib/diff.ts` work on decoded events in the panel, like the decoders, so the planned crawler can reuse them.

### Adding a vendor

1. Create `lib/decoders/<vendor>.ts` that exports a `Decoder`: an `id`, labels, and `decode(request)` returning `DecodedEvent[]`. Use `adobe-analytics.ts` as the model. Add the URL test to `lib/decoders/match.ts`; matching lives apart from decoding so that decoder changes stay panel-only updates.
2. Add it to the list in `lib/decoders/index.ts`, add its id to `VendorId` in `lib/decoders/types.ts`, and add a filter chip in `lib/view.ts` and a color in `sidepanel/style.css`.
3. Add sample hits to `tests/unit/decoders.test.ts`. Real hits copied from Charles or DevTools make the best fixtures.

## Roadmap

- **Next:** BlueConic decoder. Client profiles: import an SDR as CSV so `eVar12` shows as "eVar12 · Internal Search Term", picked automatically by domain, along with the expected report suites and measurement IDs.
- **Then:** Validation rules per client on top of the built-in checks (for example, "every `s.t` on /checkout must carry eVar5").
- **Later:** Reuse the decoders and checks in a Playwright script that crawls a site and writes a QA report.

## Contributing

Issues and pull requests are welcome. CI runs the typecheck, unit tests and end-to-end tests on every pull request; run `npm run typecheck && npm test && npm run test:e2e` locally first.

**Never commit client data.** Real hits make the best decoder test fixtures, but replace report suite IDs, measurement IDs, domains, visitor IDs and anything else that identifies a client before adding them to `tests/`.

## License

[MIT](LICENSE)
