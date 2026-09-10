/**
 * carousel/import/xml.js — the XML side of an import, prefix-agnostic.
 *
 * Both importers read a namespaced XML tree: OOXML through `p:`/`a:`/`r:`, SVG
 * through no prefix at all until someone's exporter adds one. So every lookup
 * here matches on the **local name** — the part after the colon — and never on
 * the qualified name a particular exporter happened to write.
 *
 * Three reasons it is done by hand rather than with the DOM's namespace API:
 *
 * - `getElementsByTagNameNS` is unimplemented in linkedom, which is the DOM the
 *   frontend's tests run against (`docs/vendors.md` allows no npm runtime
 *   dependency, and no browser in `node --test`). A helper the tests cannot
 *   reach is a helper that is not tested.
 * - `localName` is not trustworthy either: linkedom returns `p:cSld` for it,
 *   where a browser parsing the same bytes as XML returns `cSld`. `nodeName`
 *   agrees in both, so the prefix is stripped from that instead.
 * - A CSS selector would need the colon escaped (`p\\:sp`), which reintroduces
 *   the prefix as a hard-coded assumption — the thing this module exists to
 *   avoid.
 *
 * No `innerHTML`, no `appendChild`, nothing inserted into a live document: an
 * imported file is untrusted input from the internet and is only ever read.
 */

/**
 * An element's name with any namespace prefix removed. Reads `nodeName` for
 * the reason in the header — `localName` disagrees between DOMs.
 *
 * @param {Node|null|undefined} node
 * @returns {string}
 */
export function local(node) {
  const name = node ? node.nodeName || '' : '';
  const at = name.indexOf(':');
  return at < 0 ? name : name.slice(at + 1);
}

/**
 * Element children, optionally only those with a given local name, in document
 * order — which for a shape tree is paint order, and is meaning.
 *
 * Indexed rather than spread: `HTMLCollection` is only iterable with the
 * `dom.iterable` lib, and `jsconfig.json` does not name its libs.
 *
 * @param {Element|null|undefined} el
 * @param {string} [name] local name to keep; every child when omitted
 * @returns {Element[]}
 */
export function children(el, name) {
  if (!el) return [];
  const kids = el.children;
  /** @type {Element[]} */
  const out = [];
  for (let i = 0; i < (kids ? kids.length : 0); i++) {
    const kid = kids[i];
    if (!name || local(kid) === name) out.push(kid);
  }
  return out;
}

/**
 * The first element child with this local name, or `null`.
 *
 * @param {Element|null|undefined} el
 * @param {string} name
 * @returns {Element|null}
 */
export function child(el, name) {
  if (!el) return null;
  const kids = el.children;
  for (let i = 0; i < (kids ? kids.length : 0); i++) {
    if (local(kids[i]) === name) return kids[i];
  }
  return null;
}

/**
 * Walk a chain of local names — `path(sp, 'spPr', 'xfrm', 'off')` — stopping at
 * the first link that is missing. OOXML nests four or five deep for every
 * value worth reading, and a chain of `&&`s at each call site reads worse than
 * this does.
 *
 * @param {Element|null|undefined} el
 * @param {...string} names
 * @returns {Element|null}
 */
export function path(el, ...names) {
  let at = el || null;
  for (const name of names) {
    at = child(at, name);
    if (!at) return null;
  }
  return at;
}

/**
 * Every descendant with this local name, document order, self excluded.
 *
 * @param {Element|null|undefined} el
 * @param {string} name
 * @returns {Element[]}
 */
export function descendants(el, name) {
  /** @type {Element[]} */
  const out = [];
  const visit = (/** @type {Element} */ node) => {
    for (const kid of children(node)) {
      if (local(kid) === name) out.push(kid);
      visit(kid);
    }
  };
  if (el) visit(el);
  return out;
}

/**
 * An attribute by local name: `attr(blip, 'embed')` finds `r:embed` whatever
 * the prefix is bound to. The unprefixed lookup is tried first because that is
 * the overwhelmingly common case and it costs one call; the scan is the
 * fallback for a prefixed one.
 *
 * @param {Element|null|undefined} el
 * @param {string} name
 * @returns {string|null}
 */
export function attr(el, name) {
  if (!el) return null;
  const direct = el.getAttribute(name);
  if (direct !== null) return direct;
  const attrs = el.attributes;
  for (let i = 0; i < (attrs ? attrs.length : 0); i++) {
    const a = attrs[i];
    const at = a.name.indexOf(':');
    if (at >= 0 && a.name.slice(at + 1) === name) return a.value;
  }
  return null;
}

/**
 * An attribute as a finite number, or `fallback`. OOXML writes every geometry
 * value as an integer attribute, so this is most of the reading.
 *
 * @param {Element|null|undefined} el
 * @param {string} name
 * @param {number} [fallback]
 * @returns {number}
 */
export function attrNum(el, name, fallback = 0) {
  const raw = attr(el, name);
  if (raw === null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * An OOXML boolean attribute. The schema's `xsd:boolean` allows all four
 * spellings and PowerPoint writes `1` where Canva writes `true`.
 *
 * @param {Element|null|undefined} el
 * @param {string} name
 * @param {boolean} [fallback]
 * @returns {boolean}
 */
export function attrBool(el, name, fallback = false) {
  const raw = attr(el, name);
  if (raw === null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false') return false;
  return fallback;
}

/**
 * Parse XML and return its root element, or `null` when the bytes are not the
 * document we asked for.
 *
 * `null` rather than a throw, and a `root` name rather than trust: the two DOMs
 * disagree about failure. A browser hands back a document whose root is
 * `<parsererror>`; linkedom hands back `documentElement === null` for input it
 * cannot parse at all and a *partial tree* for input that merely ends early.
 * Checking the root's local name is the one test that catches all three, and it
 * is also the check that catches a well-formed XML file that simply is not a
 * slide. The caller turns `null` into whichever failure is theirs — a dead
 * import for `presentation.xml`, one lost slide for `slide7.xml`.
 *
 * @param {string} text
 * @param {string} root expected local name of the document element
 * @param {typeof DOMParser} [Parser] the seam a test uses to supply linkedom's
 * @param {DOMParserSupportedType} [mime] the type to parse as. `image/svg+xml`
 *   for an SVG, so a browser builds the SVG DOM the file asked for rather than
 *   the generic XML one
 * @returns {Element|null}
 */
export function parseXml(text, root, Parser = globalThis.DOMParser, mime = 'application/xml') {
  if (typeof Parser !== 'function') return null;
  let doc;
  try {
    doc = new Parser().parseFromString(text, mime);
  } catch {
    return null;
  }
  const el = doc ? doc.documentElement : null;
  return el && local(el) === root ? el : null;
}
