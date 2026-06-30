/**
 * PostContent — renders a post in normal layout or full-screen immersive mode.
 *
 * Immersive mode activates when the post has image/video media and little/no text.
 * It uses the unified MediaViewer component.
 *
 * Props:
 *   post           {object}      Full post from GET /api/posts/slug/:slug
 *   showViewCount  {boolean}
 *   prevPost       {object|null}
 *   nextPost       {object|null}
 */

import { Component } from "../Component.js";
import { escapeHtml, navigate } from "../../utils/helpers.js";
import { formatDate } from "../../utils/formatters.js";
import {
  buildTagIndex,
  renderTagStrip,
  setupTagStrip,
} from "../../utils/tags.js";
import { store } from "../../store.js";
import { pluginHost } from "../../core/pluginHost.js";
import { getPostPageLocation } from "../../api/posts.js";
import { ViewContext } from "../../utils/viewContext.js";
import { mediaTypeFromPath, stripHtml, mediaFromHtml } from "../../utils/postMedia.js";
import { exifVisible, buildExifMap, metadataForSrc, attachExifToImage } from "../../utils/exif.js";

const _prismLoading = new Map();
const _LANG_DEPS = {
  javascript: ["clike"],
  typescript: ["clike", "javascript"],
  go: ["clike"],
  c: ["clike"],
  cpp: ["clike", "c"],
  java: ["clike"],
  ruby: ["clike"],
};

async function _ensurePrismCore() {
  if (window.Prism) return;
  await import("/assets/vendor/prismjs/prism-core.js");
}

async function _loadPrismLang(lang) {
  if (_prismLoading.has(lang)) return _prismLoading.get(lang);
  const p = (async () => {
    for (const dep of _LANG_DEPS[lang] ?? []) await _loadPrismLang(dep);
    if (!window.Prism?.languages[lang]) {
      await import(`/assets/vendor/prismjs/prism-${lang}.js`);
    }
  })();
  _prismLoading.set(lang, p);
  return p;
}

/**
 * Returns true when the post should render in immersive (full-screen) mode.
 * Exported so PostPage can use the same check to configure its child components.
 */
export function shouldUseImmersive(post) {
  if (!post) return false;
  if (post.immersive_mode === "immersive") return true;
  if (post.immersive_mode === "non-immersive") return false;
  const html = post.content_html || "";
  if (html.includes("<hr>") || html.includes("<hr/>") || html.includes("<hr />")) return true;
  if (post.type === "page" || post.status === "page") return false;
  const media = post.media || [];
  if (media.length && media.every((m) => m.type === "audio")) return false;
  const text = stripHtml(html).replace(/&nbsp;/g, " ").trim();
  if (text.length !== 0) {
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const allMedia = lines.every((l) => /^(?:https?:\/\/|\/)\S+$/.test(l) && mediaTypeFromPath(l));
    if (!allMedia) return false;
  }
  const hasVisualMedia = media.some((m) => m.type !== "audio");
  const hasContentMedia = html.trim().length > 0;
  return hasVisualMedia || hasContentMedia;
}

export class PostContent extends Component {
  render() {
    const { post, prevPost, nextPost, forceImmersive = false } = this.props;
    if (!post) return "";

    const immersive = forceImmersive || shouldUseImmersive(post);
    if (immersive) {
      return `<div id="media-viewer-mount"></div>`;
    }

    return this._renderNormal(post, prevPost, nextPost);
  }

  afterRender() {
    const { post, prevPost, nextPost, forceImmersive = false, tagSlug } = this.props;
    if (!post) return;

    const immersive = forceImmersive || shouldUseImmersive(post);
    if (immersive) {
      document.body.classList.add("immersive-layout");
      // sheetMode is now handled by the plugin.
      const items = mediaFromHtml(post.content_html || "");
      const viewerProps = {
        items,
        media: post.media || [],
        startIndex: this.props.startIndex || 0,
        showShare: true,
        showClose: true,
        navPrev: prevPost,
        navNext: nextPost,
        // Extra context the sheet overlay renders (ignored by classic MediaViewer)
        post,
        editUrl: `/light/posts/${post.id}/edit`,
        onToggleImmersive: this.props.onToggleImmersive,
        onClose: async () => {
          // A post opened from the Atlas returns there — closing reselects its
          // place and highlights the post chip — instead of landing on the
          // post's page in the home feed. The Atlas leaves a context marker on
          // open; we hand it back as the return state keyed to the current post.
          let atlasCtx = null;
          try { atlasCtx = JSON.parse(sessionStorage.getItem("atlasOpenContext") || "null"); } catch { /* ignore */ }
          if (atlasCtx) {
            try {
              sessionStorage.removeItem("atlasOpenContext");
              sessionStorage.setItem("atlasReturn", JSON.stringify({ ...atlasCtx, postSlug: post.slug }));
            } catch { /* ignore */ }
            navigate("/tags");
            return;
          }
          try {
            const params = tagSlug ? { tag: tagSlug } : {};
            const data = await getPostPageLocation(post.slug, params);
            ViewContext.update({ page: data.page, postSlug: null });
          } catch {
            ViewContext.update({ postSlug: null });
          }
        },
        onStep: (index) => {
          const hash = index === 0 ? "" : `#${index + 1}`;
          window.history.replaceState(null, "", window.location.pathname + window.location.search + hash);
        }
      };

      // post-viewer slot (immersive). The Standard and Sheet immersive plugins
      // are alternatives for this exclusive slot, so mount only one (the first
      // enabled, registry order — Standard wins when both are on).
      if (pluginHost.hasSlot('post-viewer')) {
        // Capture the mounted viewer so it's torn down on the next render/unmount
        // — otherwise the old MediaViewer (and any slot plugins it owns, e.g. the
        // slideshow's timers + document listeners) leak across post navigation.
        this._viewer = pluginHost.fillOne('post-viewer', this.$('#media-viewer-mount'), viewerProps);
      }
    } else {
      document.body.classList.remove("immersive-layout", "ui-hidden", "immersive-overlay-sheet");
      const bodyEl = this.$(".post-content");
      if (bodyEl) {
        this._enhanceLinks(bodyEl);
        this._enhanceMedia(bodyEl);
        this._enhanceCodeBlocks(bodyEl);
      }
      this._setupTagStrip();
    }
  }

  _setupTagStrip() {
    const tagsContainer = this.$(".post-footer") || this.$(".post-tags-vertical");
    if (tagsContainer) {
      const navTags = store.get("navTags") || [];
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      this._cleanupStrip = setupTagStrip(tagsContainer, tagIndex, (url) => {
        const slug = url.replace('/tags/', '');
        ViewContext.update({ tag: slug, postSlug: null, query: null });
      });
    }
  }

  _renderNormal(post, prevPost, nextPost) {
    const settings = store.get("settings") || {};
    const isCustomMenu = settings.nav_menu_mode === 'custom';
    const navTags = store.get("navTags") || [];
    const tagIndex = (navTags.length && !isCustomMenu) ? buildTagIndex(navTags) : null;
    const tags = renderTagStrip(post.tags, tagIndex);
    const isHidden = !!(post.is_hidden || post.is_hidden_by_tag);
    const postCss = post.css ? `<style id="post-css">${post.css}</style>` : "";
    // Post navigation (prev/next) is its own toggleable plugin (point-8re1):
    // when manifest-driven and disabled, drop the block from article pages.
    const navEnabled = pluginHost.size === 0 || pluginHost.isEnabled("post-navigation");
    const date = post.published_at || post.created_at;

    return `
      <article class="post-single${isHidden ? " is-hidden" : ""}" itemscope itemtype="https://schema.org/BlogPosting">
        ${postCss}
        <div class="post-layout-grid">
          <div class="post-meta-rail">
            <time datetime="${escapeHtml(date || "")}" class="post-date">${escapeHtml(formatDate(date))}</time>
            ${tags ? `<div class="post-tags-vertical">${tags}</div>` : ""}
          </div>
          <div class="post-main">
            <div class="post-content" itemprop="articleBody">${post.content_html || ""}</div>
          </div>
        </div>
        ${navEnabled ? this._renderNav(prevPost, nextPost) : ""}
      </article>
      ${navEnabled ? this._renderNormalPostArrows(prevPost, nextPost) : ""}`;
  }

  _renderNormalPostArrows(prevPost, nextPost) {
    if (!prevPost && !nextPost) return "";
    const prev = prevPost ? `<a href="/posts/${escapeHtml(prevPost.slug)}" class="post-side-nav-btn prev" aria-label="Previous post">&#10094;</a>` : "";
    const next = nextPost ? `<a href="/posts/${escapeHtml(nextPost.slug)}" class="post-side-nav-btn next" aria-label="Next post">&#10095;</a>` : "";
    return `<nav class="post-side-nav" aria-label="Post side navigation">${prev}${next}</nav>`;
  }

  _enhanceLinks(body) {
    body.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (/^https?:\/\//.test(href)) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });
  }

  _enhanceMedia(body) {
    const { onEnterImmersive, post } = this.props;
    const fallbackAlt = post?.excerpt || post?.title || "";
    body.querySelectorAll("img").forEach((img) => { if (!img.getAttribute("alt")) img.setAttribute("alt", fallbackAlt); });
    if (onEnterImmersive) {
      const items = mediaFromHtml(post.content_html || "");
      const images = Array.from(body.querySelectorAll("img")).filter((img) => !img.closest("a[href]"));
      images.forEach((img) => {
        img.classList.add("zoomable");
        img.setAttribute("tabindex", "0");
        const enter = () => {
          const src = img.getAttribute("src");
          const idx = items.findIndex((item) => item.url === src || (item.type === "html" && item.html.includes(src)));
          onEnterImmersive(idx >= 0 ? idx : 0);
        };
        img.addEventListener("click", enter);
        img.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); enter(); } });
      });
    }
    body.querySelectorAll("audio, video").forEach((el) => el.setAttribute("controls", ""));

    // EXIF info buttons — per-image camera data, when visibility allows.
    const settings = store.get("settings") || {};
    if (exifVisible(settings, store.get("user")) && post?.media?.length) {
      const exifMap = buildExifMap(post.media);
      body.querySelectorAll("img").forEach((img) => {
        // Skip linked images — wrapping them would let the ⓘ button trigger the link.
        if (img.closest("a[href]")) return;
        const meta = metadataForSrc(exifMap, img.getAttribute("src") || img.src || "");
        if (meta) attachExifToImage(img, meta);
      });
    }
  }

  _enhanceCodeBlocks(body) {
    const toHighlight = [];
    body.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      if (!code) return;
      const m = code.className.match(/\blanguage-(\w+)/);
      if (m) toHighlight.push({ code, lang: m[1] });
    });
    if (toHighlight.length === 0) return;
    (async () => {
      await _ensurePrismCore();
      const langs = [...new Set(toHighlight.map((x) => x.lang))];
      await Promise.all(langs.map(_loadPrismLang));
      toHighlight.forEach(({ code }) => window.Prism.highlightElement(code));
    })();
  }

  _renderNav(prev, next) {
    if (!prev && !next) return "";
    const prevLink = prev ? `<a href="/posts/${escapeHtml(prev.slug)}" class="post-nav-link prev" rel="prev"><span class="nav-label">Previous</span><span class="nav-title">${escapeHtml(prev.title)}</span></a>` : "<span></span>";
    const nextLink = next ? `<a href="/posts/${escapeHtml(next.slug)}" class="post-nav-link next" rel="next"><span class="nav-label">Next</span><span class="nav-title">${escapeHtml(next.title)}</span></a>` : "<span></span>";
    return `<nav class="post-navigation" aria-label="Post navigation">${prevLink}${nextLink}</nav>`;
  }

  // Runs before every re-render (including the first) — tear down the previous
  // immersive viewer before its mount node is replaced.
  beforeRender() {
    this._teardownViewer();
  }

  beforeUnmount() {
    this._cleanupStrip?.();
    this._teardownViewer();
  }

  // fillOne() is async, so the handle is a promise resolving to the viewer
  // component (or null). Unmount it once resolved.
  _teardownViewer() {
    const v = this._viewer;
    this._viewer = null;
    if (v) Promise.resolve(v).then((comp) => comp?.unmount?.());
  }
}
