// Distraction-free (full-screen) mode for the public post list. A floating
// toggle mounted into the `post-list-tools` slot (see HomePage); clicking it
// adds `body.distraction-free`, which the plugin CSS uses to hide every bit of
// chrome (header, footer, timeline, tag cloud, pagination) leaving only the
// post grid. The choice persists in localStorage but the body class is scoped
// to the list page — unmount removes it so post/other pages are unaffected.
//
// On touch the button is the *entrance* only: once inside, the mode is worked
// by vertical flicks (the CSS hides the exit button for a coarse pointer).
// Flick up raises the overlay — the site footer, carrying the paginator in
// every orientation — and flick down puts it away again; a flick down with
// nothing raised leaves the mode. The gestures come from GridPager, which owns
// the recogniser for every grid page (see core/gridPager.js).

const KEY = 'distraction-free';
const MODE_CLASS = 'distraction-free';
const OVERLAY_CLASS = 'distraction-overlay';

const ENTER_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3"/></svg>`;
const EXIT_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/></svg>`;

// localStorage can throw (Safari private mode, disabled cookies); degrade to a
// non-persistent toggle rather than breaking the button.
function readPref() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
function writePref(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

export function mount(el) {
  if (!el) return null;

  // A rapid re-render (e.g. the list's loading→data header swap) can mount a
  // second df plugin before the first is torn down. In DF mode the button is
  // portalled to <body>, so it escapes the header's container clear and lingers
  // — the reported "extra exit button after the footer". This fresh mount is the
  // live one; drop any stray portalled toggle a leaked instance left behind so
  // only ever one button exists. (Off-mode buttons sit inside the header, not as
  // a direct body child, so this only sweeps orphaned portalled ones.)
  document.querySelectorAll('body > .distraction-toggle').forEach((b) => b.remove());

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'header-action-btn distraction-toggle';

  let on = readPref();
  let overlay = false; // never persisted — every entry starts with a clean grid

  const applyOverlay = () => {
    document.body.classList.toggle(OVERLAY_CLASS, on && overlay);
  };

  const apply = () => {
    document.body.classList.toggle(MODE_CLASS, on);
    // In DF mode the button is portalled to body so the header can be hidden
    // entirely (no dead space). On exit it returns to its slot in the nav.
    if (on) {
      document.body.appendChild(btn);
    } else {
      el.appendChild(btn);
    }
    btn.innerHTML = on ? EXIT_SVG : ENTER_SVG;
    btn.setAttribute('aria-label', on ? 'Exit full-screen mode' : 'Full-screen mode');
    btn.setAttribute('aria-pressed', String(on));
    applyOverlay();
  };

  const toggle = () => {
    on = !on;
    overlay = false; // leaving takes the overlay with it; entering starts bare
    writePref(on);
    apply();
  };

  // Flick up raises the overlay, flick down lowers it, and a flick down with the
  // overlay already down leaves the mode — so the two directions are never
  // ambiguous and one gesture only ever does one thing.
  const onVerticalSwipe = (e) => {
    if (!on) return;
    const dir = e.detail?.dir;
    if (dir === 'up') {
      if (overlay) return;
      overlay = true;
      applyOverlay();
    } else if (dir === 'down') {
      if (!overlay) return toggle();
      overlay = false;
      applyOverlay();
    }
  };
  window.addEventListener('point:grid-swipe-vertical', onVerticalSwipe);

  // apply() already parks the button in the right place (holder when off,
  // portalled to body when on). Don't append it to el again afterwards — in DF
  // mode that would drag it back into the display:none header and hide it.
  btn.addEventListener('click', toggle);
  apply();

  return {
    unmount() {
      btn.removeEventListener('click', toggle);
      window.removeEventListener('point:grid-swipe-vertical', onVerticalSwipe);
      btn.remove();
      document.body.classList.remove(MODE_CLASS, OVERLAY_CLASS);
    },
  };
}
