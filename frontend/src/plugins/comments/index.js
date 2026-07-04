// Comments (Remark42) — embeds the remark42 widget below post content via the
// `post-comments` slot (see PostContent). The widget is served by the remark42
// sidecar through the plugin-gated /comments reverse proxy, so disabling the
// plugin 404s both this chunk and every widget asset.
//
// Embed contract (verified against upstream app/embed.ts): the script reads
// window.remark_config on load and REQUIRES a node with id="remark42" to exist
// beforehand; it exposes window.REMARK42.{createInstance,changeTheme,destroy}
// and fires "REMARK42::ready" on window after the first init.

const SCRIPT_ID = 'remark42-embed-script';

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
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
    url: post?.slug ? `${window.location.origin}/posts/${post.slug}` : undefined,
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
  } else if (document.getElementById(SCRIPT_ID)) {
    // Script injected but still loading (fast post→post nav before first init).
    onReady = createInstance;
    window.addEventListener('REMARK42::ready', onReady, { once: true });
  } else {
    // First mount: the embed script auto-creates the instance on load.
    const s = document.createElement('script');
    s.id = SCRIPT_ID;
    s.type = 'module';
    s.src = '/comments/web/embed.mjs';
    document.head.appendChild(s);
  }

  // Follow the site theme toggle (app.js dispatches `themechange`).
  const onTheme = () => window.REMARK42?.changeTheme?.(isDark() ? 'dark' : 'light');
  document.addEventListener('themechange', onTheme);

  return {
    unmount() {
      document.removeEventListener('themechange', onTheme);
      if (onReady) window.removeEventListener('REMARK42::ready', onReady);
      // Global destroy tears down the current (only) instance's iframe and
      // window/document listeners; absent when the embed never initialised.
      try { window.REMARK42?.destroy?.(); } catch { /* ignore */ }
      root.remove();
    },
  };
}
