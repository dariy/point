/**
 * StylePickerPage — choose a style preset on a live preview of the site.
 *
 * Route: /style (auth required). The route is outside /light so the page runs
 * in the public section: the preview is the public site header and the post
 * grid of the first home page (GET /api/pages/home), with the owner's own
 * posts and photos. Preset rules scoped to html[data-section="public"] apply
 * to it. HomePage itself is not embedded: it rewrites the URL to "/".
 *
 * A click on a card swaps the #point-theme style element to the preset's CSS
 * (GET /api/themes/:name/css). Nothing is saved until "Apply"
 * (PUT /api/themes/active). Leaving without Apply restores theme.css. A preset
 * is site-wide theme CSS only: post content and per-post CSS do not change.
 */

import { Component } from "../../components/Component.ts";
import { PostGrid } from "../../components/public/PostGrid.ts";
import { pluginHost } from "../../core/pluginHost.ts";
import { getHomePage } from "../../api/pages.ts";
import type { Theme } from "../../api/themes.ts";
import { getThemes, getActiveTheme, setActiveTheme, getThemeCss } from "../../api/themes.ts";
import { getNavTags, getSettings, setToast } from "../../store.ts";
import { html } from "../../utils/helpers.ts";
import { loadThemeCss } from "../../utils/themeLoader.ts";

export default class StylePickerPage extends Component {
  _selected = "";
  _active = "";

  constructor(container: HTMLElement, props = {}) {
    super(container, props);
    this.state = { loading: true, presets: [], posts: [], error: null };
  }

  render() {
    const { loading, error, presets } = this.state;
    if (loading) return html`<div class="loading-spinner" aria-label="Loading styles…"></div>`;
    if (error) return html`<p class="error-state" role="alert">${error}</p>`;

    return html`
      <div id="style-preview" class="style-preview site-wrapper">
        <div id="header-mount"></div>
        <main class="site-main">
          <div class="main-container">
            <div id="grid-mount"></div>
          </div>
        </main>
      </div>
      <aside class="style-picker" aria-label="Choose a look">
        <div class="style-picker-head">
          <h2>Choose a look</h2>
          <p>Click a style to preview it on your site.</p>
        </div>
        <ul class="style-picker-list">
          ${presets.map((t: Theme) => this._renderCard(t))}
        </ul>
        <div class="style-picker-actions">
          <a href="/light" class="style-picker-link">Back to admin</a>
          <button id="style-apply" class="style-picker-apply" disabled>Apply</button>
        </div>
      </aside>`;
  }

  _renderCard(theme: Theme) {
    const p = theme.preset!;
    return html`
      <li>
        <button type="button" class="style-card" data-name="${theme.id}"
                aria-pressed="false">
          <img src="${p.preview_image}" alt="" width="160" height="100" loading="lazy">
          <span class="style-card-name">${p.name}</span>
          <span class="style-card-desc">${p.description}</span>
          <span class="style-card-badge" hidden>Current</span>
        </button>
      </li>`;
  }

  afterRender() {
    if (this.state.loading || this.state.error) return;
    // The page renders once after load: a re-render would unmount the
    // preview, so selection state is written straight to the DOM.
    pluginHost.fill("header", this.$("#header-mount"), {
      settings: getSettings() || {},
      currentPath: "/style",
      navTags: getNavTags() || [],
      total: this.state.posts.length,
    }).then((comps: Component[]) => {
      if (comps[0] && !this._unmounted) this._children.push(comps[0]);
    });
    this.mountChild(PostGrid, "#grid-mount", { posts: this.state.posts });
    this.$$(".style-card").forEach((btn) => {
      btn.addEventListener("click", () => this._select(btn.dataset.name || ""));
    });
    this.container.querySelector("#style-apply")?.addEventListener("click", () => this._apply());
    this._sync();
  }

  mount() {
    super.mount();
    this._load();
  }

  unmount() {
    // A previewed preset must not outlive the page when it was not applied.
    if (this._selected !== this._active) loadThemeCss({ bust: true });
    super.unmount();
  }

  async _load() {
    try {
      const [themes, active, home] = await Promise.all([
        getThemes(),
        getActiveTheme(),
        // A failed feed still leaves the cards usable, with an empty preview.
        getHomePage({ page: 1, per_page: 12 }).catch(() => ({ posts: [] })),
      ]);
      this._active = this._selected = active.id;
      this.setState({
        loading: false,
        presets: themes.filter((t) => t.preset),
        posts: home.posts || [],
        error: null,
      });
    } catch (err) {
      console.error("[StylePickerPage] load error:", err);
      this.setState({ loading: false, error: "Could not load styles." });
    }
  }

  _sync() {
    this.$$(".style-card").forEach((btn) => {
      const name = btn.dataset.name;
      btn.setAttribute("aria-pressed", String(name === this._selected));
      btn.querySelector<HTMLElement>(".style-card-badge")!.hidden = name !== this._active;
    });
    const apply = this.container.querySelector<HTMLButtonElement>("#style-apply");
    if (apply) apply.disabled = this._selected === this._active;
  }

  async _select(name: string) {
    if (!name || name === this._selected) return;
    this._selected = name;
    this._sync();
    try {
      const css = await getThemeCss(name);
      // A later click wins over a slow earlier fetch.
      if (this._selected !== name) return;
      const el = document.getElementById("point-theme");
      if (el) el.textContent = css;
    } catch (err) {
      setToast({ message: (err as Error).message || "Could not load the style.", type: "error" });
    }
  }

  async _apply() {
    const name = this._selected;
    const apply = this.container.querySelector<HTMLButtonElement>("#style-apply");
    if (apply) apply.disabled = true;
    try {
      await setActiveTheme(name);
      await loadThemeCss({ bust: true });
      this._active = name;
      setToast({ message: "Style applied.", type: "success" });
    } catch (err) {
      setToast({ message: (err as Error).message || "Could not apply the style.", type: "error" });
    }
    this._sync();
  }
}
