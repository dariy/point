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
import { escapeHtml } from "../../utils/helpers.js";
import { formatDate } from "../../utils/formatters.js";
import {
  buildTagIndex,
  renderTagStrip,
  setupTagStrip,
} from "../../utils/tags.js";
import { store } from "../../store.js";
import { getPostPageLocation } from "../../api/posts.js";
import { ViewContext } from "../../utils/viewContext.js";
import { MediaViewer } from "./MediaViewer.js";

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

const VIDEO_EXTS = new Set(["mp4", "webm", "mov", "ogv", "m4v", "avi", "mkv"]);
const AUDIO_EXTS = new Set(["mp3", "m4a", "ogg", "wav", "flac", "aac", "opus"]);

/** Return 'video', 'audio', 'image', or null based on file extension. */
function mediaTypeFromPath(path) {
  const ext = (path.split(".").pop() || "").toLowerCase();
  if (VIDEO_EXTS.has(ext)) return "video";
  if (AUDIO_EXTS.has(ext)) return "audio";
  const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "heic", "heif", "bmp"]);
  if (IMAGE_EXTS.has(ext)) return "image";
  return null;
}

function stripHtml(html) {
  if (!html) return "";
  let previous;
  do {
    previous = html;
    html = html.replace(/<[^>]*>/g, "");
  } while (html !== previous);
  return html;
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
      const items = this._mediaFromHtml(post.content_html || "");
      this.mountChild(MediaViewer, '#media-viewer-mount', {
        items,
        startIndex: this.props.startIndex || 0,
        showShare: true,
        navPrev: prevPost,
        navNext: nextPost,
        onClose: async () => {
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
      });
    } else {
      document.body.classList.remove("immersive-layout", "ui-hidden");
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
    const navTags = store.get("navTags") || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    const tags = renderTagStrip(post.tags, tagIndex);
    const isHidden = !!(post.is_hidden || post.is_hidden_by_tag);
    const postCss = post.css ? `<style id="post-css">${post.css}</style>` : "";
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
        ${this._renderNav(prevPost, nextPost)}
      </article>
      ${this._renderNormalPostArrows(prevPost, nextPost)}`;
  }

  _renderNormalPostArrows(prevPost, nextPost) {
    if (!prevPost && !nextPost) return "";
    const prev = prevPost ? `<a href="/posts/${escapeHtml(prevPost.slug)}" class="post-side-nav-btn prev" aria-label="Previous post">&#10094;</a>` : "";
    const next = nextPost ? `<a href="/posts/${escapeHtml(nextPost.slug)}" class="post-side-nav-btn next" aria-label="Next post">&#10095;</a>` : "";
    return `<nav class="post-side-nav" aria-label="Post side navigation">${prev}${next}</nav>`;
  }

  _mediaFromHtml(html) {
    const items = [];
    if (html.includes("<hr>") || html.includes("<hr/>") || html.includes("<hr />")) {
      const segments = html.split(/<hr\s*\/?>/i);
      for (const segment of segments) {
        const trimmed = segment.trim();
        if (!trimmed) continue;
        const segmentMedia = this._extractMedia(trimmed);
        const text = stripHtml(trimmed).replace(/&nbsp;/g, " ").trim();
        if (segmentMedia.length === 1 && (text.length === 0 || text === segmentMedia[0].url)) {
          items.push(segmentMedia[0]);
        } else {
          items.push({ type: "html", html: trimmed });
        }
      }
      if (items.length > 0) return items;
    }
    return this._extractMedia(html);
  }

  _extractMedia(html) {
    const items = [];
    for (const m of html.matchAll(/<img[^>]+>/gi)) {
      const src = (m[0].match(/\ssrc="([^"]*)"/i) || [])[1] || "";
      const alt = (m[0].match(/\salt="([^"]*)"/i) || [])[1] || "";
      if (src) items.push({ type: "image", url: src, alt });
    }
    for (const m of html.matchAll(/<(?:video|source)[^>]*\ssrc="([^"]*)"[^>]*/gi)) if (m[1]) items.push({ type: "video", url: m[1] });
    for (const m of html.matchAll(/<audio[^>]*\ssrc="([^"]*)"[^>]*/gi)) if (m[1]) items.push({ type: "audio", url: m[1] });
    if (items.length === 0) {
      const text = stripHtml(html).trim();
      for (const line of text.split(/\n+/)) {
        const url = line.trim();
        if (url) {
          const type = mediaTypeFromPath(url);
          if (type) items.push({ type, url });
        }
      }
    }
    return items;
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
      const items = this._mediaFromHtml(post.content_html || "");
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

  beforeUnmount() {
    this._cleanupStrip?.();
  }
}
