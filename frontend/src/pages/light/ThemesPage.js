/**
 * ThemesPage — admin theme management.
 *
 * Lists available themes and allows setting the active one.
 */

import { Component } from "../../components/Component.js";
import { adminLayoutTemplate, setupAdminLayout } from "../../components/light/AdminLayout.js";
import { getThemes, getActiveTheme, setActiveTheme, getCustomCSS, updateCustomCSS } from "../../api/themes.js";
import { parseTheme } from "../../utils/themeParser.js";
import { store } from "../../store.js";
import { escapeHtml } from "../../utils/helpers.js";
import { STAR_SVG } from "../../utils/icons.js";
import { setupTextareaMaximizer } from "../../utils/textareaMaximizer.js";
import { CssEditor } from "../../components/light/CssEditor.js";

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

    if (loading) return `<div class="loading-spinner" aria-label="Loading themes…"></div>`;
    if (error) return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    return `
        <div class="themes-grid">
          ${themes.map((theme) => this._renderThemeCard(theme, activeTheme, saving)).join("")}
        </div>
        
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
        </section>`;
  }

  _renderThemeCard(theme, activeTheme, saving) {
    const isActive = activeTheme === theme.name;
    const { colors } = parseTheme(theme.css || "");

    const swatch = (color) =>
      `<span class="theme-swatch" style="background-color: ${escapeHtml(color)}"></span>`;

    return `
      <article class="theme-card ${isActive ? "active" : ""}">
        <div class="theme-preview" style="background-color: ${escapeHtml(colors.background || "#fff")}">
          <div class="theme-preview-inner">
            <h3 style="color: ${escapeHtml(colors.primary || "#000")}">Heading</h3>
            <p style="color: ${escapeHtml(colors.text || "#333")}">Sample text content.</p>
          </div>
          <div class="theme-swatches">
            ${colors.primary ? swatch(colors.primary) : ""}
            ${colors.accent ? swatch(colors.accent) : ""}
            ${colors.background ? swatch(colors.background) : ""}
          </div>
        </div>
        <div class="theme-info">
          <div class="theme-name">${escapeHtml(theme.name)}</div>
          <button class="btn btn-sm ${isActive ? "btn-secondary" : "btn-primary"} set-active-btn" 
                  data-name="${escapeHtml(theme.name)}" ${isActive || saving ? "disabled" : ""}>
            ${isActive ? STAR_SVG + " Active" : "Set Active"}
          </button>
        </div>
      </article>`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: "/light/themes",
    });

    setupTextareaMaximizer(this.container);

    if (this.state.loading || this.state.error) return;

    this.container.querySelectorAll(".set-active-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._handleSetActive(btn.dataset.name));
    });

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

  beforeUnmount() {
    this._cleanupAdminLayout?.();
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const [themes, activeTheme, customCSS] = await Promise.all([
        getThemes(),
        getActiveTheme(),
        getCustomCSS(),
      ]);
      this.setState({
        loading: false,
        themes: themes.themes || [],
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
      await updateCustomCSS(css);
      store.set("toast", { message: "Custom CSS saved.", type: "success" });
      this.setState({ savingCSS: false });
    } catch (err) {
      store.set("toast", { message: err.message || "Failed to save CSS.", type: "error" });
      this.setState({ savingCSS: false });
    }
  }
}
