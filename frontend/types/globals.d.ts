// Ambient declarations for the globals the app reads but does not declare in
// JS: build-time constants substituted by esbuild, payloads the server injects
// into index.html, and browser APIs missing from TypeScript's DOM lib.
//
// Kept as a .d.ts rather than JSDoc because there is no single JS file that
// owns any of them. jsconfig.json includes frontend/types/**/*.d.ts.

/**
 * Substituted by esbuild's `--define:__DEBUG__=…` (scripts/build-js.sh). Absent
 * when the raw sources are served, so every read is guarded by `typeof`.
 */
declare const __DEBUG__: boolean;

/** The `window.__MEDIA__` bootstrap payload — see utils/mediaUrl.js. */
interface MediaBootstrap {
  /** The server's thumbnail ladder, in ascending pixel size. */
  sizes?: number[];
  /** Thumbnail generation token, busting caches on a rebuild. */
  gen?: string;
}

/** One entry of the `window.__PLUGINS__` manifest — see core/pluginHost.js. */
interface PluginManifestEntry {
  id: string;
  type: string;
  slot?: string;
  slot_rule?: string;
  routes?: string[];
  enabled: boolean;
  default_enabled: boolean;
  locked?: boolean;
}

interface Window {
  /** Leaflet, once utils/leaflet.js has loaded it from the CDN. */
  L?: any;
  /**
   * Prism. The core is an ES module, but the vendored language files are global
   * scripts that read and extend a bare `Prism`, so the core's export is
   * published here before they load — see components/light/MarkdownEditor.js.
   * `any` because what the global holds grows with every language file.
   */
  Prism?: any;
  /** Injected per-request by the server. */
  __MEDIA__?: MediaBootstrap;
  /** Injected per-request by the server. */
  __PLUGINS__?: PluginManifestEntry[];
  /** Set by the demo build only (demo/), gating writes in the UI. */
  __DEMO__?: boolean;
  /**
   * Trusted Types. Chromium-only and absent from TypeScript's DOM lib, so it
   * is declared with just the surface utils/helpers.js uses.
   */
  trustedTypes?: {
    createPolicy(
      name: string,
      rules: {
        createHTML?: (input: string) => string;
        createScript?: (input: string) => string;
        createScriptURL?: (input: string) => string;
      },
    ): TrustedTypePolicy;
  };
}

/** The policy object returned by `trustedTypes.createPolicy`. */
interface TrustedTypePolicy {
  createHTML(input: string): string;
  createScript(input: string): string;
  createScriptURL(input: string): string;
}

/**
 * The vendored assets the backend serves from /assets/vendor. They are imported
 * at runtime and left out of the bundle (`--external:/assets/vendor/*` in
 * scripts/build-js.sh), so there is nothing under frontend/src for tsc to
 * resolve the specifier against.
 */
declare module "/assets/vendor/*";
