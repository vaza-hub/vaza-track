/**
 * vaza-track — autonomous-fix telemetry SDK.
 *
 * Captures only what the customer's CDN does NOT already provide:
 *   - JS errors with stack traces
 *   - Rage clicks (4+ clicks on the same element in 1s)
 *   - Dead clicks (clicks on non-interactive elements that produce no DOM change)
 *   - Custom business events
 *   - SPA pageviews
 *   - Optional: lazy-loaded rrweb session replay
 *
 * Skipped on purpose (CDN provides):
 *   - LCP, INP, CLS, TTFB, FCP
 *   - Page load time
 *   - Bot detection
 *
 * Designed to be tree-shaken and minified to ~3 KB gzipped.
 */

interface VazaTrackOptions {
  /** Customer API key from app.vaza.ai. */
  key: string
  /** Endpoint base URL. Defaults to https://app.vaza.ai. */
  endpoint?: string
  /** Disable any automatic captures. Custom events still work. */
  manual?: boolean
  /** Forward errors to a custom handler in addition to vaza. */
  onError?: (error: ErrorEventPayload) => void
}

interface BaseEvent {
  type: string
  url: string
  ts: number
  session_id: string
  /** Free-form payload. */
  payload?: Record<string, unknown>
}

interface ErrorEventPayload extends BaseEvent {
  type: "error"
  message: string
  stack?: string
  file?: string
  line?: number
  column?: number
}

interface ClickEventPayload extends BaseEvent {
  type: "click" | "rage_click" | "dead_click"
  selector: string
  text?: string
  count?: number
  coord_x?: number
  coord_y?: number
  /** click/rage/dead carry { time_on_page_ms }; dead_click additionally
   *  carries { interactive } — true means a real control (button, link,
   *  role=button…) swallowed the click, the classic broken-CTA signal. */
  payload?: Record<string, unknown>
}

interface PageviewEventPayload extends BaseEvent {
  type: "pageview"
  referrer?: string
  title?: string
}

interface CustomEventPayload extends BaseEvent {
  type: "custom"
  name: string
}

interface ScrollEventPayload extends BaseEvent {
  type: "scroll"
  scroll_max_y: number
}

interface VisibilityEventPayload extends BaseEvent {
  type: "visibility"
  state: "hidden" | "visible"
}

interface FormSubmitEventPayload extends BaseEvent {
  type: "form_submit"
  selector: string
  payload: { field_count: number; form_id: string; src?: string }
}

/** A form became ≥50% visible — the denominator for per-placement conversion.
 *  Emitted once per form element per page load. Without it, submit counts
 *  can't be turned into rates: a sticky-rail form "outperforming" a footer
 *  form may just be seen ten times as often. */
interface FormImpressionEventPayload extends BaseEvent {
  type: "form_impression"
  selector: string
  payload: { form_id?: string; src?: string }
}

interface InputEventPayload extends BaseEvent {
  type: "input"
  selector: string
  payload: { field_type: string; field_name?: string }
}

interface NetworkErrorEventPayload extends BaseEvent {
  type: "network_error"
  payload: {
    target_url: string
    method: string
    status: number
    duration_ms: number
  }
}

interface WebVitalEventPayload extends BaseEvent {
  type: "web_vital"
  payload: {
    metric: "LCP" | "INP" | "CLS"
    value: number
    rating: "good" | "needs-improvement" | "poor"
  }
}

/** Derived signal: the visitor engaged with a form's fields but left the
 *  page without submitting it. Never carries field values. */
interface FormAbandonEventPayload extends BaseEvent {
  type: "form_abandon"
  selector: string
  payload: { fields_touched: number; last_field?: string; form_id?: string; src?: string }
}

/** Derived signal: the visitor left within seconds of landing without any
 *  meaningful interaction — the classic pogo-stick bounce. */
interface QuickBackEventPayload extends BaseEvent {
  type: "quick_back"
  payload: { seconds_on_page: number }
}

/** Derived signal: rapid up-down scrolling — the visitor is hunting for
 *  something they can't find (Clarity's "excessive scrolling"). */
interface ScrollThrashEventPayload extends BaseEvent {
  type: "scroll_thrash"
  payload: { reversals: number; distance_px: number; time_on_page_ms: number }
}

type VazaEvent =
  | ErrorEventPayload
  | ClickEventPayload
  | PageviewEventPayload
  | CustomEventPayload
  | ScrollEventPayload
  | VisibilityEventPayload
  | FormSubmitEventPayload
  | FormImpressionEventPayload
  | InputEventPayload
  | NetworkErrorEventPayload
  | WebVitalEventPayload
  | FormAbandonEventPayload
  | QuickBackEventPayload
  | ScrollThrashEventPayload

const SESSION_KEY = "vz_sid"
const SESSION_TIMEOUT_MS = 30 * 60 * 1000 // 30 min idle = new session
const RAGE_CLICK_WINDOW_MS = 1000
const RAGE_CLICK_THRESHOLD = 4
const DEAD_CLICK_TIMEOUT_MS = 600

/** Counts every DOM mutation (childList/attributes/characterData, subtree)
 *  since load. Dead-click detection snapshots this at click time — any UI
 *  reaction (spinner, class toggle, modal, React re-render) increments it,
 *  which the old `document.body.childNodes.length` comparison missed for
 *  everything but top-level inserts. */
let domMutations = 0

/** Epoch ms of the current pageview (reset on SPA route change) so click
 *  events can carry time_on_page_ms — time-to-first-CTA-click and friends
 *  are conversion metrics the raw `ts` can't give without joining events. */
let pageLandedAt = Date.now()

function observeDomMutations(): void {
  if (typeof MutationObserver === "undefined" || !document.documentElement) return
  new MutationObserver(() => {
    domMutations++
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  })
}

let options: VazaTrackOptions | null = null
let sessionId = ""
let queue: VazaEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function genId(): string {
  // 16 hex chars, ~64 bits of entropy, plenty for session uniqueness.
  const a = new Uint8Array(8)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("")
}

function getOrCreateSession(): string {
  try {
    const now = Date.now()
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as { id: string; last: number }
      if (now - parsed.last < SESSION_TIMEOUT_MS) {
        parsed.last = now
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(parsed))
        return parsed.id
      }
    }
    const id = genId()
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, last: now }))
    return id
  } catch {
    // sessionStorage unavailable (Safari private, embedded iframe, etc.)
    return genId()
  }
}

function selectorFor(el: Element): string {
  if (!el || el === document.documentElement) return "html"
  if (el.id) return `#${el.id}`.slice(0, 200)
  const parts: string[] = []
  let current: Element | null = el
  while (current && current !== document.documentElement && parts.length < 4) {
    // Non-Element nodes (document, text) have no tagName — stop walking.
    if (typeof current.tagName !== "string") break
    let part = current.tagName.toLowerCase()
    if (current.classList.length > 0) {
      // Cap class names to avoid runaway selectors on Tailwind-heavy markup.
      part +=
        "." +
        Array.from(current.classList)
          .slice(0, 2)
          .map((c) => c.slice(0, 40))
          .join(".")
    }
    parts.unshift(part)
    current = current.parentElement
  }
  return parts.join(">").slice(0, 200)
}

const FRUSTRATION_TYPES = new Set([
  "error",
  "rage_click",
  "dead_click",
  "form_abandon",
  "scroll_thrash",
])

function enqueue(event: VazaEvent): void {
  // Frustration is the replay trigger: the rolling buffer only ever
  // leaves the browser when a visitor actually struggled.
  if (FRUSTRATION_TYPES.has(event.type)) replayOnFrustration()
  queue.push(event)
  // Cap queue at 200 to avoid memory blowups on broken pages.
  if (queue.length > 200) queue = queue.slice(-200)
  scheduleFlush()
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(flush, 1500)
}

function flush(): void {
  flushTimer = null
  if (!options || queue.length === 0) return

  // Custom payloads can contain circular refs (e.g. React fiber objects).
  // Bail gracefully instead of throwing into the caller's app.
  let payload: string
  try {
    payload = JSON.stringify({ key: options.key, events: queue })
  } catch {
    queue = []
    return
  }
  queue = []
  const url = (options.endpoint ?? "https://app.vaza.ai") + "/api/track"

  // Prefer sendBeacon so the request survives navigation; fall back to fetch.
  // IMPORTANT: blob type must be a "CORS-simple" content type (text/plain,
  // application/x-www-form-urlencoded, or multipart/form-data). Using
  // application/json triggers a preflight that sendBeacon cannot perform,
  // and the browser silently drops the request as a CORS error. The
  // /api/track route reads `await request.json()` which ignores the
  // declared Content-Type, so text/plain is safe on the wire.
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "text/plain" })
      const ok = navigator.sendBeacon(url, blob)
      if (ok) return
    }
  } catch {
    // sendBeacon can throw on some browsers; fall through.
  }
  void fetch(url, {
    method: "POST",
    keepalive: true,
    // Same reasoning: keep this as text/plain to avoid the preflight that
    // sendBeacon avoided. The server reads the body via request.json()
    // regardless of the declared Content-Type.
    headers: { "Content-Type": "text/plain" },
    body: payload,
  }).catch(() => {
    // Silent fail. Telemetry is best-effort.
  })
}

function captureErrors(): void {
  window.addEventListener("error", (e) => {
    const ev: ErrorEventPayload = {
      type: "error",
      url: location.href,
      ts: Date.now(),
      session_id: sessionId,
      message: e.message,
      stack: e.error?.stack,
      file: e.filename,
      line: e.lineno,
      column: e.colno,
    }
    if (options?.onError) options.onError(ev)
    enqueue(ev)
  })
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason
    const ev: ErrorEventPayload = {
      type: "error",
      url: location.href,
      ts: Date.now(),
      session_id: sessionId,
      message:
        typeof reason === "string"
          ? reason
          : reason?.message || "unhandled rejection",
      stack: reason?.stack,
    }
    if (options?.onError) options.onError(ev)
    enqueue(ev)
  })
}

interface ClickHistory {
  selector: string
  times: number[]
}

function captureClicks(): void {
  const recent: ClickHistory[] = []
  document.addEventListener(
    "click",
    (e) => {
      // e.target can be a Text node (Safari) or the document itself —
      // resolve to the nearest Element or drop the event.
      const raw = e.target as EventTarget | null
      const target =
        raw instanceof Element
          ? raw
          : ((raw as Node | null)?.parentElement ?? null)
      if (!target) return
      const selector = selectorFor(target)
      const text = (target.textContent || "").slice(0, 60)
      const now = Date.now()
      const x = (e as MouseEvent).clientX | 0
      const y = (e as MouseEvent).clientY | 0

      const timeOnPage = now - pageLandedAt
      // coord_x/coord_y are viewport-relative (legacy shape, kept as-is).
      // page_y adds the scroll offset so heatmaps can place the click on
      // the DOCUMENT; viewport_w lets them normalize across devices.
      const clickContext = {
        time_on_page_ms: timeOnPage,
        page_y: (y + (window.scrollY | 0)) | 0,
        viewport_w: window.innerWidth | 0,
      }

      // Always emit a generic click. Powers heatmaps + funnel analysis.
      enqueue({
        type: "click",
        url: location.href,
        ts: now,
        session_id: sessionId,
        selector,
        text,
        coord_x: x,
        coord_y: y,
        payload: clickContext,
      })

      // GA4-style semantic event if the element (or an ancestor) is
      // annotated with data-vaza-event="some_name". Additive — the
      // generic click still fires above so heatmaps stay intact.
      const annotated = findAnnotatedEvent(target)
      if (annotated) {
        enqueue({
          type: "custom",
          url: location.href,
          ts: now,
          session_id: sessionId,
          name: annotated,
          payload: { trigger: "click", selector },
        })
      }

      // Rage click detection (additive — generic click already fired).
      const entry = recent.find((r) => r.selector === selector)
      if (entry) {
        entry.times = entry.times.filter((t) => now - t < RAGE_CLICK_WINDOW_MS)
        entry.times.push(now)
        if (entry.times.length >= RAGE_CLICK_THRESHOLD) {
          enqueue({
            type: "rage_click",
            url: location.href,
            ts: now,
            session_id: sessionId,
            selector,
            text,
            count: entry.times.length,
            coord_x: x,
            coord_y: y,
            payload: clickContext,
          })
          entry.times = []
        }
      } else {
        recent.push({ selector, times: [now] })
        if (recent.length > 20) recent.shift()
      }

      // Dead click detection: a click that produced no reaction at all —
      // no DOM mutation, no navigation, no scroll. Two flavors, told apart
      // by payload.interactive:
      //   true  — a real control swallowed the click (broken CTA). The
      //           conversion killer; the old detector excluded these.
      //   false — a non-interactive element the visitor EXPECTED to be
      //           clickable (affordance problem).
      // Skipped for elements whose click legitimately changes nothing in
      // the DOM (form controls take focus; labels toggle them) and for
      // anchors with a real href — navigation is the expected effect and
      // slow servers would false-positive; SPA-intercepted anchors still
      // mutate the DOM when they work.
      const control = interactiveAncestor(target)
      const anchor = target.closest?.("a")
      const anchorHref = anchor?.getAttribute("href") ?? ""
      const navigational =
        anchorHref !== "" && anchorHref !== "#" && !anchorHref.toLowerCase().startsWith("javascript:")
      const formControl = /^(input|textarea|select|option|label)$/.test(
        (control ?? target).tagName.toLowerCase(),
      )
      const editable = target instanceof HTMLElement && target.isContentEditable
      if (!navigational && !formControl && !editable) {
        const beforeUrl = location.href
        const beforeMutations = domMutations
        const beforeScroll = window.scrollY | 0
        setTimeout(() => {
          if (location.href !== beforeUrl) return
          if (domMutations !== beforeMutations) return
          // The click scrolled the page (in-page nav) or the user moved on.
          if (Math.abs((window.scrollY | 0) - beforeScroll) > 8) return
          // Text selection is a deliberate no-effect click, not frustration.
          try {
            if (window.getSelection()?.toString()) return
          } catch {}
          enqueue({
            type: "dead_click",
            url: location.href,
            ts: now,
            session_id: sessionId,
            selector: control ? selectorFor(control) : selector,
            text,
            coord_x: x,
            coord_y: y,
            payload: { ...clickContext, interactive: !!control },
          })
        }, DEAD_CLICK_TIMEOUT_MS)
      }
    },
    { passive: true },
  )
}

/** Walk up the DOM looking for the closest `data-vaza-event` annotation.
 *  Lets customers opt in to GA4-style semantic event names without any
 *  extra SDK config: `<button data-vaza-event="signup_clicked">` → we
 *  emit a `custom` event named "signup_clicked" on top of the automatic
 *  click capture. Capped at 64 chars to avoid abuse. */
function findAnnotatedEvent(el: Element | null): string | null {
  let current: Element | null = el
  let depth = 0
  while (current && depth < 6) {
    if (current instanceof HTMLElement) {
      const name = current.dataset?.vazaEvent
      if (name) return String(name).slice(0, 64)
    }
    current = current.parentElement
    depth++
  }
  return null
}

/** Sanitize URL — drop query string + fragment, cap length. We don't want
 *  PII or auth tokens accidentally leaking through network-error reports. */
function sanitizeUrl(input: string): string {
  try {
    const u = new URL(input, location.origin)
    return `${u.origin}${u.pathname}`.slice(0, 240)
  } catch {
    return input.split("?")[0].split("#")[0].slice(0, 240)
  }
}

/** Attribution token for a form: data-vaza-src on the form itself or the
 *  nearest ancestor. The same token the site puts in conversion URLs
 *  (e.g. "art-rail:blog/some-post"), so impressions, submits and the
 *  resulting leads all key on one string. */
function srcFor(form: Element): string | undefined {
  const holder = form.closest("[data-vaza-src]")
  const v = holder?.getAttribute("data-vaza-src")
  return v ? v.slice(0, 80) : undefined
}

/** form_impression: fires once per form per page load when the form is at
 *  least half visible. IntersectionObserver so it costs nothing until a
 *  form actually scrolls into view; a MutationObserver picks up forms that
 *  SPAs mount after load. */
function captureFormImpressions(): void {
  if (typeof IntersectionObserver === "undefined") return
  const seen = new WeakSet<Element>()
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || seen.has(entry.target)) continue
        seen.add(entry.target)
        io.unobserve(entry.target)
        const form = entry.target
        enqueue({
          type: "form_impression",
          url: location.href,
          ts: Date.now(),
          session_id: sessionId,
          selector: selectorFor(form),
          payload: {
            form_id:
              (form.id || form.getAttribute("name") || "").slice(0, 60) || undefined,
            src: srcFor(form),
          },
        })
      }
    },
    { threshold: 0.5 },
  )
  const observeAll = () => {
    for (const form of Array.from(document.forms)) {
      if (!seen.has(form)) io.observe(form)
    }
  }
  observeAll()
  if (typeof MutationObserver !== "undefined" && document.documentElement) {
    new MutationObserver(observeAll).observe(document.documentElement, {
      childList: true,
      subtree: true,
    })
  }
}

function captureFormsAndInputs(): void {
  // Per-form engagement registry for form_abandon: which forms had field
  // focus this page-load and were never submitted. Keyed by the form's
  // selector; values only ever hold field NAMES, never values.
  const engagedForms = new Map<
    string,
    { fieldsTouched: Set<string>; lastField?: string; formId?: string; src?: string }
  >()

  function flushFormAbandons() {
    for (const [selector, info] of engagedForms) {
      enqueue({
        type: "form_abandon",
        url: location.href,
        ts: Date.now(),
        session_id: sessionId,
        selector,
        payload: {
          fields_touched: info.fieldsTouched.size,
          last_field: info.lastField,
          form_id: info.formId,
          src: info.src,
        },
      })
    }
    engagedForms.clear()
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushFormAbandons()
  })
  window.addEventListener("pagehide", flushFormAbandons)

  // Form submits — capture at the document level so SPAs that intercept
  // submit still fire here as long as the form-level event bubbles.
  document.addEventListener(
    "submit",
    (e) => {
      const form = e.target as HTMLFormElement | null
      if (!form || form.tagName !== "FORM") return
      // A submitted form was not abandoned.
      engagedForms.delete(selectorFor(form))
      enqueue({
        type: "form_submit",
        url: location.href,
        ts: Date.now(),
        session_id: sessionId,
        selector: selectorFor(form),
        payload: {
          field_count: form.elements?.length ?? 0,
          form_id: (form.id || form.getAttribute("name") || "").slice(0, 60),
          src: srcFor(form),
        },
      })
      const annotated = findAnnotatedEvent(form)
      if (annotated) {
        enqueue({
          type: "custom",
          url: location.href,
          ts: Date.now(),
          session_id: sessionId,
          name: annotated,
          payload: { trigger: "form_submit", selector: selectorFor(form) },
        })
      }
    },
    true,
  )

  // Field focus — captures intent (user engaged with a field) without
  // ever reading the value. Useful for funnel/form abandonment detection.
  document.addEventListener(
    "focus",
    (e) => {
      const el = e.target as HTMLElement | null
      // Focus can fire with document (not an Element) as target when the
      // tab itself regains focus — no tagName there.
      if (!el || typeof el.tagName !== "string") return
      const tag = el.tagName.toLowerCase()
      if (tag !== "input" && tag !== "textarea" && tag !== "select") return
      const fieldType =
        tag === "input"
          ? (el as HTMLInputElement).type.slice(0, 24) || "text"
          : tag
      // Skip password fields entirely — never even capture the focus event,
      // to keep the data clean of any inference about password length, etc.
      if (fieldType === "password") return
      const name =
        (el.getAttribute("name") || el.id || "").slice(0, 40) || undefined
      // Record engagement on the owning form for abandonment detection.
      const owningForm = (el as HTMLInputElement).form
      if (owningForm) {
        const key = selectorFor(owningForm)
        const info = engagedForms.get(key) ?? { fieldsTouched: new Set<string>() }
        info.fieldsTouched.add(name ?? fieldType)
        info.lastField = name ?? fieldType
        info.formId =
          (owningForm.id || owningForm.getAttribute("name") || "").slice(0, 60) || undefined
        info.src = srcFor(owningForm)
        engagedForms.set(key, info)
      }
      enqueue({
        type: "input",
        url: location.href,
        ts: Date.now(),
        session_id: sessionId,
        selector: selectorFor(el),
        payload: { field_type: fieldType, field_name: name },
      })
    },
    true,
  )
}

/** Emit quick_back when the visitor leaves within seconds of landing
 *  without any meaningful interaction (click, field focus, real scroll).
 *  One derived event per page load, only on actual page exit — tab
 *  switches (visibility) don't count as leaving. */
function captureQuickBack(): void {
  const QUICK_BACK_MS = 10_000
  const landedAt = Date.now()
  let interacted = false
  let emitted = false
  const markInteracted = () => {
    interacted = true
  }
  document.addEventListener("click", markInteracted, true)
  document.addEventListener("focusin", markInteracted, true)
  window.addEventListener(
    "scroll",
    () => {
      if ((window.scrollY | 0) > 200) interacted = true
    },
    { passive: true },
  )
  window.addEventListener("pagehide", () => {
    if (emitted || interacted) return
    const elapsed = Date.now() - landedAt
    if (elapsed >= QUICK_BACK_MS) return
    emitted = true
    enqueue({
      type: "quick_back",
      url: location.href,
      ts: Date.now(),
      session_id: sessionId,
      payload: { seconds_on_page: Math.round(elapsed / 1000) },
    })
  })
}

function captureNetworkErrors(): void {
  // Wrap fetch. We never capture request bodies or response bodies; only
  // status, URL path, method, duration.
  if (typeof window.fetch === "function") {
    const orig = window.fetch.bind(window)
    window.fetch = async function (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const start = Date.now()
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const method = (init?.method || "GET").toUpperCase()
      try {
        const res = await orig(input, init)
        if (res.status >= 400) {
          enqueue({
            type: "network_error",
            url: location.href,
            ts: Date.now(),
            session_id: sessionId,
            payload: {
              target_url: sanitizeUrl(url),
              method,
              status: res.status,
              duration_ms: Date.now() - start,
            },
          })
        }
        return res
      } catch (err) {
        enqueue({
          type: "network_error",
          url: location.href,
          ts: Date.now(),
          session_id: sessionId,
          payload: {
            target_url: sanitizeUrl(url),
            method,
            status: 0, // network-level failure
            duration_ms: Date.now() - start,
          },
        })
        throw err
      }
    }
  }
}

/** Inline Core Web Vitals capture via PerformanceObserver — no extra
 *  dependency. Mirrors the thresholds from web.dev: LCP ≤ 2.5s good,
 *  INP ≤ 200ms good, CLS ≤ 0.1 good. Reported on visibility hidden /
 *  pagehide so we emit the final value, not intermediate states. */
function captureWebVitals(): void {
  if (typeof PerformanceObserver === "undefined") return

  let lcpValue = 0
  let inpValue = 0
  let clsValue = 0

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & {
          renderTime?: number
          loadTime?: number
        }
        lcpValue = e.renderTime || e.loadTime || e.startTime
      }
    }).observe({ type: "largest-contentful-paint", buffered: true })
  } catch {}

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const e = entry as PerformanceEntry & {
          hadRecentInput?: boolean
          value?: number
        }
        if (!e.hadRecentInput) clsValue += e.value ?? 0
      }
    }).observe({ type: "layout-shift", buffered: true })
  } catch {}

  // INP — modern browsers expose "event" entries with durations.
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = entry.duration
        if (dur > inpValue) inpValue = dur
      }
    }).observe({
      type: "event",
      // @ts-expect-error: durationThreshold is widely supported but not in core lib types yet
      durationThreshold: 16,
      buffered: true,
    })
  } catch {}

  function ratingFor(
    metric: "LCP" | "INP" | "CLS",
    value: number,
  ): "good" | "needs-improvement" | "poor" {
    if (metric === "LCP") {
      return value <= 2500 ? "good" : value <= 4000 ? "needs-improvement" : "poor"
    }
    if (metric === "INP") {
      return value <= 200 ? "good" : value <= 500 ? "needs-improvement" : "poor"
    }
    // CLS is unitless 0..n, threshold 0.1 good / 0.25 poor.
    return value <= 0.1 ? "good" : value <= 0.25 ? "needs-improvement" : "poor"
  }

  function emit(metric: "LCP" | "INP" | "CLS", value: number) {
    if (value <= 0) return
    enqueue({
      type: "web_vital",
      url: location.href,
      ts: Date.now(),
      session_id: sessionId,
      payload: {
        metric,
        // round LCP/INP to integer ms; keep CLS at 3 decimals
        value: metric === "CLS" ? Math.round(value * 1000) / 1000 : Math.round(value),
        rating: ratingFor(metric, value),
      },
    })
  }

  let reported = false
  function reportAll() {
    if (reported) return
    reported = true
    emit("LCP", lcpValue)
    emit("INP", inpValue)
    emit("CLS", clsValue)
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") reportAll()
  })
  window.addEventListener("pagehide", reportAll)
}

function captureScrollAndVisibility(): void {
  // Track max scroll depth per pageview. Emit once on pagehide / visibility
  // hidden so we don't spam events while the user scrolls.
  let maxY = 0

  // Scroll-thrash: count direction reversals in a sliding window. Rapid
  // up-down-up hunting means the visitor can't find what they came for.
  // One emit per THRASH_COOLDOWN_MS so a long frustrated session doesn't
  // flood the queue.
  const THRASH_WINDOW_MS = 5_000
  const THRASH_REVERSALS = 3
  const THRASH_COOLDOWN_MS = 15_000
  let lastY = window.scrollY | 0
  let lastDir = 0
  let moves: { t: number; d: number; reversal: boolean }[] = []
  let lastThrashAt = 0

  window.addEventListener(
    "scroll",
    () => {
      const y = window.scrollY | 0
      if (y > maxY) maxY = y

      const delta = y - lastY
      lastY = y
      if (delta === 0) return
      const now = Date.now()
      const dir = delta > 0 ? 1 : -1
      moves.push({ t: now, d: Math.abs(delta), reversal: lastDir !== 0 && dir !== lastDir })
      lastDir = dir
      if (moves.length > 400) moves = moves.slice(-200)

      const cutoff = now - THRASH_WINDOW_MS
      moves = moves.filter((m) => m.t >= cutoff)
      const reversals = moves.filter((m) => m.reversal).length
      const distance = moves.reduce((sum, m) => sum + m.d, 0)
      if (
        reversals >= THRASH_REVERSALS &&
        // Require real travel within the window — a tiny wobble (bounce
        // scrolling, sticky-header jitter) reverses direction without meaning.
        distance > (window.innerHeight | 0) &&
        now - lastThrashAt > THRASH_COOLDOWN_MS
      ) {
        lastThrashAt = now
        moves = []
        enqueue({
          type: "scroll_thrash",
          url: location.href,
          ts: now,
          session_id: sessionId,
          payload: {
            reversals,
            distance_px: distance | 0,
            time_on_page_ms: now - pageLandedAt,
          },
        })
      }
    },
    { passive: true },
  )

  function flushScroll() {
    if (maxY > 0) {
      enqueue({
        type: "scroll",
        url: location.href,
        ts: Date.now(),
        session_id: sessionId,
        scroll_max_y: maxY,
        // Page + viewport height turn the raw pixel value into a depth
        // percentage server-side (scroll-depth distribution per page).
        payload: {
          doc_height: Math.max(
            document.documentElement?.scrollHeight | 0,
            document.body?.scrollHeight | 0,
          ),
          viewport_h: window.innerHeight | 0,
        },
      })
      maxY = 0
    }
  }

  // Visibility: signals tab switch / page leave. Useful for session boundary
  // detection — "user bounced 4 seconds after the JS error fired".
  document.addEventListener("visibilitychange", () => {
    const state = document.visibilityState === "hidden" ? "hidden" : "visible"
    enqueue({
      type: "visibility",
      url: location.href,
      ts: Date.now(),
      session_id: sessionId,
      state,
    })
    if (state === "hidden") flushScroll()
  })
  window.addEventListener("pagehide", () => {
    flushScroll()
  })
}

function isInteractive(el: Element): boolean {
  if (typeof el.tagName !== "string") return false
  const tag = el.tagName.toLowerCase()
  if (["a", "button", "input", "select", "textarea", "label"].includes(tag))
    return true
  const role = el.getAttribute("role")
  if (role && ["button", "link", "menuitem", "tab"].includes(role)) return true
  return false
}

/** Clicks land on the <span> inside the <button>. Walk up a few levels so
 *  the broken control itself is what gets reported, not its inner text. */
function interactiveAncestor(el: Element): Element | null {
  let current: Element | null = el
  let depth = 0
  while (current && depth < 6) {
    if (isInteractive(current)) return current
    current = current.parentElement
    depth++
  }
  return null
}

function capturePageviews(): void {
  emitPageview(document.referrer)
  // SPA route changes.
  const origPush = history.pushState
  const origReplace = history.replaceState
  history.pushState = function (...args) {
    const r = origPush.apply(this, args)
    emitPageview(location.href)
    return r
  }
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args)
    emitPageview(location.href)
    return r
  }
  window.addEventListener("popstate", () => emitPageview(location.href))
}

function emitPageview(referrer: string): void {
  // A route change starts a new page for timing purposes — time_on_page_ms
  // on clicks is relative to the view the visitor is actually looking at.
  pageLandedAt = Date.now()
  enqueue({
    type: "pageview",
    url: location.href,
    ts: Date.now(),
    session_id: sessionId,
    referrer,
    title: document.title.slice(0, 120),
    // Device context for segmentation ("is this CTA dead on mobile only?")
    // and for normalizing click coordinates into heatmaps across devices.
    payload: {
      viewport_w: window.innerWidth | 0,
      viewport_h: window.innerHeight | 0,
      screen_w: (screen?.width ?? 0) | 0,
      dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
    },
  })
}

function setupFlushTriggers(): void {
  // Flush on hidden tab (most reliable cross-browser signal).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush()
  })
  window.addEventListener("pagehide", () => flush())
}

function init(opts: VazaTrackOptions): void {
  if (options) return // already initialized
  // Automation (Playwright, Selenium, headless audits) self-identifies via
  // navigator.webdriver. Refusing to init keeps synthetic sessions out of
  // every downstream rate — 38% of the marketing site's sessions were bots,
  // which dilutes conversion and friction metrics past usefulness.
  if (typeof navigator !== "undefined" && navigator.webdriver) return
  options = opts
  sessionId = getOrCreateSession()
  setupFlushTriggers()
  if (!opts.manual) {
    captureErrors()
    observeDomMutations()
    captureClicks()
    capturePageviews()
    captureScrollAndVisibility()
    captureFormsAndInputs()
    captureFormImpressions()
    captureNetworkErrors()
    captureWebVitals()
    captureQuickBack()
    startReplayIfEnabled()
  }
}

function track(name: string, payload: Record<string, unknown> = {}): void {
  if (!options) return
  enqueue({
    type: "custom",
    url: location.href,
    ts: Date.now(),
    session_id: sessionId,
    name,
    payload,
  })
}

// Public API exposed on window for `<script>` integration.
// ── Sampled session replay (rrweb, AI-only consumer) ───────────────────
// Dormant unless the workspace enabled replay (checked once via a tiny
// config fetch). When on: lazy-load the record-only rrweb bundle from
// the same origin as the tracker, keep a rolling in-memory buffer with
// inputs ALWAYS masked, and upload only when a frustration event fires
// (error / rage click / dead click / form abandon) — storage scales
// with problems, not traffic. Max 2 uploads per session, 800KB cap.

const REPLAY_BUFFER_MS = 30_000
const REPLAY_MAX_UPLOADS = 2
const REPLAY_MAX_BYTES = 800_000

interface RrwebEvent {
	type: number
	timestamp: number
	data: unknown
}

let replayBuffer: RrwebEvent[] = []
let replayActive = false
let replayUploads = 0

function pruneReplayBuffer(): void {
	const cutoff = Date.now() - REPLAY_BUFFER_MS
	// Keep everything since the last full snapshot older than the cutoff so
	// the replay can always be reconstructed (type 2 = FullSnapshot).
	let snapIdx = 0
	for (let i = replayBuffer.length - 1; i >= 0; i--) {
		if (replayBuffer[i].type === 2 && replayBuffer[i].timestamp <= cutoff) {
			snapIdx = i
			break
		}
	}
	if (snapIdx > 0) replayBuffer = replayBuffer.slice(snapIdx)
}

function uploadReplay(): void {
	if (!options || !replayActive || replayUploads >= REPLAY_MAX_UPLOADS) return
	if (replayBuffer.length < 2) return
	let body: string
	try {
		body = JSON.stringify({
			key: options.key,
			session_id: sessionId,
			events: replayBuffer,
		})
	} catch {
		return
	}
	if (body.length > REPLAY_MAX_BYTES) return
	replayUploads++
	const url = (options.endpoint ?? "https://app.vaza.ai") + "/api/track/replay"
	void fetch(url, {
		method: "POST",
		keepalive: true,
		headers: { "Content-Type": "text/plain" },
		body,
	}).catch(() => {})
}

/** Called by the frustration capture paths when replay is live. */
function replayOnFrustration(): void {
	if (!replayActive) return
	// Small tail so the AI sees the aftermath, then ship the buffer.
	setTimeout(uploadReplay, 3_000)
}

function startReplayIfEnabled(): void {
	if (!options) return
	const base = options.endpoint ?? "https://app.vaza.ai"
	// One tiny config fetch decides whether to load anything at all.
	void fetch(`${base}/api/track/config?key=${encodeURIComponent(options.key)}`)
		.then((r) => (r.ok ? r.json() : null))
		.then((cfg: { replay?: boolean } | null) => {
			if (!cfg?.replay) return
			const s = document.createElement("script")
			s.src = `${base}/rrweb-record.js`
			s.async = true
			s.onload = () => {
				const rec = (window as unknown as { rrwebRecord?: (o: unknown) => unknown })
					.rrwebRecord
				if (typeof rec !== "function") return
				replayActive = true
				rec({
					emit: (ev: RrwebEvent) => {
						replayBuffer.push(ev)
						if (replayBuffer.length % 50 === 0) pruneReplayBuffer()
					},
					// Non-negotiable: what people type never leaves the browser.
					maskAllInputs: true,
					// Periodic full snapshots so a rolling buffer stays playable.
					checkoutEveryNms: REPLAY_BUFFER_MS,
					sampling: { mousemove: false, scroll: 250, media: 800 },
				})
			}
			document.head.appendChild(s)
		})
		.catch(() => {})
}

// ── Git-native A/B experiments ─────────────────────────────────────────
// The site's own code asks which variant this visitor should see; the
// assignment is a sticky per-device coin flip, and every ask records ONE
// exposure event per experiment per session so the analyzer can compare
// conversion between buckets. No external service, no DOM rewriting —
// both variants are real code in the customer's repo.

const AB_SEED_KEY = "vz_ab_seed"
const exposureSent = new Set<string>()

function abSeed(): number {
  try {
    const existing = localStorage.getItem(AB_SEED_KEY)
    if (existing !== null) {
      const n = Number(existing)
      if (Number.isInteger(n) && n >= 0) return n
    }
    const fresh = Math.floor(Math.random() * 1_000_000)
    localStorage.setItem(AB_SEED_KEY, String(fresh))
    return fresh
  } catch {
    // Storage unavailable (private mode) — stable within this page load.
    return 0
  }
}

/**
 * Deterministic variant for this visitor + experiment. Stable across
 * pages and sessions on the same device; independent across experiments.
 * `shareB` is the percentage of visitors who see "B" (default 50).
 */
function variant(experimentKey: string, shareB = 50): "A" | "B" {
  let h = 5381
  const s = `${abSeed()}:${experimentKey}`
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  const bucket = (h >>> 0) % 100
  const v: "A" | "B" = bucket < shareB ? "B" : "A"
  if (options && !exposureSent.has(experimentKey)) {
    exposureSent.add(experimentKey)
    enqueue({
      type: "custom",
      url: location.href,
      ts: Date.now(),
      session_id: sessionId,
      name: "vz_exposure",
      payload: { experiment: experimentKey.slice(0, 80), variant: v },
    })
  }
  return v
}

interface VazaTrackGlobal {
  init: typeof init
  track: typeof track
  flush: typeof flush
  variant: typeof variant
}

const vaza: VazaTrackGlobal = { init, track, flush, variant }

declare global {
  interface Window {
    vaza: VazaTrackGlobal
  }
}

if (typeof window !== "undefined") {
  window.vaza = vaza
}

export default vaza
export { init, track, flush, variant }
export type { VazaTrackOptions, VazaEvent }
