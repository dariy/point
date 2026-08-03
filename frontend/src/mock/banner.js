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
  .demo-banner p { margin: 0; }
  .demo-banner strong { font-weight: 650; }
  .demo-banner button {
    padding: .3rem .7rem; font: inherit; color: #fff; cursor: pointer;
    background: rgba(255, 255, 255, .12); border: 1px solid rgba(255, 255, 255, .22);
    border-radius: 6px;
  }
  .demo-banner button:hover { background: rgba(255, 255, 255, .2); }
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
    <p><strong>Point demo.</strong> Everything works, nothing is saved —
       changes live in this browser tab only.</p>
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
  new MutationObserver(fill).observe(document.body, {
    childList: true,
    subtree: true,
  });
}

function init() {
  injectStyles();
  document.body.appendChild(buildBanner());
  watchForLogin();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
