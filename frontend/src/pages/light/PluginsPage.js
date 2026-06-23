/**
 * PluginsPage — admin plugin management.
 *
 * Lists the full plugin catalog (enabled and disabled) grouped by type and lets
 * the admin toggle each plugin on/off. Toggling persists via PATCH /api/plugins/:id
 * and changes the enabled-only manifest injected on the next page load.
 *
 * This page is the one admin surface that reveals disabled plugins; the public
 * site never sees them (server-side enabled-only manifest + 404'd chunks/routes).
 */

import { Component } from "../../components/Component.js";
import { adminLayoutTemplate, setupAdminLayout } from "../../components/light/AdminLayout.js";
import { getPlugins, setPluginEnabled } from "../../api/plugins.js";
import { store } from "../../store.js";
import { escapeHtml } from "../../utils/helpers.js";

// Group headings keyed by Descriptor.Type, rendered in this order.
const TYPE_GROUPS = [
  { type: "route", title: "Routes & pages", hint: "Plugins that own a route or admin page." },
  { type: "slot", title: "Shell slots", hint: "Plugins that fill a region of the public shell." },
  { type: "enhancer", title: "Content enhancers", hint: "Plugins that augment post content." },
  { type: "service", title: "Backend services", hint: "Server-side capabilities; disabling 404s their API routes." },
];

// Frontend-owned map from plugin id to an existing admin page where the plugin
// is configured. Only entries with a real destination are shown as a "Settings"
// link; the backend stays decoupled from admin routes.
const SETTINGS_PATHS = {
  "tags-atlas": "/light/settings",
  "tags-map": "/light/settings",
  "tags-graph": "/light/settings",
  timeline: "/light/settings",
  "tag-cloud": "/light/settings",
  immersive: "/light/settings",
  "custom-css": "/light/themes",
  "nav-menu": "/light/menu",
  instagram: "/light/settings",
  "ai-analysis": "/light/settings",
  passkeys: "/light/security",
  "api-keys": "/light/security",
  backups: "/light/system",
};

// Display-name overrides for ids that don't humanize cleanly (acronyms etc.).
const PLUGIN_DISPLAY_NAMES = {
  rss: "RSS",
  "ai-analysis": "AI Analysis",
};

function humanize(id) {
  if (PLUGIN_DISPLAY_NAMES[id]) return PLUGIN_DISPLAY_NAMES[id];
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export default class PluginsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      error: null,
      plugins: [],
      pending: {}, // id -> true while a toggle request is in flight
    };
  }

  render() {
    return adminLayoutTemplate({
      title: "Plugins",
      content: this._renderContent(),
    });
  }

  _renderContent() {
    const { loading, error } = this.state;

    if (loading) return `<div class="loading-spinner" aria-label="Loading plugins…"></div>`;
    if (error) return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    return `
      <p class="page-intro">
        Toggle features on or off. Disabled plugins are removed from the public
        site entirely — their code is never served and their routes return 404.
      </p>
      ${TYPE_GROUPS.map((g) => this._renderGroup(g)).join("")}`;
  }

  _renderGroup(group) {
    const items = this.state.plugins.filter((p) => p.type === group.type);
    if (items.length === 0) return "";

    return `
      <section class="plugins-group">
        <div class="plugins-group-header">
          <h2 class="plugins-group-title">${escapeHtml(group.title)}</h2>
          <p class="plugins-group-hint">${escapeHtml(group.hint)}</p>
        </div>
        <div class="plugins-list">
          ${items.map((p) => this._renderPlugin(p)).join("")}
        </div>
      </section>`;
  }

  _renderPlugin(plugin) {
    const pending = !!this.state.pending[plugin.id];
    const meta = [];
    if (plugin.slot) meta.push(`slot: ${escapeHtml(plugin.slot)}`);
    if (Array.isArray(plugin.routes) && plugin.routes.length) {
      meta.push(escapeHtml(plugin.routes.join(", ")));
    }

    const settingsPath = SETTINGS_PATHS[plugin.id];
    const settingsLink = settingsPath
      ? `<a class="plugin-settings-link" href="${escapeHtml(settingsPath)}">Settings</a>`
      : "";

    return `
      <div class="plugin-card${plugin.enabled ? " is-enabled" : ""}" data-id="${escapeHtml(plugin.id)}">
        <div class="plugin-info">
          <span class="plugin-name">${escapeHtml(humanize(plugin.id))}</span>
          ${meta.length ? `<span class="plugin-meta">${meta.join(" · ")}</span>` : ""}
        </div>
        <div class="plugin-actions">
          ${settingsLink}
          <label class="setting-pill plugin-pill">
            <input type="checkbox" class="setting-pill-input plugin-toggle"
              data-id="${escapeHtml(plugin.id)}" ${plugin.enabled ? "checked" : ""} ${pending ? "disabled" : ""}>
            <span class="setting-pill-label">${plugin.enabled ? "Enabled" : "Disabled"}</span>
          </label>
        </div>
      </div>`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: "/light/plugins",
    });

    if (this.state.loading || this.state.error) return;

    this.container.querySelectorAll(".plugin-toggle").forEach((input) => {
      input.addEventListener("change", () => this._handleToggle(input.dataset.id, input.checked));
    });
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
      const plugins = await getPlugins();
      this.setState({
        loading: false,
        plugins: Array.isArray(plugins) ? plugins : [],
        error: null,
      });
    } catch (err) {
      console.error("[PluginsPage] load error:", err);
      this.setState({ loading: false, error: "Could not load plugins." });
    }
  }

  async _handleToggle(id, enabled) {
    this.setState({ pending: { ...this.state.pending, [id]: true } });
    try {
      await setPluginEnabled(id, enabled);
      const plugins = this.state.plugins.map((p) =>
        p.id === id ? { ...p, enabled } : p
      );
      const pending = { ...this.state.pending };
      delete pending[id];
      this.setState({ plugins, pending });
      store.set("toast", {
        message: `${humanize(id)} ${enabled ? "enabled" : "disabled"}. Reload the public site to see the change.`,
        type: "success",
      });
    } catch (err) {
      // Revert the optimistic checkbox state on failure.
      const pending = { ...this.state.pending };
      delete pending[id];
      this.setState({ pending });
      store.set("toast", { message: err.message || "Failed to update plugin.", type: "error" });
    }
  }
}
