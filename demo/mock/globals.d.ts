// Globals the demo build adds to window (demo/mock/shim.ts, demo/mock/banner.ts).

interface Window {
  /** Every plugin's manifest entry; the demo build writes it next to __PLUGINS__. */
  __ALL_PLUGINS__?: PluginManifestEntry[];
  /** Re-seeds the store and reloads (shim.ts); the banner's reset control calls it. */
  __DEMO_RESET__?: () => Promise<void>;
}
