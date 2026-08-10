/**
 * Footer copyright line — one renderer for every surface that shows it.
 *
 * The line is an admin-editable template (`footer_copyright` setting) with
 * `{{author_name}}` / `{{engine}}` tokens and `[text](url)` links. It is
 * rendered identically by the site footer and by the immersive sheet's footer;
 * keeping the markup in one place is what stops those two from drifting.
 */

import { escapeHtml, safeUrl } from "./helpers.js";

const DEFAULT_WITH_AUTHOR = "© {{author_name}}, powered by {{engine}}";
const DEFAULT_NO_AUTHOR = "© powered by {{engine}}";

/**
 * Build the copyright line's inner HTML from public settings.
 *
 * @param {object} settings Public blog settings (author_name, blog_title,
 *                          about_post_id, footer_copyright)
 * @returns {string} HTML — safe to inject, every untrusted part is escaped
 */
export function renderCopyright(settings = {}) {
  const author = escapeHtml(settings.author_name || settings.blog_title || "");
  const aboutHref = settings.about_post_id
    ? `/posts/${escapeHtml(settings.about_post_id)}`
    : "/light";

  const tokens = {
    author_name: author ? `<a href="${aboutHref}">${author}</a>` : "",
    engine: `<a href="https://github.com/dariy/point" target="_blank" rel="noopener noreferrer">Point</a>`,
  };

  // The field is admin-editable, so the href goes through safeUrl() —
  // http(s) and same-site paths only, no `javascript:`. Protocol-relative
  // `//host` is rejected on top of that: safeUrl admits any '/'-leading
  // string, and `//host` is off-site while looking like a path. A rejected
  // href falls through to the literal branch and renders as the text the
  // admin typed, which is visible feedback rather than a vanished line.
  const link = (text, href) => {
    const url = safeUrl(href);
    if (url === "#" || url.startsWith("//")) return null;
    const external = /^https?:\/\//i.test(url);
    const attrs = external ? ` target="_blank" rel="noopener noreferrer"` : "";
    return `<a href="${escapeHtml(url)}"${attrs}>${escapeHtml(text)}</a>`;
  };

  const template =
    (settings.footer_copyright || "").trim() ||
    (author ? DEFAULT_WITH_AUTHOR : DEFAULT_NO_AUTHOR);

  // Literals stop at `{` and `[` so the token and link forms get a chance to
  // match; a lone one of either is consumed as literal text.
  return template.replace(
    /\{\{(\w+)\}\}|\[([^\]]*)\]\(([^)\s]+)\)|([^{[]+|[{[])/g,
    (m, token, text, href, literal) => {
      if (token !== undefined)
        return token in tokens ? tokens[token] : escapeHtml(m);
      if (href !== undefined) return link(text, href) ?? escapeHtml(m);
      return escapeHtml(literal);
    },
  );
}
