/**
 * ThemesPage — admin theme management.
 *
 * Lists available themes and allows setting the active one.
 */

import { Component } from "../../components/Component.js";
import { LightSidebar } from "../../components/light/LightSidebar.js";
import { getThemes, getActiveTheme, setActiveTheme } from "../../api/themes.js";
import { logout } from "../../api/auth.js";
import { parseTheme } from "../../utils/themeParser.js";
import { store } from "../../store.js";
import { escapeHtml, navigate } from "../../utils/helpers.js";
import { STAR_SVG, SETTINGS_SVG } from "../../utils/icons.js";
import { setupHeaderCompact } from "../../utils/headerCompact.js";

export default class ThemesPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      themes: [],
      activeTheme: null,
      error: null,
      saving: false,
    };
  }

  render() {
    const { loading, error, themes, activeTheme, saving } = this.state;

    let content = "";
    if (loading) {
      content = `<div class="loading-spinner" aria-label="Loading themes…"></div>`;
    } else if (error) {
      content = `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;
    } else {
      content = `
        <div class="themes-grid">
          ${themes.map((theme) => this._renderThemeCard(theme, activeTheme, saving)).join("")}
        </div>`;
    }

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Themes</h1>
            <div class="header-actions">
               <a href="/light/settings" class="btn btn-secondary" title="Settings">${SETTINGS_SVG}<span class="btn-label">Settings</span></a>
            </div>
          </header>
          <main class="light-content">
            ${content}
          </main>
        </div>
      </div>`;
  }

  _renderThemeCard(theme, activeTheme, saving) {
    const isActive = activeTheme && activeTheme.name === theme.name;
    const cardClass = isActive ? "theme-card active" : "theme-card";

    return `
      <div class="${cardClass}" data-name="${escapeHtml(theme.name)}">
        <div class="theme-card-preview" style="background-color: ${escapeHtml(theme.preview_color || "#eee")}">
          <div class="theme-preview-mock">
            <div class="mock-header"></div>
            <div class="mock-content">
              <div class="mock-line"></div>
              <div class="mock-line short"></div>
              <div class="mock-line"></div>
            </div>
          </div>
          ${isActive ? `<span class="active-badge">${STAR_SVG} Active</span>` : ""}
        </div>
        <div class="theme-card-body">
          <h3 class="theme-name">${escapeHtml(theme.name)}</h3>
          <p class="theme-description">${escapeHtml(theme.description || "No description available.")}</p>
          <div class="theme-modes">
            <span class="theme-mode-badge theme-mode-light" title="Light mode">&#9728;</span>
            ${theme.has_dark_mode ? `<span class="theme-mode-badge theme-mode-dark" title="Dark mode">&#9790;</span>` : ""}
          </div>
          <div class="theme-card-footer">
            ${
              isActive
                ? `<button class="btn btn-sm btn-secondary" disabled>Currently Active</button>`
                : `<button class="btn btn-sm btn-primary activate-theme-btn" data-name="${escapeHtml(theme.name)}" ${saving ? "disabled" : ""}>
                  ${saving ? "Activating…" : "Activate"}
                </button>`
            }
          </div>
        </div>
      </div>`;
  }

  beforeRender() {
    this._cleanupHeaderCompact?.();
    this._cleanupHeaderCompact = null;
  }

  beforeUnmount() {
    this._cleanupHeaderCompact?.();
  }

  afterRender() {
    this._cleanupHeaderCompact = setupHeaderCompact(this.$('.light-header'));
    this.mountChild(LightSidebar, "#sidebar-mount", {
      currentPath: "/light/themes",
      user: store.get("user") || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading || this.state.error) return;

    this.$$(".activate-theme-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this._handleActivate(btn.dataset.name);
      });
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    this.setState({ loading: true, error: null });
    try {
      const [themes, activeTheme] = await Promise.all([
        getThemes(),
        getActiveTheme(),
      ]);
      this.setState({
        loading: false,
        themes: themes || [],
        activeTheme: activeTheme,
      });
    } catch (err) {
      console.error("[ThemesPage] load error:", err);
      store.set("toast", { message: "Could not load themes.", type: "error" });
      this.setState({ loading: false, error: "Failed to load themes." });
    }
  }

  async _handleActivate(name) {
    this.setState({ saving: true });
    try {
      const activeTheme = await setActiveTheme(name);
      store.set("toast", {
        message: `Theme "${name}" activated.`,
        type: "success",
      });

      // Re-parse the theme so the admin UI reflects the new theme immediately
      await parseTheme({ bust: true });

      this.setState({ saving: false, activeTheme });
    } catch (err) {
      console.error("[ThemesPage] activate error:", err);
      store.set("toast", {
        message: err.message || "Failed to activate theme.",
        type: "error",
      });
      this.setState({ saving: false });
    }
  }

  async _handleLogout() {
    try {
      await logout();
    } catch {
      /* ignore */
    }
    store.set("user", null);
    navigate("/", { replace: true });
  }
}
