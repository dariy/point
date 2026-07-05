// Comments (Remark42) — embeds the remark42 widget below post content via the
// `post-comments` slot (see PostContent). The widget is served by the remark42
// sidecar through the plugin-gated /comments reverse proxy, so disabling the
// plugin 404s both this chunk and every widget asset.
//
// Embed contract (verified against upstream app/embed.ts): the script reads
// window.remark_config on load and REQUIRES a node with id="remark42" to exist
// beforehand; it exposes window.REMARK42.{createInstance,changeTheme,destroy}
// and fires "REMARK42::ready" on window after the first init.

import CommentsAdminPage from './CommentsAdminPage.js';

const SCRIPT_ID = 'remark42-embed-script';

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// ── Theme color sync ────────────────────────────────────────────────────────
// remark42's widget CSS is driven by custom properties on its iframe's :root
// (RGB triplets like `--primary-color: 0,170,170`, flipped by a `.dark` class
// inside the iframe). The iframe is same-origin (served via /comments), so we
// inject overrides computed from the active site theme's tokens. Values are
// injected as literals, so onTheme re-runs the sync after every theme change.
// Coupled to remark42's variable names — re-check on remark42 upgrades.

// [site token, remark42 var] — remark42 expects bare "r,g,b" triplets here.
const TRIPLET_VARS = [
  ['--color-primary', '--primary-color'],
  ['--color-primary', '--primary-darker-color'],
  ['--color-primary-hover', '--primary-brighter-color'],
  ['--text-primary', '--primary-text-color'],
  ['--text-primary', '--text-color'],
  ['--text-secondary', '--secondary-text-color'],
  ['--text-muted', '--secondary-darker-text-color'],
  ['--bg-primary', '--primary-background-color'],
];
// [site token, remark42 var] — plain color values. --color9/15/29/33 are
// remark42's raw teal accent scale, used directly by some links/buttons.
const COLOR_VARS = [
  ['--border-primary', '--line-color'],
  ['--border-secondary', '--line-brighter-color'],
  ['--color-primary', '--color9'],
  ['--color-primary', '--color33'],
  ['--color-primary-hover', '--color15'],
  ['--color-primary-hover', '--color29'],
];

function themeCss() {
  // Probe element: getComputedStyle resolves any token to canonical rgb().
  const probe = document.createElement('div');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const resolve = (token) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const rules = [];
  for (const [token, remarkVar] of TRIPLET_VARS) {
    const m = resolve(token).match(/\d+/g);
    if (m) rules.push(`${remarkVar}:${m.slice(0, 3).join(',')}`);
  }
  for (const [token, remarkVar] of COLOR_VARS) {
    rules.push(`${remarkVar}:${resolve(token)}`);
  }
  probe.remove();
  // `:root .dark` too, so the overrides beat remark42's own dark-mode block.
  return `:root, :root .dark{${rules.join(';')}}`;
}

function syncColors(root) {
  const iframe = root.querySelector('iframe');
  const doc = iframe && iframe.contentDocument;
  if (!doc || !doc.head) return false;
  let style = doc.getElementById('point-theme-sync');
  if (!style) {
    style = doc.createElement('style');
    style.id = 'point-theme-sync';
    doc.head.appendChild(style);
    // An iframe reload wipes injected nodes — re-inject when it happens.
    iframe.addEventListener('load', () => setTimeout(() => syncColors(root), 0));
  }
  style.textContent = themeCss();
  return true;
}

// The iframe appears asynchronously after createInstance; retry briefly.
function scheduleColorSync(root, attempt = 0) {
  if (syncColors(root) || attempt > 20) return;
  setTimeout(() => scheduleColorSync(root, attempt + 1), 150);
}

export function mount(el, ctx) {
  if (!el) return null;
  const post = ctx?.post;

  const root = document.createElement('div');
  root.id = 'remark42';
  el.appendChild(root);

  window.remark_config = {
    host: `${window.location.origin}/comments`,
    site_id: 'remark',
    // Thread key + link target in notification emails / moderation. Keyed by
    // id, not slug, so renaming a slug keeps the thread; GetPostBySlug resolves
    // numeric /posts/<id> permalinks so those links render the post.
    url: post?.id ? `${window.location.origin}/posts/${post.id}` : undefined,
    page_title: post?.title || undefined,
    theme: isDark() ? 'dark' : 'light',
  };

  let onReady = null;
  const createInstance = () => {
    try {
      window.REMARK42.createInstance(window.remark_config);
    } catch (err) {
      console.error('[comments] remark42 init failed:', err);
    }
  };

  if (window.REMARK42?.createInstance) {
    // Embed already loaded (SPA navigation) — re-init for this post.
    createInstance();
    scheduleColorSync(root);
  } else if (document.getElementById(SCRIPT_ID)) {
    // Script injected but still loading (fast post→post nav before first init).
    onReady = () => {
      createInstance();
      scheduleColorSync(root);
    };
    window.addEventListener('REMARK42::ready', onReady, { once: true });
  } else {
    // First mount: the embed script auto-creates the instance on load.
    const s = document.createElement('script');
    s.id = SCRIPT_ID;
    s.type = 'module';
    s.src = '/comments/web/embed.mjs';
    document.head.appendChild(s);
    onReady = () => scheduleColorSync(root);
    window.addEventListener('REMARK42::ready', onReady, { once: true });
  }

  // Follow the site theme toggle (app.js dispatches `themechange`) and, for
  // the "auto" theme, OS-level scheme flips (which don't fire `themechange`).
  const onTheme = () => {
    window.REMARK42?.changeTheme?.(isDark() ? 'dark' : 'light');
    syncColors(root);
  };
  document.addEventListener('themechange', onTheme);
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  mql.addEventListener('change', onTheme);

  return {
    unmount() {
      document.removeEventListener('themechange', onTheme);
      mql.removeEventListener('change', onTheme);
      if (onReady) window.removeEventListener('REMARK42::ready', onReady);
      // Global destroy tears down the current (only) instance's iframe and
      // window/document listeners; absent when the embed never initialised.
      try { window.REMARK42?.destroy?.(); } catch { /* ignore */ }
      root.remove();
    },
  };
}

// Route module for the /light/comments moderation page (nav-menu pattern:
// one chunk = public slot mount + admin page default export).
export default CommentsAdminPage;
