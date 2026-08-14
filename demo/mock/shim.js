/**
 * Network interception for the static demo.
 *
 * Patches `window.fetch` and `XMLHttpRequest` before the app boots, so every
 * API call is answered from the in-memory store and the demo needs no backend
 * at all.
 *
 * Why here rather than swapping frontend/src/api/client.js: that module is not
 * the only caller. router.js fetches /api/setup/status on every /light
 * navigation, api/system.js uploads over XHR, BackupsSection fetches the
 * version endpoint directly, and the comments plugin calls `api.*` without
 * going through frontend/src/api/. Patching the platform catches all of them —
 * including any added later — and leaves the real client.js on the code path,
 * so the demo exercises genuine error handling and caching rather than a
 * parallel implementation of it.
 *
 * Everything that is not an API call (vendor geojson, media images) passes
 * through to the network untouched — those are real static files. The one
 * exception is theme.css, which is a static file only because a server wrote it
 * there; see THEME_CSS below.
 */

import { routes } from "./routes.js";
import { getState, resetState, storeContent } from "./store.js";

const state = await getState();

if (window.__ALL_PLUGINS__) {
  const enabledIds = new Set(state.plugins.filter((p) => p.enabled).map((p) => p.id));
  window.__PLUGINS__ = window.__ALL_PLUGINS__.filter((p) => enabledIds.has(p.id));
}

const nativeFetch = window.fetch.bind(window);
const NativeXHR = window.XMLHttpRequest;

/** Paths the mock owns. Anything else is a real static asset. */
const INTERCEPT = /^\/(api|comments)\//;

/**
 * The one non-API path the mock owns.
 *
 * On a real deployment this is a file that the *server* rewrites: activating a
 * theme or saving custom CSS runs ThemeService.SyncActiveTheme, which copies the
 * chosen theme over frontend/css/common/theme.css and appends the site's custom
 * CSS. Served statically it would be frozen at whatever was active when the demo
 * was recorded, so "Set Active" would move a highlight and change nothing else.
 * Composing it here from the store — same two ingredients, same order — makes
 * both the theme switch and the CSS editor take effect immediately.
 */
const THEME_CSS = "/assets/css/common/theme.css";

async function themeCss() {
  const state = await getState();
  const name = String(state.activeTheme?.name || "default").toLowerCase();

  // Themes ship as /assets/themes/<name>.css (demo/scripts/build.sh). A build
  // predating that, or a theme with no file, falls back to the baked-in
  // theme.css so the page stays styled instead of losing every variable.
  let res = await nativeFetch(`/assets/themes/${encodeURIComponent(name)}.css`);
  if (!res.ok) res = await nativeFetch(THEME_CSS);
  let css = res.ok ? await res.text() : "";

  const custom = state.customCss?.css || "";
  if (custom) css += `\n\n/* System Custom CSS */\n${custom}`;

  return new Response(css, {
    status: 200,
    headers: { "Content-Type": "text/css" },
  });
}

// A touch of latency so spinners, optimistic updates and disabled-while-saving
// states behave the way they do against a real server. Instant resolution makes
// the UI look like it is skipping work.
const LATENCY_MS = 90;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Route matching ────────────────────────────────────────────────────────

/** Compile `/api/posts/:id/tags` into a regex + ordered param names. */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split("/")
    .map((seg) => {
      if (!seg.startsWith(":")) return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(seg.slice(1));
      return "([^/]+)";
    })
    .join("/");
  return { re: new RegExp(`^${source}$`), names };
}

const compiled = routes.map(([method, pattern, handler]) => ({
  method,
  handler,
  ...compile(pattern),
  pattern,
}));

function match(method, pathname) {
  for (const route of compiled) {
    if (route.method !== method) continue;
    const m = route.re.exec(pathname);
    if (!m) continue;
    const params = {};
    route.names.forEach((name, i) => (params[name] = decodeURIComponent(m[i + 1])));
    return { handler: route.handler, params };
  }
  return null;
}

// ── Revelio ───────────────────────────────────────────────────────────────

/**
 * Read one header out of whatever form the caller passed.
 *
 * `fetch` accepts a Headers, a plain object or an array of pairs, and the app
 * uses more than one of them — client.js builds an object, other callers hand
 * over a Request. Normalising here keeps the check below to one line.
 */
function headerValue(headers, name) {
  if (!headers) return null;
  const wanted = name.toLowerCase();
  if (typeof headers.get === "function") return headers.get(name);
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => String(k).toLowerCase() === wanted);
    return hit ? hit[1] : null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === wanted) return v;
  }
  return null;
}

/**
 * The reads the revelio switch is allowed to narrow: the ones the real server
 * puts behind OptionalAuthMiddleware (api/cmd/api/routes.go, main.go).
 *
 * The client sends `X-Point-Revelio: off` on *every* request, so this list —
 * not the header — is what keeps the switch from reaching the admin API. That
 * matters in both directions: `/api/auth/me` is behind AuthMiddleware and must
 * keep answering with the user, or the app concludes the visitor is logged out
 * and the footer control that turns revelio back on goes with the admin UI.
 *
 * `/api/posts/analytics` is the one path under these prefixes that is
 * admin-only, so it is named as an exception rather than the prefixes being
 * split around it.
 */
const NARROWABLE = [/^\/api\/pages\//, /^\/api\/posts(\/|$)/, /^\/api\/tags(\/|$)/, /^\/api\/timeline(\/|$)/];
const NOT_NARROWABLE = ["/api/posts/analytics"];

/**
 * The owner's "show me what a guest sees" switch (frontend/src/utils/revelio.js).
 *
 * `X-Point-Revelio: off` asks a read to be answered as if nobody were signed
 * in. The backend implements it in OptionalAuthMiddleware, which resolves the
 * principal and then withholds it, so every downstream visibility test takes
 * the public branch.
 *
 * Writes are never narrowed — a request that changes something is behind
 * AuthMiddleware, which the header does not reach.
 */
function isGuestView(method, pathname, headers) {
  if (method !== "GET") return false;
  if (String(headerValue(headers, "X-Point-Revelio") || "").toLowerCase() !== "off") {
    return false;
  }
  if (NOT_NARROWABLE.includes(pathname)) return false;
  return NARROWABLE.some((re) => re.test(pathname));
}

/**
 * The store as this request may see it.
 *
 * Prototype delegation rather than a copy: every collection is the live one, so
 * a handler reads exactly what it would have read, and only the flag the
 * visibility tests branch on is shadowed. Nothing writes through it — writes
 * are never narrowed (see isGuestView).
 */
function guestView(state) {
  return Object.create(state, {
    authenticated: { value: false, enumerable: true },
    // Handlers that answer differently for a real guest and for the owner
    // *previewing* one — the demo has none today, but the backend keeps the
    // same distinction (IsGuestView, api/internal/api/middleware.go) and a
    // handler reaching for it should find the truth rather than nothing.
    guestView: { value: true, enumerable: true },
  });
}

// ── Dispatch ──────────────────────────────────────────────────────────────

/**
 * Resolve a request against the route table.
 *
 * Unmatched endpoints fail SOFT — an empty 200, never a rejection and never a
 * 401. client.js turns a 401 into an `api:unauthorized` event which app.js
 * escalates into a hard navigation to /light/login, so one unhandled endpoint
 * would eject a visitor from the demo mid-click. An empty body just renders an
 * empty section.
 */
async function dispatch(method, url, rawBody, headers) {
  const parsed = new URL(url, window.location.origin);
  const query = Object.fromEntries(parsed.searchParams.entries());
  const state = await getState();
  const view = isGuestView(method, parsed.pathname, headers) ? guestView(state) : state;

  let body = rawBody;
  if (typeof rawBody === "string") {
    try {
      body = JSON.parse(rawBody);
    } catch {
      /* not JSON — hand the raw value to the handler */
    }
  }

  const found = match(method, parsed.pathname);
  if (!found) {
    if (__DEBUG__) {
      console.debug(`[demo] unhandled ${method} ${parsed.pathname} — empty 200`);
    }
    return { status: 200, body: {} };
  }

  try {
    const result = await found.handler({ state: view, params: found.params, query, body });
    // Anything but a read may have changed the posts or the tags, so the
    // snapshot is refreshed here rather than inside each handler that writes —
    // the same reasoning as patching `fetch` instead of client.js. A handler
    // added later is covered without knowing this exists.
    if (method !== "GET") storeContent(state);
    // Handlers may return a bare value or an explicit {status, body}.
    if (result && typeof result === "object" && "status" in result && "body" in result) {
      return result;
    }
    return { status: 200, body: result ?? {} };
  } catch (err) {
    console.error(`[demo] handler failed for ${method} ${parsed.pathname}`, err);
    return { status: 200, body: {} };
  }
}

function toResponse({ status, body }) {
  if (status === 204 || body === null) {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── fetch ─────────────────────────────────────────────────────────────────

window.fetch = async function mockFetch(input, init = {}) {
  const url = typeof input === "string" ? input : input.url;
  const pathname = new URL(url, window.location.origin).pathname;

  // themeLoader.js cache-busts with a ?t= query, so match on the path alone.
  if (pathname === THEME_CSS) return themeCss();
  if (!INTERCEPT.test(pathname)) return nativeFetch(input, init);

  const method = (init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
  const headers = init.headers || (typeof input === "object" ? input.headers : null);
  await sleep(LATENCY_MS);
  return toResponse(await dispatch(method, url, init.body, headers));
};

// ── XMLHttpRequest ────────────────────────────────────────────────────────
//
// Only api/system.js uses XHR (backup upload, for its progress events). The
// shim implements enough of the interface for that path — readyState/status/
// responseText plus load and progress events — and delegates anything it does
// not own to the real implementation.

window.XMLHttpRequest = function MockXHR() {
  const native = new NativeXHR();
  let intercepted = false;
  let method = "GET";
  let url = "";
  const headers = {};

  const self = {
    upload: {},
    readyState: 0,
    status: 0,
    responseText: "",
    onload: null,
    onerror: null,
    onreadystatechange: null,

    open(m, u, ...rest) {
      method = String(m).toUpperCase();
      url = u;
      intercepted = INTERCEPT.test(new URL(u, window.location.origin).pathname);
      if (!intercepted) return native.open(m, u, ...rest);
      self.readyState = 1;
    },

    setRequestHeader(...args) {
      if (!intercepted) return native.setRequestHeader(...args);
      // Kept so an intercepted upload is answered under the same rules as the
      // fetch path — the revelio header included.
      headers[String(args[0])] = args[1];
    },

    async send(payload) {
      if (!intercepted) return native.send(payload);

      // Drive the progress events the upload UI listens for, so the bar moves.
      if (typeof self.upload.onprogress === "function") {
        for (const pct of [0.3, 0.7, 1]) {
          await sleep(LATENCY_MS / 2);
          self.upload.onprogress({ lengthComputable: true, loaded: pct * 100, total: 100 });
        }
      }
      await sleep(LATENCY_MS);

      const { status, body } = await dispatch(method, url, payload, headers);
      self.status = status === 204 ? 200 : status;
      self.responseText = JSON.stringify(body ?? {});
      self.response = self.responseText;
      self.readyState = 4;
      self.onreadystatechange?.();
      self.onload?.();
    },

    abort() {
      if (!intercepted) return native.abort();
    },

    getAllResponseHeaders() {
      return intercepted ? "content-type: application/json" : native.getAllResponseHeaders();
    },

    addEventListener(type, fn) {
      if (!intercepted) return native.addEventListener(type, fn);
      if (type === "load") self.onload = fn;
      if (type === "error") self.onerror = fn;
    },
  };

  return self;
};

// ── Demo controls ─────────────────────────────────────────────────────────

/**
 * Re-seed the store. Exposed on `window` so the demo banner's reset control can
 * reach it without the UI having to import mock code — that import would not
 * resolve in a normal build.
 */
window.__DEMO_RESET__ = async () => {
  await resetState();
  window.location.reload();
};

window.__DEMO__ = true;
