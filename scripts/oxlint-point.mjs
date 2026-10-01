// The `point/restricted-syntax` rule: ESLint's no-restricted-syntax, which
// Oxlint does not have natively. Each entry is an esquery selector and the
// message reported where it matches. .oxlintrc.json turns the rule on;
// frontend/test/eslintRules.test.js proves every selector still fires.
//
// A TypeScript cast is an AST node — TSAsExpression (`x as T`),
// TSNonNullExpression (`x!`), TSSatisfiesExpression (`x satisfies T`) and
// TSTypeAssertion (`<T>x`) — where a JSDoc cast is a comment the parser drops.
// `(el.innerHTML as any) = s` is a legal assignment, so a selector that names
// `left.property` stops matching once a wrapper sits in between. The helpers
// below spell each position both ways: bare, and inside one wrapper.

const WRAPPERS = "TSAsExpression, TSNonNullExpression, TSSatisfiesExpression, TSTypeAssertion";

// [path=value] for a path that may sit inside a wrapper: `left.property.name`
// also matches `left.expression.property.name`, and so on for each segment
// listed in `at` (the segments a wrapper can occupy).
function attr(path, at = [path.split(".")[0]]) {
  const variants = new Set([path]);
  for (const seg of at) {
    for (const v of [...variants]) {
      const parts = v.split(".");
      const i = parts.indexOf(seg);
      variants.add([...parts.slice(0, i + 1), "expression", ...parts.slice(i + 1)].join("."));
    }
  }
  const list = [...variants].map((v) => `[${v}]`);
  return list.length === 1 ? list[0] : `:matches(${list.join(", ")})`;
}

// `Parent > Child`, also when a wrapper sits between them.
const child = (parent, kid) => `${parent} > ${kid}, ${parent} > :matches(${WRAPPERS}) > ${kid}`;

export const RESTRICTED = [
  {
    // The sinks themselves are now off limits everywhere but the two lines of
    // utils/helpers.ts that implement setHTML()/insertHTML(), which carry a
    // disable comment. That is what makes the Trusted Types policy tractable:
    // the browser will only accept a write that came from the named policy,
    // and exactly one function in the frontend holds it. Writing the markup
    // with html`` is still required — setHTML() throws on anything else — but
    // it is no longer sufficient, because a write that bypasses the funnel
    // bypasses the policy and dies at the sink under enforcement.
    selector: `AssignmentExpression${attr("left.property.name='innerHTML'")}`,
    message: "Use setHTML(el, html`…`) from utils/helpers.ts — a bare innerHTML write bypasses the Trusted Types policy.",
  },
  {
    selector: `AssignmentExpression${attr("left.property.name='outerHTML'")}`,
    message: "Use setHTML() on the parent, or replaceWith() with real nodes — outerHTML bypasses the Trusted Types policy.",
  },
  {
    selector: `CallExpression${attr("callee.property.name='insertAdjacentHTML'")}`,
    message: "Use insertHTML(el, position, html`…`) from utils/helpers.ts — a bare insertAdjacentHTML bypasses the Trusted Types policy.",
  },
  {
    // The three selectors above match a dotted property name, which is what
    // the sinks look like when nobody is trying. A computed key spelling the
    // same name — el['innerHTML'] — reaches the identical sink and used to
    // slip past them, so the name is matched in that position too.
    selector: `AssignmentExpression${attr("left.computed=true")}${attr("left.property.value=/^(inner|outer)HTML$/", ["left", "property"])}`,
    message: "Use setHTML(el, html`…`) from utils/helpers.ts — a computed-key HTML write bypasses the Trusted Types policy.",
  },
  {
    selector: `CallExpression${attr("callee.computed=true")}${attr("callee.property.value='insertAdjacentHTML'", ["callee", "property"])}`,
    message: "Use insertHTML(el, position, html`…`) from utils/helpers.ts — a computed-key insertAdjacentHTML bypasses the Trusted Types policy.",
  },
  {
    // And a key assembled from pieces — el['inner' + 'HTML'] — defeats any
    // name match at all, which is exactly why it was written that way: two
    // sites used it to quiet a CodeQL false positive, and both went on
    // reaching innerHTML directly. In a *write* position a concatenated key
    // has no legitimate use here (an index expression like a[i + 1] is a
    // read, or an array element, and is not matched), so the shape itself is
    // the error whatever name it spells.
    selector: `AssignmentExpression${attr("left.computed=true")}${attr("left.property.operator='+'", ["left", "property"])}:has(Literal[value=/inner|outer|HTML/i])`,
    message: "Do not build a property name from pieces — write the property out, so the HTML-sink rules can see it.",
  },
  {
    selector: `CallExpression${attr("callee.computed=true")}${attr("callee.property.operator='+'", ["callee", "property"])}:has(Literal[value=/insertAdjacent|HTML/i])`,
    message: "Do not build a method name from pieces — write the method out, so the HTML-sink rules can see it.",
  },
  {
    // DOMParser.parseFromString is a Trusted Types sink too, and — the part
    // that costs an afternoon to discover — for *every* mime type, not only
    // text/html: under enforcement a plain string throws there even when the
    // result is an inert XML document that never reaches the page. So the
    // parse goes through parseMarkup() in utils/helpers.ts, where the policy is.
    selector: `CallExpression${attr("callee.property.name='parseFromString'")}`,
    message: "Use parseMarkup(text, mime) from utils/helpers.ts — a bare parseFromString bypasses the Trusted Types policy and throws under enforcement.",
  },
  {
    // raw() is the one way past the html`` tag's escaping, so what may go
    // through it is deliberately narrow: a module-level constant (the SVG
    // blobs), a string literal, or a choice between those. A template literal
    // argument is markup assembled on the spot — exactly the hand-built
    // string this migration removed — and a call is a value the reader
    // cannot check at the call site. Both are errors; the handful of
    // legitimate calls (Prism.highlight, joins of html`` pieces) carry a
    // disable line naming why they are safe.
    selector: child(`CallExpression${attr("callee.name='raw'")}`, "TemplateLiteral"),
    message: "raw() must not wrap a template literal — build the markup with html`` instead.",
  },
  {
    selector: child(`CallExpression${attr("callee.name='raw'")}`, "CallExpression"),
    message: "raw() must not wrap a call. If the value is genuinely pre-escaped, say why on an eslint-disable-next-line.",
  },
  {
    // store.js binds every key to a get/set/subscribe triple and exports
    // those; the string form is what the accessors exist to replace. A typo
    // in a key is undefined at runtime — a component that renders empty
    // forever — where a typo in a named import is an esbuild error naming
    // the closest match. store.js itself is not linted against this: it is
    // where the literals live (the `storeKey` id, skipped in .oxlintrc.json).
    id: "storeKey",
    selector: [
      `CallExpression${attr("callee.object.name='store'", ["callee", "object"])}${attr("callee.property.name=/^(get|set|subscribe|subscribeSelector|merge)$/")} > Literal:first-child`,
      `CallExpression${attr("callee.object.name='store'", ["callee", "object"])}${attr("callee.property.name=/^(get|set|subscribe|subscribeSelector|merge)$/")} > :matches(${WRAPPERS}):first-child > Literal`,
    ].join(", "),
    message: "Use an accessor from store.js (getUser/setUser/onUser, …) — a string key is not checked by anything.",
  },
  {
    // An interpolation landing straight after `attr=` is unquoted, and the
    // helper's URL-position scan only works on quoted attributes. The name
    // must be preceded by whitespace so a query string inside a quoted value
    // (href="/map?tag=${slug}") is not mistaken for one.
    selector: `TaggedTemplateExpression${attr("tag.name='html'")} TemplateElement[value.raw=/\\s[\\w:.-]+=\\s*$/]`,
    message: "Attribute interpolations must be quoted (e.g. href=\"${url}\").",
  },
];

export default {
  meta: { name: "point" },
  rules: {
    "restricted-syntax": {
      meta: {
        schema: [{ type: "object", properties: { skip: { type: "array", items: { type: "string" } } } }],
      },
      create(context) {
        const skip = new Set(context.options[0]?.skip ?? []);
        const visitors = {};
        for (const { id, selector, message } of RESTRICTED) {
          if (id && skip.has(id)) continue;
          visitors[selector] = (node) => context.report({ node, message });
        }
        return visitors;
      },
    },
  },
};
