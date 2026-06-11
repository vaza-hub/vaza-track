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
  payload: { field_count: number; form_id: string }
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

type VazaEvent =
  | ErrorEventPayload
  | ClickEventPayload
  | PageviewEventPayload
  | CustomEventPayload
  | ScrollEventPayload
  | VisibilityEventPayload
  | FormSubmitEventPayload
  | InputEventPayload
  | NetworkErrorEventPayload
  | WebVitalEventPayload

const SESSION_KEY = "vz_sid"
const SESSION_TIMEOUT_MS = 30 * 60 * 1000 // 30 min idle = new session
const RAGE_CLICK_WINDOW_MS = 1000
const RAGE_CLICK_THRESHOLD = 4
const DEAD_CLICK_TIMEOUT_MS = 500

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

function enqueue(event: VazaEvent): void {
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
      const target = e.target as Element | null
      if (!target) return
      const selector = selectorFor(target)
      const text = (target.textContent || "").slice(0, 60)
      const now = Date.now()
      const x = (e as MouseEvent).clientX | 0
      const y = (e as MouseEvent).clientY | 0

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
      })

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
          })
          entry.times = []
        }
      } else {
        recent.push({ selector, times: [now] })
        if (recent.length > 20) recent.shift()
      }

      // Dead click detection: schedule a check.
      const beforeUrl = location.href
      const beforeMutationCount = document.body.childNodes.length
      setTimeout(() => {
        if (
          location.href === beforeUrl &&
          document.body.childNodes.length === beforeMutationCount &&
          !isInteractive(target)
        ) {
          enqueue({
            type: "dead_click",
            url: location.href,
            ts: now,
            session_id: sessionId,
            selector,
            text,
            coord_x: x,
            coord_y: y,
          })
        }
      }, DEAD_CLICK_TIMEOUT_MS)
    },
    { passive: true },
  )
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

function captureFormsAndInputs(): void {
  // Form submits — capture at the document level so SPAs that intercept
  // submit still fire here as long as the form-level event bubbles.
  document.addEventListener(
    "submit",
    (e) => {
      const form = e.target as HTMLFormElement | null
      if (!form || form.tagName !== "FORM") return
      enqueue({
        type: "form_submit",
        url: location.href,
        ts: Date.now(),
        session_id: sessionId,
        selector: selectorFor(form),
        payload: {
          field_count: form.elements?.length ?? 0,
          form_id: (form.id || form.getAttribute("name") || "").slice(0, 60),
        },
      })
    },
    true,
  )

  // Field focus — captures intent (user engaged with a field) without
  // ever reading the value. Useful for funnel/form abandonment detection.
  document.addEventListener(
    "focus",
    (e) => {
      const el = e.target as HTMLElement | null
      if (!el) return
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
  window.addEventListener(
    "scroll",
    () => {
      const y = window.scrollY | 0
      if (y > maxY) maxY = y
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
  const tag = el.tagName.toLowerCase()
  if (["a", "button", "input", "select", "textarea", "label"].includes(tag))
    return true
  const role = el.getAttribute("role")
  if (role && ["button", "link", "menuitem", "tab"].includes(role)) return true
  return false
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
  enqueue({
    type: "pageview",
    url: location.href,
    ts: Date.now(),
    session_id: sessionId,
    referrer,
    title: document.title.slice(0, 120),
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
  options = opts
  sessionId = getOrCreateSession()
  setupFlushTriggers()
  if (!opts.manual) {
    captureErrors()
    captureClicks()
    capturePageviews()
    captureScrollAndVisibility()
    captureFormsAndInputs()
    captureNetworkErrors()
    captureWebVitals()
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
interface VazaTrackGlobal {
  init: typeof init
  track: typeof track
  flush: typeof flush
}

const vaza: VazaTrackGlobal = { init, track, flush }

declare global {
  interface Window {
    vaza: VazaTrackGlobal
  }
}

if (typeof window !== "undefined") {
  window.vaza = vaza
}

export default vaza
export { init, track, flush }
export type { VazaTrackOptions, VazaEvent }
