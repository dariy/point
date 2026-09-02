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

/**
 * The remark42 embed's config object — see plugins/comments/index.js, which
 * writes it before the embed script reads it on load.
 */
interface RemarkConfig {
  host: string;
  site_id: string;
  simple_view: boolean;
  no_footer: boolean;
  url?: string;
  page_title?: string;
  theme: string;
}

/**
 * The remark42 embed's own global, present only once /comments/web/embed.mjs
 * has loaded. Declared with just the surface plugins/comments uses.
 */
interface Remark42 {
  createInstance(config: RemarkConfig): void;
  changeTheme?(theme: string): void;
  destroy?(): void;
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
  /** Injected per-request by the server. */
  __MEDIA__?: MediaBootstrap;
  /** Injected per-request by the server. */
  __PLUGINS__?: PluginManifestEntry[];
  /** Set by the demo build only (demo/), gating writes in the UI. */
  __DEMO__?: boolean;
  /** Written by the comments plugin for the remark42 embed to read on load. */
  remark_config?: RemarkConfig;
  /** Defined by the remark42 embed script once it has loaded. */
  REMARK42?: Remark42;
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
