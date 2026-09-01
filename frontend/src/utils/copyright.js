/**
 * Footer copyright line — one renderer for every surface that shows it.
 *
 * The line is an admin-editable template (`footer_copyright` setting) with
 * `{{author_name}}` / `{{engine}}` tokens and `[text](url)` links. It is
 * rendered identically by the site footer and by the immersive sheet's footer;
 * keeping the markup in one place is what stops those two from drifting.
 */

import { escapeHtml, html, raw, safeUrl } from "./helpers.js";

const DEFAULT_WITH_AUTHOR = "© {{author_name}}, powered by {{engine}}";
const DEFAULT_NO_AUTHOR = "© powered by {{engine}}";

/**
 * Build the copyright line's inner markup from public settings.
 *
 * @param {object} settings Public blog settings (author_name, blog_title,
 *                          about_post_id, footer_copyright)
 * @returns {import("./helpers.js").RawHtml} markup — safe to inject, every
 *   untrusted part is escaped by the html`` tag that built it
 */
export function renderCopyright(settings = {}) {
  const author = settings.author_name || settings.blog_title || "";
  const aboutHref = settings.about_post_id
    ? `/posts/${settings.about_post_id}`
    : "/light";

  const tokens = {
    author_name: author ? html`<a href="${aboutHref}">${author}</a>` : html``,
    engine: html`<a href="https://github.com/dariy/point" target="_blank" rel="noopener noreferrer">Point</a>`,
  };

  // The field is admin-editable, so the href goes through safeUrl() —
  // http(s) and same-site paths only, no `javascript:`. Protocol-relative
  // `//host` is rejected on top of that: safeUrl admits any '/'-leading
  // string, and `//host` is off-site while looking like a path. A rejected
  // href falls through to the literal branch and renders as the text the
  // admin typed, which is visible feedback rather than a vanished line.
  //
  // `url` is the verdict only — the attribute interpolates the raw href, so
  // the tag applies safeUrl() to it exactly once. Feeding the already-escaped
  // `url` back in would escape its ampersands a second time.
  const link = (text, href) => {
    const url = safeUrl(href);
    if (url === "#" || url.startsWith("//")) return null;
    return /^https?:\/\//i.test(url)
      ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
      : html`<a href="${href}">${text}</a>`;
  };

  const template =
    (settings.footer_copyright || "").trim() ||
    (author ? DEFAULT_WITH_AUTHOR : DEFAULT_NO_AUTHOR);

  // A text substitution, not a template: String.replace hands the callback
  // literal runs of the admin's line, which are escaped as text, and token /
  // link matches, which are replaced by markup html`` already escaped. So the
  // result is assembled from safe pieces and raw() states that once, here.
  //
  // Literals stop at `{` and `[` so the token and link forms get a chance to
  // match; a lone one of either is consumed as literal text.
  // The callback returns escaped text and html`` markup only; raw() states
  // that about the assembled result.
  // eslint-disable-next-line no-restricted-syntax
  return raw(template.replace(
    /\{\{(\w+)\}\}|\[([^\]]*)\]\(([^)\s]+)\)|([^{[]+|[{[])/g,
    (m, token, text, href, literal) => {
      if (token !== undefined)
        return token in tokens ? String(tokens[token]) : escapeHtml(m);
      if (href !== undefined) return String(link(text, href) ?? escapeHtml(m));
      return escapeHtml(literal);
    },
  ));
}
