/**
 * immersiveNav — shared enter/exit flow for the forced immersive viewer.
 *
 * A post that is not intrinsically immersive can be pushed into the
 * full-screen viewer (header expand button, clicking an image, a #N link).
 * That state is encoded in the URL hash: #1 = first slide, #2 = second, …
 * Entering pushes a history entry, so browser Back lands on the hash-less
 * URL and the router's onRouteUpdate → hash decode restores the article
 * view — no dedicated popstate listener needed.
 *
 * The page object carries a transient `_immersivePushed` flag: true only
 * while the entry we pushed is on top of the stack. Pages must clear it in
 * onRouteUpdate (any URL-driven change — Back/Forward, cross-post swipe —
 * invalidates it).
 */

/** Enter forced immersive mode at slide `idx`, pushing a history entry. */
export function enterImmersive(page, idx = 0) {
  window.history.pushState(
    null,
    "",
    window.location.pathname + window.location.search + `#${idx + 1}`,
  );
  page._immersivePushed = true;
  page.setState({ forceImmersive: true, startIndex: idx });
}

/**
 * Leave forced immersive mode, unwinding to the article view.
 * Uses history.back() when we own the top entry (keeps the stack clean and
 * lets the router do the re-render); otherwise — e.g. the user landed on a
 * #N link directly, so there is no article entry beneath — strips the hash
 * in place.
 */
export function exitImmersive(page) {
  if (page._immersivePushed) {
    page._immersivePushed = false;
    window.history.back();
    return;
  }
  window.history.replaceState(
    null,
    "",
    window.location.pathname + window.location.search,
  );
  page.setState({ forceImmersive: false });
}

/**
 * Decode the slide hash: "#1" → slide 1 immersive, "#3" → slide 3 immersive.
 * Returns { startIndex, forceImmersive }.
 */
export function decodeImmersiveHash(hash) {
  let startIndex = 0;
  let forceImmersive = false;
  if (hash && hash.startsWith("#")) {
    const num = parseInt(hash.slice(1), 10);
    if (!isNaN(num) && num > 0) {
      startIndex = num - 1;
      forceImmersive = true;
    }
  }
  return { startIndex, forceImmersive };
}
