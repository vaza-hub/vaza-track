# @vaza/track

> The 3 KB autonomous-fix telemetry SDK for [vaza.ai](https://vaza.ai).
> Captures only what your CDN does not already provide.

[![npm](https://img.shields.io/npm/v/@vaza/track.svg)](https://www.npmjs.com/package/@vaza/track)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/@vaza/track)](https://bundlephobia.com/package/@vaza/track)

## What it captures

| Signal | Why we need it |
| --- | --- |
| JS errors (with stack traces) | Generate the fix PR for the exact crash |
| Rage clicks (4+ clicks on the same element in 1s) | Surface UX friction the AI can patch |
| Dead clicks (clicks with no UI response) | Detect broken interactive elements |
| Custom business events | Funnel detection for the autonomous loop |
| SPA pageviews (push/replace/popstate) | Track user journeys without server pings |
| Session replay (rrweb, lazy-loaded, sampled) | Give the AI the 10 seconds before each problem |

## What it does NOT capture

Your CDN already collects these. We do not duplicate.

| Signal | Source |
| --- | --- |
| LCP, INP, CLS | Cloudflare Web Analytics + Vercel Speed Insights |
| TTFB, FCP, Page Load Time | Cloudflare Speed Observatory + Vercel Speed Insights |
| Bot detection | Cloudflare WAF + Vercel BotID |
| Page views | Cloudflare Web Analytics (read via API) |

vaza-app reads CDN data directly via the Cloudflare GraphQL API, the Vercel
API, and the Google Search Console API. The SDK only fills the gaps.

## Install

### Script tag

```html
<script async src="https://app.vaza.ai/track.js" data-key="YOUR_CUSTOMER_KEY"></script>
```

### npm

```bash
npm install @vaza/track
```

```ts
import vaza from "@vaza/track"

vaza.init({ key: "YOUR_CUSTOMER_KEY" })
```

## Configuration

```ts
vaza.init({
  /** Required. Customer API key from app.vaza.ai. */
  key: "YOUR_CUSTOMER_KEY",
  /** Optional. Override the vaza-app endpoint. */
  endpoint: "https://app.vaza.ai",
  /** Optional. Disable automatic captures; only custom events fire. */
  manual: false,
  /** Optional. Enable rrweb session replay (lazy-loaded, ~25 KB). */
  replay: false,
  /** Optional. Replay sample rate, 0..1. Defaults to 0.1 (10%). */
  replaySampleRate: 0.1,
  /** Optional. Custom error handler. Returns the captured event. */
  onError: (e) => console.warn("vaza error:", e),
})
```

## Custom events

For tracking business-specific user actions that should feed the
autonomous-fix loop (e.g. funnel steps, form submissions).

```ts
vaza.track("checkout_started", { plan: "pro", price: 199 })
vaza.track("form_submitted", { form: "contact" })
```

The AI agent reads these alongside errors and CWV to detect drop-offs
worth fixing.

## Privacy

- No cookies. Session IDs live in `sessionStorage` (cleared on tab close).
- No fingerprinting. We do not collect IP, advertising IDs, or device hashes.
- No PII unless you explicitly pass it via `vaza.track`. Avoid sending
  email addresses, names, or payment data in custom payloads.
- Self-host the endpoint by setting `endpoint` if your compliance requires it.

## How vaza.ai uses the data

1. Events flow to `app.vaza.ai/api/track`.
2. The autonomous-fix pipeline reads events + CDN metrics + your repo.
3. When a fixable pattern is detected, the AI opens a pull request on your
   git repo with the proposed fix.
4. CI runs, the preview deploy is verified, and the PR is ready to merge.

See [vaza.ai/how-it-works](https://vaza.ai/how-it-works) for the full loop.

## Bundle size

Target: 3 KB gzipped for the base SDK.
Replay (rrweb) is lazy-loaded and only fetched when `replay: true`.

```bash
npm run test:size
```

## License

MIT. See [LICENSE](./LICENSE).
