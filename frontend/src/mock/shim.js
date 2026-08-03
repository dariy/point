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
 * Everything that is not an API call (theme CSS, vendor geojson, media images)
 * passes through to the network untouched — those are real static files.
 */

import { routes } from "./routes.js";
import { getState, resetState } from "./store.js";

const nativeFetch = window.fetch.bind(window);
const NativeXHR = window.XMLHttpRequest;

/** Paths the mock owns. Anything else is a real static asset. */
const INTERCEPT = /^\/(api|comments)\//;

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
async function dispatch(method, url, rawBody) {
  const parsed = new URL(url, window.location.origin);
  const query = Object.fromEntries(parsed.searchParams.entries());
  const state = await getState();

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
    const result = await found.handler({ state, params: found.params, query, body });
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

  if (!INTERCEPT.test(pathname)) return nativeFetch(input, init);

  const method = (init.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
  await sleep(LATENCY_MS);
  return toResponse(await dispatch(method, url, init.body));
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

      const { status, body } = await dispatch(method, url, payload);
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
