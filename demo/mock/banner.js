/**
 * Demo-only UI: an explanatory banner, a reset control, and a login hint.
 *
 * Lives entirely in the mock entry's module graph, so none of it exists in a
 * normal build — there is no runtime flag to check and no dead branch shipped
 * to real deployments.
 *
 * Styles are injected inline rather than added to frontend/css, because those
 * bundles are shared with production and this markup only ever exists here.
 */

const CREDENTIAL = "demo";

const STYLE = `
  .demo-banner {
    position: fixed; inset-inline: 0; bottom: 0; z-index: 9999;
    display: flex; gap: .75rem; align-items: center; justify-content: center;
    flex-wrap: wrap;
    padding: .6rem 1rem;
    font: 500 .8125rem/1.4 system-ui, sans-serif;
    color: #fff; background: rgba(17, 17, 17, .93);
    backdrop-filter: blur(8px);
    border-top: 1px solid rgba(255, 255, 255, .14);
  }
  .demo-banner[hidden] { display: none; }
  /* The immersive viewers are full-bleed, and the Sheet viewer puts its
     swipe-up hint at the bottom centre — exactly where this bar sits. */
  .demo-banner.is-immersive { display: none; }
  .demo-banner p { margin: 0; }
  .demo-banner strong { font-weight: 650; }
  .demo-banner button {
    padding: .3rem .7rem; font: inherit; color: #fff; cursor: pointer;
    background: rgba(255, 255, 255, .12); border: 1px solid rgba(255, 255, 255, .22);
    border-radius: 6px;
  }
  .demo-banner button:hover { background: rgba(255, 255, 255, .2); }
  .demo-banner a.demo-admin-link {
    padding: .3rem .7rem; font: inherit; color: #fff; text-decoration: none;
    background: rgba(255, 255, 255, .12); border: 1px solid rgba(255, 255, 255, .22);
    border-radius: 6px;
  }
  .demo-banner a.demo-admin-link:hover { background: rgba(255, 255, 255, .2); }
  .demo-banner a.demo-admin-link[hidden] { display: none; }
  .demo-login-hint {
    margin: .5rem 0 0; padding: .5rem .7rem;
    font: .8125rem/1.45 system-ui, sans-serif; text-align: center;
    color: inherit; opacity: .85;
    border: 1px dashed currentColor; border-radius: 6px;
  }
  @media (max-width: 30rem) { .demo-banner { font-size: .75rem; } }
`;

function injectStyles() {
  const el = document.createElement("style");
  el.textContent = STYLE;
  document.head.appendChild(el);
}

function buildBanner() {
  const bar = document.createElement("aside");
  bar.className = "demo-banner";
  bar.setAttribute("role", "note");
  bar.innerHTML = `
    <p><strong>Point demo.</strong> Changes live in this browser tab only.</p>
    <a class="demo-admin-link" href="/light">Open the admin →</a>
    <button type="button" data-demo-reset>Reset demo</button>
    <button type="button" data-demo-dismiss aria-label="Hide this notice">Hide</button>
  `;

  bar.querySelector("[data-demo-reset]").addEventListener("click", () => {
    window.__DEMO_RESET__?.();
  });
  bar.querySelector("[data-demo-dismiss]").addEventListener("click", () => {
    bar.hidden = true;
    try {
      sessionStorage.setItem("demo-banner-hidden", "1");
    } catch {
      /* private browsing — the banner simply returns next load */
    }
  });

  try {
    if (sessionStorage.getItem("demo-banner-hidden") === "1") bar.hidden = true;
  } catch {
    /* ignore */
  }

  return bar;
}

/**
 * The admin UI is the part of the demo worth showing, and nothing on the public
 * site links to it — a real deployment keeps that entrance quiet on purpose.
 * The link hides itself once inside `/light`, where the admin's own navigation
 * takes over.
 */
// Both syncs below run from a MutationObserver that also watches attributes,
// so they must not write an attribute that is already correct: reflecting
// `hidden = true` onto an element that is already hidden still queues a
// mutation record, and the observer would re-enter itself forever.
function syncAdminLink() {
  const link = document.querySelector(".demo-admin-link");
  const hide = window.location.pathname.startsWith("/light");
  if (link && link.hidden !== hide) link.hidden = hide;
}

/**
 * Steps out of the way of the immersive viewers.
 *
 * Kept separate from the `hidden` attribute so that leaving a photo restores
 * whatever the visitor chose — dismissing the bar and stepping aside for a
 * full-screen image are different states.
 */
function syncBannerVisibility() {
  const bar = document.querySelector(".demo-banner");
  if (!bar) return;
  const immersive = !!document.querySelector(".immersive-layout");
  if (bar.classList.contains("is-immersive") !== immersive) {
    bar.classList.toggle("is-immersive", immersive);
  }
}

/**
 * Prefill the login form and explain the credential.
 *
 * The login page is rendered by the SPA after this module runs, and it
 * re-renders on state changes (loading, error), so a one-shot query would miss
 * it. A MutationObserver is the reliable hook without patching LoginPage —
 * which must stay untouched, since it ships to real deployments.
 */
function watchForLogin() {
  const fill = () => {
    const input = document.querySelector("#password-input");
    if (!input || input.dataset.demoFilled) return;
    input.dataset.demoFilled = "1";
    input.value = CREDENTIAL;

    const form = input.closest("form");
    if (form && !form.parentElement.querySelector(".demo-login-hint")) {
      const hint = document.createElement("p");
      hint.className = "demo-login-hint";
      hint.textContent = `Demo password: ${CREDENTIAL} — already filled in. Any value works.`;
      form.insertAdjacentElement("afterend", hint);
    }
  };

  fill();
  return fill;
}

function init() {
  injectStyles();
  document.body.appendChild(buildBanner());
  const fill = watchForLogin();
  syncAdminLink();
  syncBannerVisibility();

  // One observer for all three: the SPA re-renders on every navigation, so this
  // is also the signal that the path — and the immersive layout — may have
  // changed. `attributes` is needed because the immersive viewers announce
  // themselves by toggling a class, not by replacing nodes.
  new MutationObserver(() => {
    fill();
    syncAdminLink();
    syncBannerVisibility();
  }).observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  window.addEventListener("popstate", syncAdminLink);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
