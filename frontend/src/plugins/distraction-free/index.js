// Distraction-free (full-screen) mode for the public post list. A floating
// toggle mounted into the `post-list-tools` slot (see HomePage); clicking it
// adds `body.distraction-free`, which the plugin CSS uses to hide every bit of
// chrome (header, footer, timeline, tag cloud, pagination) leaving only the
// post grid. The choice persists in localStorage but the body class is scoped
// to the list page — unmount removes it so post/other pages are unaffected.

const KEY = 'distraction-free';

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

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'header-action-btn distraction-toggle';

  let on = readPref();

  const apply = () => {
    document.body.classList.toggle('distraction-free', on);
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
  };

  const toggle = () => {
    on = !on;
    writePref(on);
    apply();
  };

  // apply() already parks the button in the right place (holder when off,
  // portalled to body when on). Don't append it to el again afterwards — in DF
  // mode that would drag it back into the display:none header and hide it.
  btn.addEventListener('click', toggle);
  apply();

  return {
    unmount() {
      btn.removeEventListener('click', toggle);
      btn.remove();
      document.body.classList.remove('distraction-free');
    },
  };
}
