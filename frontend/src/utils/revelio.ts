/**
 * Revelio — the owner's "show me what a guest sees" switch.
 *
 * On (the default) the site renders the way it always has for a signed-in
 * owner: hidden tags, hidden posts, private media and the scheduled queue are
 * all visible. Off, every public read is answered as if the request were
 * anonymous — the server drops the principal for the duration of the request
 * when it sees the `X-Point-Revelio: off` header (api/internal/api/middleware.go).
 *
 * The state lives in localStorage rather than the store because the API client
 * has to read it synchronously on the very first fetch, before bootstrap has
 * run. It is a *narrowing* of what the viewer may see and grants nothing, so
 * there is no reason to keep it server-side.
 */

const KEY = "revelio";
export const REVELIO_HEADER = "X-Point-Revelio";

/** True when hidden items should be revealed (the default). */
export function isRevelioOn() {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    // Private-mode Safari and friends: fall back to the default.
    return true;
  }
}

/** Persist the switch. Callers reload afterwards — see PublicFooter. */
export function setRevelio(on) {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    /* nothing we can do; the switch just won't stick */
  }
}

/**
 * The header to merge into an API request, or nothing when revelio is on.
 * Sent unconditionally (guests included) — for a guest it changes nothing,
 * and testing for a session here would mean reading state the client may not
 * have loaded yet.
 */
export function revelioHeaders() {
  return isRevelioOn() ? {} : { [REVELIO_HEADER]: "off" };
}
