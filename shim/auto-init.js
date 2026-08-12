/* vaza-track auto-init: initialise straight from the script tag's
   data-vaza-key (optionally data-endpoint) so a bare <script> tag is
   self-sufficient — no separate window.vaza.init() call required. Safe
   for async/defer (querySelector fallback) and idempotent (SDK init is
   a no-op once initialised, plus the __vazaAutoInit guard). */
(function () {
	try {
		if (typeof window === "undefined" || !window.vaza || window.__vazaAutoInit) return
		var s =
			(document.currentScript &&
				document.currentScript.getAttribute("data-vaza-key") &&
				document.currentScript) ||
			document.querySelector("script[data-vaza-key]")
		if (!s) return
		var key = s.getAttribute("data-vaza-key")
		if (!key) return
		window.__vazaAutoInit = true
		window.vaza.init({ key: key, endpoint: s.getAttribute("data-endpoint") || undefined })
	} catch (e) {
		/* never break the host page */
	}
})();
