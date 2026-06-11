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
  /** Enable rrweb session replay (lazy loaded). */
  replay?: boolean
  /** Replay sample rate, 0..1. Defaults to 0.1 (10%). */
  replaySampleRate?: number
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
  type: "rage_click" | "dead_click"
  selector: string
  text?: string
  count?: number
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

type VazaEvent =
  | ErrorEventPayload
  | ClickEventPayload
  | PageviewEventPayload
  | CustomEventPayload

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
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" })
      navigator.sendBeacon(url, blob)
      return
    }
  } catch {
    // sendBeacon can throw on some browsers; fall through.
  }
  void fetch(url, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
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
      const now = Date.now()

      // Rage click detection.
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
            text: (target.textContent || "").slice(0, 60),
            count: entry.times.length,
          })
          entry.times = [] // Reset to avoid spamming.
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
            text: (target.textContent || "").slice(0, 60),
          })
        }
      }, DEAD_CLICK_TIMEOUT_MS)
    },
    { passive: true },
  )
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

async function lazyLoadReplay(): Promise<void> {
  if (!options?.replay) return
  if (Math.random() > (options.replaySampleRate ?? 0.1)) return
  try {
    // Dynamic import keeps rrweb out of the base bundle. We load it via a
    // runtime-only URL string so tsc doesn't try to resolve types.
    const rrwebUrl = "https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.4/+esm"
    const mod = (await import(/* @vite-ignore */ rrwebUrl)) as {
      record: (opts: unknown) => void
    }
    const { record } = mod
    const chunks: unknown[] = []
    let lastSend = Date.now()
    record({
      emit(rec: unknown) {
        chunks.push(rec)
        // Batch every 5 seconds.
        if (Date.now() - lastSend > 5000) {
          void sendReplayChunk(chunks.splice(0))
          lastSend = Date.now()
        }
      },
    })
    window.addEventListener("pagehide", () => {
      if (chunks.length > 0) void sendReplayChunk(chunks.splice(0))
    })
  } catch {
    // Replay failed to load. Telemetry still works.
  }
}

async function sendReplayChunk(records: unknown[]): Promise<void> {
  if (!options || records.length === 0) return
  const url = (options.endpoint ?? "https://app.vaza.ai") + "/api/track-replay"
  const body = JSON.stringify({
    key: options.key,
    session_id: sessionId,
    records,
  })
  if (navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))
    return
  }
  await fetch(url, {
    method: "POST",
    keepalive: true,
    headers: { "Content-Type": "application/json" },
    body,
  }).catch(() => {})
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
  }
  void lazyLoadReplay()
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
