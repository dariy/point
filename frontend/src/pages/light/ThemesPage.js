// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.10.
/**
 * ThemesPage — admin theme management.
 *
 * Lists available themes and allows setting the active one.
 */

import { Component } from "../../components/Component.js";
import { adminLayoutTemplate, setupAdminLayout } from "../../components/light/AdminLayout.js";
import { getThemes, getActiveTheme, setActiveTheme, getCustomCSS, updateCustomCSS } from "../../api/themes.js";
import { store } from "../../store.js";
import { html, raw } from "../../utils/helpers.js";
import { STAR_SVG, MOON_SVG } from "../../utils/icons.js";
import { setupTextareaMaximizer } from "../../utils/textareaMaximizer.js";
import { CssEditor } from "../../components/light/CssEditor.js";
import { pluginHost } from "../../core/pluginHost.js";
import { loadThemeCss } from "../../utils/themeLoader.js";

const CSS_COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([0-9.,%\s/]+\)|hsla?\([0-9.,%\s/deg]+\))$/i;

export default class ThemesPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      themes: [],
      activeTheme: null,
      customCSS: "",
      error: null,
      saving: false,
      savingCSS: false,
      isMaximized: false,
    };
  }

  render() {
    return adminLayoutTemplate({
      title: 'Themes',
      content: this._renderContent()
    });
  }

  _renderContent() {
    const { loading, error, themes, activeTheme, saving, savingCSS } = this.state;

    if (loading) return html`<div class="loading-spinner" aria-label="Loading themes…"></div>`;
    if (error) return html`<p class="error-state" role="alert">${error}</p>`;

    return html`
        <div class="themes-grid">
          ${themes.map((theme) => this._renderThemeCard(theme, activeTheme, saving))}
        </div>
        
        ${pluginHost.isEnabled("custom-css") ? html`
        <section class="custom-css-section card">
          <div class="card-header">
            <h2>Custom CSS</h2>
            <button id="save-css-btn" class="btn btn-sm btn-primary" ${savingCSS ? "disabled" : ""}>
              ${savingCSS ? "Saving…" : "Save CSS"}
            </button>
          </div>
          <div class="card-body">
            <p class="form-hint">Applied globally to the public site.</p>
            <div id="css-editor-mount"></div>
          </div>
        </section>
        ` : ''}`;
  }

  // Theme colours reach the DOM through an inline style attribute, so only
  // plain colour literals are let through — a theme file is admin-authored but
  // its values are still free text, and escaping alone would not stop extra
  // declarations being smuggled into the attribute.
  _color(value, fallback) {
    const v = String(value || "").trim();
    return CSS_COLOR_RE.test(v) ? v : fallback;
  }

  _renderThemeCard(theme, activeTheme, saving) {
    const isActive = activeTheme === theme.name;
    const swatch = [
      `--swatch-bg:${this._color(theme.preview_bg, "#f4f4f5")}`,
      `--swatch-surface:${this._color(theme.preview_surface, "#ffffff")}`,
      `--swatch-text:${this._color(theme.preview_text, "#18181b")}`,
      `--swatch-border:${this._color(theme.preview_border, "rgba(0,0,0,0.12)")}`,
      `--swatch-accent:${this._color(theme.preview_color, "#71717a")}`,
    ].join(";");

    return html`
      <article class="theme-card ${isActive ? "active" : ""}">
        <div class="theme-swatch" style="${swatch}" aria-hidden="true">
          <span class="theme-swatch-bar"></span>
          <span class="theme-swatch-page">
            <span class="theme-swatch-line"></span>
            <span class="theme-swatch-line"></span>
            <span class="theme-swatch-line short"></span>
          </span>
        </div>
        <div class="theme-card-info">
          <h3 class="theme-name">
            ${theme.name}
            ${theme.has_dark_mode ? html`<span class="theme-dark-badge" title="Ships a dark mode">${raw(MOON_SVG)}</span>` : ""}
          </h3>
          ${theme.description ? html`<p class="theme-description">${theme.description}</p>` : ""}
        </div>
        <div class="theme-card-action">
          <button class="btn btn-sm ${isActive ? "btn-secondary" : "btn-primary"} set-active-btn"
                  data-name="${theme.name}" ${isActive || saving ? "disabled" : ""}>
            ${isActive ? html`${raw(STAR_SVG)} Active` : "Set Active"}
          </button>
        </div>
      </article>`;
  }

  afterRender() {
    setupAdminLayout(this, {
      currentPath: "/light/themes",
    });

    setupTextareaMaximizer(this.container);

    if (this.state.loading || this.state.error) return;

    this.container.querySelectorAll(".set-active-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._handleSetActive(btn.dataset.name));
    });

    if (pluginHost.isEnabled("custom-css")) {
      this.mountChild(CssEditor, "#css-editor-mount", {
        value: this.state.customCSS,
        isMaximized: this.state.isMaximized,
        onChange: (val) => {
          this.state.customCSS = val;
        },
      });

      this.container.querySelector("#save-css-btn")?.addEventListener("click", () => this._handleSaveCSS());

      this.container.addEventListener("textarea:maximize", (e) => {
        this.state.isMaximized = e.detail.isMaximized;
      });

      this.container.addEventListener("textarea:save", () => this._handleSaveCSS());
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      // The custom-css endpoint is gated by the custom-css plugin (404s when
      // disabled). Only fetch it when the plugin is enabled, otherwise its
      // rejection would fail the whole page load.
      const cssEnabled = pluginHost.isEnabled("custom-css");
      const [themes, activeTheme, customCSS] = await Promise.all([
        getThemes(),
        getActiveTheme(),
        cssEnabled ? getCustomCSS() : Promise.resolve({ css: "" }),
      ]);
      this.setState({
        loading: false,
        themes: Array.isArray(themes) ? themes : (themes.themes || []),
        activeTheme: activeTheme.name,
        customCSS: customCSS.css || "",
        error: null,
      });
    } catch (err) {
      console.error("[ThemesPage] load error:", err);
      this.setState({ loading: false, error: "Could not load themes." });
    }
  }

  async _handleSetActive(name) {
    this.setState({ saving: true });
    try {
      await setActiveTheme(name);
      // The response means the server has already rewritten theme.css, so
      // re-fetching it repaints the whole app in the new theme the way the
      // light/dark toggle does. Cache-busted: the URL is unchanged.
      await loadThemeCss({ bust: true });
      store.set("toast", { message: `Theme "${name}" activated.`, type: "success" });
      this.setState({ saving: false, activeTheme: name });
    } catch (err) {
      store.set("toast", { message: err.message || "Failed to set theme.", type: "error" });
      this.setState({ saving: false });
    }
  }

  async _handleSaveCSS() {
    const css = this.state.customCSS;
    this.setState({ savingCSS: true });
    try {
      const result = await updateCustomCSS(css);
      // Custom CSS is appended to theme.css server-side, so the same re-fetch
      // shows the saved (and sanitized) result without a reload.
      await loadThemeCss({ bust: true });
      // The server sanitizes site-wide CSS (@import, off-origin url(), '<').
      // Say so rather than letting the removal look like a save that worked.
      const warnings = result?.css_warnings;
      if (warnings?.length) {
        store.set("toast", { message: `Custom CSS saved; removed: ${warnings.join(", ")}.`, type: "warning" });
      } else {
        store.set("toast", { message: "Custom CSS saved.", type: "success" });
      }
      this.setState({ savingCSS: false });
    } catch (err) {
      store.set("toast", { message: err.message || "Failed to save CSS.", type: "error" });
      this.setState({ savingCSS: false });
    }
  }
}
