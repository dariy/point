// Shared rule set — applied to every linted file group below.
const rules = {
  // Basic recommended rules
  "constructor-super": "error",
  "for-direction": "error",
  "getter-return": "error",
  "no-async-promise-executor": "error",
  "no-case-declarations": "error",
  "no-class-assign": "error",
  "no-compare-neg-zero": "error",
  "no-cond-assign": "error",
  "no-const-assign": "error",
  "no-constant-condition": "error",
  "no-control-regex": "error",
  "no-debugger": "error",
  "no-delete-var": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-dupe-else-if": "error",
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-empty": "error",
  "no-empty-character-class": "error",
  "no-empty-pattern": "error",
  "no-ex-assign": "error",
  "no-extra-boolean-cast": "error",
  "no-extra-semi": "error",
  "no-fallthrough": "error",
  "no-func-assign": "error",
  "no-global-assign": "error",
  "no-import-assign": "error",
  "no-inner-declarations": "error",
  "no-invalid-regexp": "error",
  "no-irregular-whitespace": "error",
  "no-loss-of-precision": "error",
  "no-misleading-character-class": "error",
  "no-mixed-spaces-and-tabs": "error",
  "no-new-symbol": "error",
  "no-nonoctal-decimal-escape": "error",
  "no-obj-calls": "error",
  "no-octal": "error",
  "no-prototype-builtins": "error",
  "no-redeclare": "error",
  "no-regex-spaces": "error",
  "no-self-assign": "error",
  "no-setter-return": "error",
  "no-shadow-restricted-names": "error",
  "no-sparse-arrays": "error",
  "no-this-before-super": "error",
  "no-undef": "error",
  "no-unexpected-multiline": "error",
  "no-unreachable": "error",
  "no-unsafe-finally": "error",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",
  "no-unused-labels": "error",
  "no-unused-vars": [
    "warn",
    { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
  ],
  "no-useless-backreference": "error",
  "no-useless-catch": "error",
  "no-useless-escape": "error",
  "no-with": "error",
  "require-yield": "error",
  "use-isnan": "error",
  "valid-typeof": "error",
  "no-console": "off",
  "require-atomic-updates": "off",
  "no-restricted-syntax": [
    "error",
    {
      // The sinks themselves are now off limits everywhere but the two lines of
      // utils/helpers.js that implement setHTML()/insertHTML(), which carry a
      // disable comment. That is what makes the Trusted Types policy tractable:
      // the browser will only accept a write that came from the named policy,
      // and exactly one function in the frontend holds it. Writing the markup
      // with html`` is still required — setHTML() throws on anything else — but
      // it is no longer sufficient, because a write that bypasses the funnel
      // bypasses the policy and dies at the sink under enforcement.
      selector: "AssignmentExpression[left.property.name='innerHTML']",
      message: "Use setHTML(el, html`…`) from utils/helpers.js — a bare innerHTML write bypasses the Trusted Types policy."
    },
    {
      selector: "AssignmentExpression[left.property.name='outerHTML']",
      message: "Use setHTML() on the parent, or replaceWith() with real nodes — outerHTML bypasses the Trusted Types policy."
    },
    {
      selector: "CallExpression[callee.property.name='insertAdjacentHTML']",
      message: "Use insertHTML(el, position, html`…`) from utils/helpers.js — a bare insertAdjacentHTML bypasses the Trusted Types policy."
    },
    {
      // raw() is the one way past the html`` tag's escaping, so what may go
      // through it is deliberately narrow: a module-level constant (the SVG
      // blobs), a string literal, or a choice between those. A template literal
      // argument is markup assembled on the spot — exactly the hand-built
      // string this migration removed — and a call is a value the reader
      // cannot check at the call site. Both are errors; the handful of
      // legitimate calls (Prism.highlight, joins of html`` pieces) carry an
      // eslint-disable line naming why they are safe.
      selector: "CallExpression[callee.name='raw'] > TemplateLiteral",
      message: "raw() must not wrap a template literal — build the markup with html`` instead."
    },
    {
      selector: "CallExpression[callee.name='raw'] > CallExpression",
      message: "raw() must not wrap a call. If the value is genuinely pre-escaped, say why on an eslint-disable-next-line."
    },
    {
      // An interpolation landing straight after `attr=` is unquoted, and the
      // helper's URL-position scan only works on quoted attributes. The name
      // must be preceded by whitespace so a query string inside a quoted value
      // (href="/map?tag=${slug}") is not mistaken for one.
      selector: "TaggedTemplateExpression[tag.name='html'] TemplateElement[value.raw=/\\s[\\w:.-]+=\\s*$/]",
      message: "Attribute interpolations must be quoted (e.g. href=\"${url}\")."
    }
  ],
};

export default [
  {
    // `npx eslint .` otherwise walks the runtime storage directory (and the
    // generated bundles), which is not source and is not always readable.
    ignores: ["data/**", "frontend/js/**", "frontend/js-debug/**", "frontend/vendor/**"],
  },
  {
    // demo/mock/ is browser code too — it is bundled into the static demo in
    // place of the normal entry point (demo/scripts/build.sh).
    files: ["frontend/src/**/*.js", "demo/mock/**/*.js"],
    languageOptions: {
      // 2022 for top-level await (demo/mock/shim.js) — the bundles are --format=esm.
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Browser globals
        globalThis: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        location: "readonly",
        fetch: "readonly",
        Response: "readonly",
        structuredClone: "readonly",
        XMLHttpRequest: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        CustomEvent: "readonly",
        Event: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        Image: "readonly",
        Audio: "readonly",
        Video: "readonly",
        FileReader: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        File: "readonly",
        crypto: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        requestIdleCallback: "readonly",
        cancelIdleCallback: "readonly",
        history: "readonly",
        indexedDB: "readonly",
        caches: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        alert: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        DOMParser: "readonly",
        customElements: "readonly",
        HTMLElement: "readonly",
        HTMLImageElement: "readonly",
        ResizeObserver: "readonly",
        MutationObserver: "readonly",
        performance: "readonly",
        atob: "readonly",
        btoa: "readonly",
        Uint8Array: "readonly",
        ArrayBuffer: "readonly",
        PublicKeyCredential: "readonly",
        AbortController: "readonly",
        getComputedStyle: "readonly",
        MouseEvent: "readonly",
        CSS: "readonly",
        // ES2021 globals
        Promise: "readonly",
        Map: "readonly",
        Set: "readonly",
        JSON: "readonly",
        Math: "readonly",
        Date: "readonly",
        // Build-time constant injected by esbuild --define (see scripts/build-js.sh).
        // `false` in the release bundle, `true` in the debug bundle.
        __DEBUG__: "readonly",
      },
    },
    rules,
  },
  // Service worker — ServiceWorkerGlobalScope, not Window (no document/window).
  {
    files: ["frontend/sw.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
      globals: {
        self: "readonly",
        caches: "readonly",
        indexedDB: "readonly",
        fetch: "readonly",
        navigator: "readonly",
        crypto: "readonly",
        console: "readonly",
        URL: "readonly",
        Response: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Promise: "readonly",
        JSON: "readonly",
        Math: "readonly",
        Date: "readonly",
      },
    },
    rules,
  },
  // Node build scripts (e.g. scripts/build-plugin-manifest.mjs) and the demo's
  // content-generation and build tooling (demo/scripts/, demo/world.mjs).
  {
    files: ["scripts/**/*.mjs", "demo/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        JSON: "readonly",
        // Node 18+ provides these as globals; the demo recorder, generator and
        // acceptance test use them directly rather than pulling in a client.
        fetch: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
    rules,
  },
  // The demo's acceptance test drives a real browser: every callback it hands to
  // Playwright's page.evaluate() is serialised and executed *in the page*, where
  // the DOM globals exist. It is Node code that legitimately contains browser
  // code, so it needs both sets.
  {
    files: ["demo/scripts/test.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        JSON: "readonly",
        fetch: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        document: "readonly",
        window: "readonly",
        location: "readonly",
      },
    },
    rules,
  },
];
