/**
 * PluginHost — the frontend half of Point's plugin system.
 *
 * The server is the source of truth: it injects an ENABLED-ONLY manifest into
 * the served HTML as `window.__PLUGINS__` (see api/cmd/api/main.go). Each entry
 * is `{ id, type, slot?, routes?, entry? }`, where `entry` is the hashed chunk
 * URL (`/assets/js/p/<hash>.js`) of the plugin's built bundle — or empty while a
 * plugin has no built chunk yet (the Phase 2 foundation state: the wiring is in
 * place, but extraction of features into chunks happens in Phase 4).
 *
 * This host exposes the extension points the shell uses instead of importing
 * features directly:
 *   - slots: `fill(slot, el, ctx)` lazily imports every enabled plugin claiming
 *     a named region and mounts it.
 *   - single-claim route slots: `claimRoute(slot, choose)` resolves the one
 *     plugin module that owns a route (e.g. `tags-route`).
 *   - dynamic routes: `routes()` lists manifest-provided routes to merge into
 *     the static table in app.js.
 *
 * A plugin chunk default-exports (or names) a `mount(el, ctx)` function for slot
 * plugins, or a `{ default: PageClass }` page module for route plugins.
 *
 * Resilience: when the manifest is absent or empty (e.g. served HTML without
 * injection, or unit tests), the host is inert — slots stay unfilled and route
 * claims return null — so callers can fall back to their existing behavior. A
 * plugin only "claims" a slot once it has a built chunk (`entry` is non-empty),
 * so adding a slot hook is a no-op until the corresponding chunk ships.
 *
 * Debug build only: this host logs the manifest, every chunk import, slot
 * mount/unmount and route claim through `debugLog` (a no-op in the release
 * build — see utils/debug.js). Toggle it with the FRONTEND_DEBUG env on the
 * backend, which decides whether the debug or release bundle is served.
 */

import { debugLog, DEBUG } from "../utils/debug.js";

const log = debugLog("PluginHost");

class PluginHost {
  constructor() {
    /** @type {Array<{id:string,type:string,slot?:string,routes?:string[],entry?:string}>} */
    this._manifest = [];
    /** @type {Map<string, Array>} slot name -> entries */
    this._bySlot = new Map();
    /** @type {Map<string, object>} id -> entry */
    this._byId = new Map();
    /** @type {Map<string, Promise>} entry url -> import promise (loaded once) */
    this._loaded = new Map();
  }

  /**
   * Initialise from the injected manifest (defaults to `window.__PLUGINS__`).
   * Idempotent — safe to call again to re-seed (used by tests).
   */
  init(manifest) {
    if (manifest === undefined) {
      manifest = typeof window !== "undefined" ? window.__PLUGINS__ : undefined;
    }
    this._manifest = Array.isArray(manifest) ? manifest : [];
    this._bySlot.clear();
    this._byId.clear();
    for (const e of this._manifest) {
      if (!e || !e.id) continue;
      this._byId.set(e.id, e);
      if (e.slot) {
        const arr = this._bySlot.get(e.slot) || [];
        arr.push(e);
        this._bySlot.set(e.slot, arr);
      }
    }
    if (DEBUG) {
      log(`init — ${this._manifest.length} enabled plugin(s)`);
      log.table(
        this._manifest.map((e) => ({
          id: e.id,
          type: e.type,
          slot: e.slot || "",
          routes: Array.isArray(e.routes) ? e.routes.join(",") : "",
          chunk: e.entry || "(none — rendered by shell)",
        })),
      );
    }
    return this;
  }

  /** Number of plugins in the manifest. 0 means "no manifest" (be resilient). */
  get size() {
    return this._manifest.length;
  }

  /** Whether plugin `id` is present in the enabled-only manifest. */
  isEnabled(id) {
    return this._byId.has(id);
  }

  /**
   * The enabled entries claiming `slot` that actually have a built chunk. An
   * entry without `entry` is enabled but not yet extracted, so it does not claim
   * the slot — the shell keeps rendering it directly.
   */
  slotEntries(slot) {
    return (this._bySlot.get(slot) || []).filter((e) => e.entry);
  }

  /** Whether any built plugin chunk claims `slot`. */
  hasSlot(slot) {
    return this.slotEntries(slot).length > 0;
  }

  /** Lazily import a plugin chunk and its CSS, memoising the module promise per URL. */
  _import(e) {
    if (!this._loaded.has(e.entry)) {
      if (e.css && typeof document !== "undefined" && !document.querySelector(`link[href="${e.css}"]`)) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = e.css;
        document.head.appendChild(link);
        if (DEBUG) log(`load css '${e.id}' →`, e.css);
      }
      if (DEBUG) log(`import chunk '${e.id}' →`, e.entry);
      let p = import(/* @vite-ignore */ e.entry);
      if (DEBUG) {
        p = p.catch((err) => {
          log.error(`chunk '${e.id}' failed to load:`, err);
          throw err;
        });
      }
      this._loaded.set(e.entry, p);
    }
    return this._loaded.get(e.entry);
  }

  /**
   * Fill a named slot: import each claiming plugin chunk and invoke its mount
   * function (`mount` export or default) with `(el, ctx)`. Returns the array of
   * mount results (e.g. component instances). A failing plugin is logged and
   * skipped — one broken plugin never blocks the rest of the page.
   */
  async fill(slot, el, ctx = {}) {
    const entries = this.slotEntries(slot);
    if (DEBUG && entries.length) log(`fill slot '${slot}' — ${entries.length} plugin(s):`, entries.map((e) => e.id).join(", "));
    const out = [];
    for (const e of entries) {
      try {
        const mod = await this._import(e);
        const mount = mod.mount || mod.default;
        if (typeof mount === "function") {
          const result = await mount(el, { ...ctx, plugin: e });
          if (DEBUG) {
            log(`mounted '${e.id}' into slot '${slot}'`);
            this._traceUnmount(result, e.id, slot);
          }
          out.push(result);
        } else if (DEBUG) {
          log.warn(`slot '${slot}' plugin '${e.id}' chunk exports no mount() — skipped`);
        }
      } catch (err) {
        console.error(`[PluginHost] slot '${slot}' plugin '${e.id}' failed:`, err);
      }
    }
    return out;
  }

  /**
   * Debug build only: wrap a mounted component's `unmount`/`destroy` so teardown
   * shows up in the console. Pages call these at the call site (e.g.
   * `comp.unmount()`), so the host can't see them otherwise. No-op when DEBUG is
   * false — the whole method is dead code that minification drops.
   */
  _traceUnmount(result, id, slot) {
    if (!result || typeof result !== "object") return;
    for (const method of ["unmount", "destroy"]) {
      const fn = result[method];
      if (typeof fn !== "function") continue;
      const orig = fn.bind(result);
      result[method] = (...args) => {
        log(`${method} '${id}' from slot '${slot}'`);
        return orig(...args);
      };
    }
  }

  /**
   * Resolve the single plugin module that owns a single-claim route slot (e.g.
   * `tags-route`). `choose(entries)` picks the winning entry among the enabled
   * claimants; defaults to the first. Returns the loaded module (`{ default:
   * PageClass }`) or null when no claimant has a built chunk — letting the caller
   * fall back to a core module.
   */
  async claimRoute(slot, choose) {
    const entries = this.slotEntries(slot);
    if (!entries.length) return null;
    const e = choose ? choose(entries) : entries[0];
    if (!e || !e.entry) return null;
    if (DEBUG) log(`claimRoute '${slot}' → '${e.id}'`);
    return this._import(e);
  }

  /** Import a route plugin's chunk module (`{ default: PageClass }`). */
  loadEntry(entry) {
    return this._import(entry);
  }

  /**
   * Manifest-provided routes to merge into the static route table. Excludes the
   * single-claim `tags-route` (handled explicitly) and only includes route
   * plugins that have a built chunk.
   */
  routes() {
    const out = this._manifest.filter(
      (e) => e.type === "route" && e.entry && e.slot !== "tags-route" && Array.isArray(e.routes) && e.routes.length,
    );
    if (DEBUG && out.length) log("dynamic routes:", out.flatMap((e) => e.routes).join(", "));
    return out;
  }
}

/** Shared singleton — initialised once at bootstrap from window.__PLUGINS__. */
export const pluginHost = new PluginHost();
