/**
 * Public site footer — copyright, pagination slot (normal), or post tags (immersive).
 *
 * Props:
 *   settings      {object}    Public blog settings (blog_title, author_name)
 *   immersiveTags {object[]}  When non-empty, renders as immersive tag bar instead of pagination slot
 */

import { Component } from "../../components/Component.js";
import { escapeHtml } from "../../utils/helpers.js";
import {
  renderTagLink,
  buildTagIndex,
  setupTagFlyout,
} from "../../utils/tags.js";
import {
  RSS_SVG,
  SUN_SVG,
  MOON_SVG,
  LOGIN_SVG,
  LOGOUT_SVG,
  DASHBOARD_SVG,
} from "../../utils/icons.js";
import { store } from "../../store.js";
import { pluginHost } from "../../core/pluginHost.js";
import { ViewContext } from "../../utils/viewContext.js";

export class PublicFooter extends Component {
  render() {
    const { settings = {}, immersiveTags = [] } = this.props;
    const author = escapeHtml(
      settings.author_name || settings.blog_title || "",
    );

    const aboutHref = settings.about_post_id
      ? `/posts/${escapeHtml(settings.about_post_id)}`
      : "/light";

    // Copyright line: admin-editable template with {{author_name}} / {{engine}}
    // tokens (point-62zu). Literal text is escaped; only known tokens emit HTML.
    const tokens = {
      author_name: author ? `<a href="${aboutHref}">${author}</a>` : "",
      engine: `<a href="https://github.com/dariy/point" target="_blank" rel="noopener noreferrer">Point</a>`,
    };
    const template = (settings.footer_copyright || "").trim()
      || (author ? "© {{author_name}}, powered by {{engine}}" : "© powered by {{engine}}");
    const copyright = template.replace(
      /\{\{(\w+)\}\}|([^{]+|\{)/g,
      (m, token, literal) =>
        token !== undefined
          ? (token in tokens ? tokens[token] : escapeHtml(m))
          : escapeHtml(literal),
    );

    let centerSlot = "";
    if (immersiveTags.length) {
      const navTags = store.get("navTags") || [];
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      const visibleTags = immersiveTags.filter((t) => {
        if (!tagIndex) return true;
        const entry = tagIndex.get(t.slug);
        return !entry || entry.isLeaf;
      });
      const tagLinks = visibleTags.map((t) => renderTagLink(t)).join("");
      centerSlot = `<div class="immersive-tags">${tagLinks}</div>`;
    }

    // About (author link in .footer-copyright), Map and All tags (header
    // buttons) already have canonical entry points elsewhere, so the footer
    // actions only carry what isn't reachable from the chrome: RSS and the
    // theme toggle (moved here from the header).
    const rssButton = pluginHost.isEnabled("rss")
      ? `<a href="/feed.xml" target="_blank" rel="noopener" class="footer-action-btn" title="RSS feed" aria-label="RSS feed">${RSS_SVG}</a>`
      : "";

    const themeToggle = `<button class="footer-action-btn theme-toggle" id="theme-toggle" type="button" aria-label="Toggle theme">
                <span class="icon-sun">${SUN_SVG}</span>
                <span class="icon-moon">${MOON_SVG}</span>
              </button>`;

    // When signed in: keep the /light admin entrance link (one-tap to the
    // panel) and add a log out button next to it. When signed out: a single
    // log in link to the admin app.
    const authButton = store.get("user")
      ? `<a href="/light" class="footer-action-btn" title="Admin panel" aria-label="Admin panel">${DASHBOARD_SVG}</a>
                <button class="footer-action-btn" id="footer-logout" type="button" title="Log out" aria-label="Log out">${LOGOUT_SVG}</button>`
      : `<a href="/light" class="footer-action-btn" title="Log in" aria-label="Log in">${LOGIN_SVG}</a>`;

    return `
      <footer class="site-footer">
        <div class="footer-container">
          <div class="footer-content">
            <div class="footer-left">
              <p class="footer-copyright">${copyright}</p>
            </div>
            <div class="footer-center">
              ${centerSlot}
            </div>
            <div class="footer-right">
              <div class="footer-actions">
                ${rssButton}
                ${themeToggle}
                ${authButton}
              </div>
            </div>
          </div>
        </div>
      </footer>`;
  }

  afterRender() {
    // Theme toggle (moved here from the header; always visible in the footer).
    this.$("#theme-toggle")?.addEventListener("click", () => {
      const current = store.get("theme") || "auto";
      store.set("theme", current === "dark" ? "light" : "dark");
    });

    this.$("#footer-logout")?.addEventListener("click", async () => {
      try {
        const { logout } = await import("../../api/auth.js");
        await logout();
      } catch {
        /* ignore */
      }
      store.set("user", null);
      // Reload so admin-only affordances elsewhere on the page (edit buttons,
      // EXIF, etc.) reflect the logged-out state — re-rendering the footer
      // alone leaves stale admin UI on screen. (point-tj6k)
      window.location.reload();
    });

    const tagsEl = this.$(".immersive-tags");
    if (!tagsEl) return;
    const navTags = store.get("navTags") || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    this._cleanupFlyout = setupTagFlyout(tagsEl, tagIndex, (url) => {
      const slug = url.replace("/tags/", "");
      ViewContext.update({ tag: slug, postSlug: null, query: null });
    });
  }

  beforeRender() {
    this._cleanupFlyout?.();
    this._cleanupFlyout = null;
  }

  beforeUnmount() {
    this.beforeRender();
  }
}
