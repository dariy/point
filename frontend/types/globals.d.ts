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

/** plugins.Type (api/internal/plugins/registry.go). */
type PluginType = "route" | "slot" | "enhancer" | "service";

/**
 * One entry of the `window.__PLUGINS__` manifest — plugins.ManifestEntry
 * (api/internal/plugins/registry.go), read by core/pluginHost.js. The manifest
 * lists enabled plugins only, so an entry carries no enabled state.
 */
interface PluginManifestEntry {
  id: string;
  type: PluginType;
  slot?: string;
  routes?: string[];
  /** Hashed chunk URL; absent while the plugin has no built chunk. */
  entry?: string;
  /** The plugin's stylesheet URL, when it ships one. */
  css?: string;
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

/**
 * The vendored assets the backend serves from /assets/vendor. They are imported
 * at runtime and left out of the bundle (`--external:/assets/vendor/*` in
 * scripts/build-js.sh), so there is nothing under frontend/src for tsc to
 * resolve the specifier against.
 */
declare module "/assets/vendor/*";
