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
      // The three selectors above match a dotted property name, which is what
      // the sinks look like when nobody is trying. A computed key spelling the
      // same name — el['innerHTML'] — reaches the identical sink and used to
      // slip past them, so the name is matched in that position too.
      selector: "AssignmentExpression[left.computed=true][left.property.value=/^(inner|outer)HTML$/]",
      message: "Use setHTML(el, html`…`) from utils/helpers.js — a computed-key HTML write bypasses the Trusted Types policy."
    },
    {
      selector: "CallExpression[callee.computed=true][callee.property.value='insertAdjacentHTML']",
      message: "Use insertHTML(el, position, html`…`) from utils/helpers.js — a computed-key insertAdjacentHTML bypasses the Trusted Types policy."
    },
    {
      // And a key assembled from pieces — el['inner' + 'HTML'] — defeats any
      // name match at all, which is exactly why it was written that way: two
      // sites used it to quiet a CodeQL false positive, and both went on
      // reaching innerHTML directly. In a *write* position a concatenated key
      // has no legitimate use here (an index expression like a[i + 1] is a
      // read, or an array element, and is not matched), so the shape itself is
      // the error whatever name it spells.
      selector: "AssignmentExpression[left.computed=true][left.property.type='BinaryExpression'][left.property.operator='+']:has(Literal[value=/inner|outer|HTML/i])",
      message: "Do not build a property name from pieces — write the property out, so the HTML-sink rules can see it."
    },
    {
      selector: "CallExpression[callee.computed=true][callee.property.type='BinaryExpression'][callee.property.operator='+']:has(Literal[value=/insertAdjacent|HTML/i])",
      message: "Do not build a method name from pieces — write the method out, so the HTML-sink rules can see it."
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
      // store.js binds every key to a get/set/subscribe triple and exports
      // those; the string form is what the accessors exist to replace. A typo
      // in a key is undefined at runtime — a component that renders empty
      // forever — where a typo in a named import is an esbuild error naming
      // the closest match. store.js itself is not linted against this: it is
      // where the literals live.
      selector: "CallExpression[callee.object.name='store'][callee.property.name=/^(get|set|subscribe|subscribeSelector|merge)$/] > Literal:first-child",
      message: "Use an accessor from store.js (getUser/setUser/onUser, …) — a string key is not checked by anything."
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
  {
    // The key literals themselves live in store.js — that is the whole point
    // of the rule above, so the file that owns them is exempt from it.
    files: ["frontend/src/store.js"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...rules["no-restricted-syntax"].slice(1).filter(
          (r) => !r.selector.startsWith("CallExpression[callee.object.name='store']"),
        ),
      ],
    },
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
