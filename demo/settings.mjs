/**
 * Demo presentation settings — the one place to edit what the demo *says*.
 *
 * These are applied twice, on purpose:
 *
 *   - `demo/scripts/record-fixtures.mjs` bakes them into the fixture bundle, so
 *     a recorded bundle is already demo-correct standing alone.
 *   - `demo/mock/store.js` re-applies them over whatever was recorded when the
 *     store seeds, so editing this file and rebuilding (`demo/scripts/run.sh`)
 *     is enough to change the running demo. Re-recording — which needs a live
 *     instance, picsum.photos and a Gemini key — is not.
 *
 * Applying twice is idempotent: the second pass writes the same values over
 * themselves unless this file changed since the fixtures were recorded, which
 * is exactly the case worth supporting.
 *
 * This module is shared by a Node script and the browser bundle, so it must
 * stay dependency-free and side-effect-free.
 */

/**
 * Settings rewritten to demo-appropriate values — only where the recorded
 * instance already carries the key.
 *
 * `tags_visibility` is a demo choice rather than a scrub: the source instance
 * keeps the tag visualisation admin-only, which makes /tags redirect logged-out
 * visitors home (app.js resolveTagsModule). Showing it is most of the point of
 * a demo.
 */
export const REPLACE_SETTINGS = {
  blog_title: "Point Demo",
  blog_subtitle: "A demo of the Point photo blog engine",
  author_name: "Demo",
  author_bio: "This is an UI demonstration of Point.",
  tags_visibility: "all",
};

/**
 * Settings written into every settings map whether the source instance carries
 * them or not — REPLACE_SETTINGS only rewrites keys that are already there, and
 * an unset setting is simply absent from the API's response.
 *
 * `footer_copyright` credits picsum.photos, where the demo's photographs come
 * from (see README, Content licensing). `{{author_name}}` and `{{engine}}` are
 * tokens and `[text](url)` is a link (utils/copyright.js); everything else is
 * literal text and is escaped — raw HTML here renders as visible markup.
 *
 * The managed-hosting link is the demo's only outbound pointer to point.photos,
 * and it is a plain hyperlink — nothing is fetched from that origin, so the
 * demo stays the self-contained bundle a visitor can read end to end, and
 * deploy-demo.sh's "no third-party origin in index.html" check still holds
 * (settings live in the fixtures bundle, not the shell). The /and/ path is a
 * channel marker counted server-side; see point-hosting
 * docs/10-funnel-measurement.md.
 */
export const ADD_SETTINGS = {
  // © is the character, not `&copy;`, and the credit is held to one line
  // with a non-breaking space rather than <nobr> — entity and tag alike are
  // escaped and shown as the markup they are, which is what the paragraph
  // above warns about.
  footer_copyright:
    "© UI showcase of {{engine}}"  +
    ", photos are from\u00a0[picsum.photos](https://picsum.photos)",
};

/** A recorded object carrying this key is a settings map. */
export const SETTINGS_MARKER = "blog_title";

/** True when `value` is a recorded settings map. */
export function isSettingsMap(value) {
  return Boolean(value) && typeof value === "object" && SETTINGS_MARKER in value;
}

/** Overlay the demo values onto one settings map, returning a new map. */
export function applyDemoSettings(settings) {
  const out = { ...settings };
  for (const [k, v] of Object.entries(REPLACE_SETTINGS)) {
    if (k in out) out[k] = v;
  }
  return { ...out, ...ADD_SETTINGS };
}

/**
 * Overlay the demo values onto every settings map nested anywhere in `value`.
 *
 * Applied by shape rather than at the three paths that hold one today
 * (`settings`, `publicSettings`, `pages.home.settings`), so a payload that
 * starts embedding settings later is covered without a change here.
 */
export function applyDemoSettingsDeep(value) {
  if (Array.isArray(value)) return value.map(applyDemoSettingsDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = applyDemoSettingsDeep(v);
    return isSettingsMap(out) ? applyDemoSettings(out) : out;
  }
  return value;
}
