/**
 * PluginsPage — admin plugin management.
 *
 * Lists the full plugin catalog (enabled and disabled) grouped by type in
 * collapsible cards and lets the admin toggle each plugin on/off. Toggling
 * persists via PATCH /api/plugins/:id and changes the enabled-only manifest
 * injected on the next page load.
 *
 * Presets (Minimalistic / Standalone / Fully featured) apply a whole set of
 * toggles at once; their membership is editable and persisted server-side.
 *
 * Core areas (e.g. the admin pages, and the immersive viewer pair) must keep at
 * least one enabled plugin: the backend marks the sole survivor `locked` and
 * rejects disabling it; this page renders that toggle read-only.
 *
 * This page is the one admin surface that reveals disabled plugins; the public
 * site never sees them (server-side enabled-only manifest + 404'd chunks/routes).
 */

import { Component } from "../../components/Component.js";
import { adminLayoutTemplate, setupAdminLayout } from "../../components/light/AdminLayout.js";
import { getPlugins, setPluginEnabled, getPresets, updatePreset, applyPreset } from "../../api/plugins.js";
import { getAllSettings } from "../../api/settings.js";
import { getInstagramStatus } from "../../api/instagram.js";
import { PluginSettingsPanel } from "../../components/light/PluginSettingsPanel.js";
import { store } from "../../store.js";
import { escapeHtml } from "../../utils/helpers.js";
import { pluginHost } from "../../core/pluginHost.js";

// Group headings keyed by Descriptor.Type, rendered in this order.
const TYPE_GROUPS = [
  { type: "route", title: "Routes & pages", hint: "Plugins that own a route or admin page." },
  { type: "slot", title: "Shell slots", hint: "Plugins that fill a region of the public shell." },
  { type: "enhancer", title: "Content enhancers", hint: "Plugins that augment post content." },
  { type: "service", title: "Backend services", hint: "Server-side capabilities; disabling 404s their API routes." },
];

// Presets in display order. Ids must match the backend's DefaultPresets keys.
const PRESETS = [
  { id: "minimalistic", title: "Minimalistic", hint: "Just the photo grid and photo page — no header, footer, search or tags." },
  { id: "standalone", title: "Standalone", hint: "Header, footer and browsing; no AI analysis or Instagram." },
  { id: "fully-featured", title: "Fully featured", hint: "Every plugin enabled." },
];
const PRESET_TITLES = Object.fromEntries(PRESETS.map((p) => [p.id, p.title]));

// Frontend-owned map from plugin id to an existing admin page where the plugin
// is configured by a full editor (themes, menu). Only plugins whose settings
// live on a dedicated page appear here; the backend stays decoupled from routes.
const SETTINGS_PAGE_PATHS = {
  "custom-css": "/light/themes",
  "nav-menu": "/light/menu",
};

// Plugins configured inline in a per-plugin drawer (PluginSettingsPanel). Each
// entry may declare `keys` (settings fields extracted from /light/settings,
// saved together) and/or `sections` (rich blocks extracted from /light/system
// and /light/security — see SECTIONS in PluginSettingsPanel). The tag-route trio
// shares the /tags selector.
const PLUGIN_SETTINGS = {
  "ai-analysis": {
    keys: [
      "gemini_model",
      "gemini_api_key",
      "gemini_prompt_title",
      "gemini_prompt_tags",
      "gemini_prompt_excerpt",
    ],
  },
  instagram: {
    keys: ["enable_instagram", "instagram_client_id", "instagram_client_secret"],
    sections: ["instagram-import"],
  },
  immersive: { keys: ["immersive_nav_direction", "show_immersive_excerpt"] },
  "immersive-sheet": { keys: ["immersive_nav_direction", "show_immersive_excerpt"] },
  "tags-atlas": { keys: ["tags_visibility", "min_tag_posts_to_show", "atlas_post_limit"] },
  "tags-map": { keys: ["tags_visibility", "min_tag_posts_to_show"] },
  "tags-graph": { keys: ["tags_visibility", "min_tag_posts_to_show"] },
  "tag-cloud": { keys: ["min_tag_posts_to_show"] },
  "public-footer": { keys: ["footer_copyright"] },
  backups: { sections: ["backups"] },
  passkeys: { sections: ["passkeys"] },
  "api-keys": { sections: ["api-keys"] },
  "offline-sync": { sections: ["offline-data", "sync-queue"] },
  comments: {
    keys: [
      "remark_simple_view",
      "remark_no_footer",
      "remark_auth_anon",
      "remark_auth_email_enable",
      "remark_auth_github_cid",
      "remark_auth_github_csec",
      "remark_auth_google_cid",
      "remark_auth_google_csec",
      "remark_smtp_host",
      "remark_smtp_port",
      "remark_smtp_username",
      "remark_smtp_password",
      "remark_smtp_tls",
      "remark_email_from",
    ],
  },
};

const CHEVRON = `<svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

// Display name: the registry's tuned `title` when set, else title-cased id.
function humanize(id, title) {
  if (title) return title;
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
      presets: {},
      activePreset: "custom",
      editingPreset: null, // preset id while editing membership, else null
      pending: {}, // id -> true while a toggle request is in flight
      collapsed: {}, // type -> true while a group card is collapsed
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
      ${this._renderPresets()}
      ${TYPE_GROUPS.map((g) => this._renderGroup(g)).join("")}`;
  }

  _renderPresets() {
    const { activePreset, editingPreset } = this.state;
    const editing = editingPreset !== null;

    const pills = PRESETS.map((p) => {
      const selected = editing ? p.id === editingPreset : p.id === activePreset;
      return `<button type="button" class="preset-pill${selected ? " is-active" : ""}"
        data-preset="${escapeHtml(p.id)}" title="${escapeHtml(p.hint)}">${escapeHtml(p.title)}</button>`;
    }).join("");

    const status = editing
      ? `Editing <strong>${escapeHtml(PRESET_TITLES[editingPreset] || editingPreset)}</strong> — tick the plugins it should enable.`
      : activePreset && activePreset !== "custom"
        ? `Active preset: <strong>${escapeHtml(PRESET_TITLES[activePreset] || activePreset)}</strong>`
        : `Active preset: <strong>Custom</strong>`;

    return `
      <section class="card plugin-presets-card">
        <div class="card-header plugin-presets-header" data-static>
          <h2>Presets</h2>
          <button type="button" class="btn btn-secondary btn-sm preset-edit-toggle">
            ${editing ? "Done editing" : "Edit presets"}
          </button>
        </div>
        <div class="card-body">
          <div class="preset-pill-group" role="group" aria-label="Plugin presets">${pills}</div>
          <p class="preset-status">${status}</p>
          ${editing ? `<p class="preset-edit-hint">Editing only changes what the preset enables — apply it afterwards to take effect.</p>` : ""}
        </div>
      </section>`;
  }

  _renderGroup(group) {
    const items = this.state.plugins.filter((p) => p.type === group.type);
    if (items.length === 0) return "";
    const collapsed = !!this.state.collapsed[group.type];

    return `
      <section class="card plugins-group${collapsed ? " collapsed" : ""}" data-group="${escapeHtml(group.type)}">
        <div class="card-header plugins-group-header" role="button" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}">
          <div class="plugins-group-heading">
            <h2 class="plugins-group-title">${escapeHtml(group.title)}</h2>
            <p class="plugins-group-hint">${escapeHtml(group.hint)}</p>
          </div>
          ${CHEVRON}
        </div>
        <div class="card-body">
          <div class="plugins-list">
            ${items.map((p) => this._renderPlugin(p)).join("")}
          </div>
        </div>
      </section>`;
  }

  /** Plugins in the same area as `area` (immersive pair, single admin pages, …). */
  _areaSize(area) {
    if (!area) return 0;
    return this.state.plugins.filter((p) => p.area === area).length;
  }

  _renderPlugin(plugin) {
    const pending = !!this.state.pending[plugin.id];
    const editing = this.state.editingPreset !== null;

    const meta = [];
    if (plugin.core) meta.push(`<span class="plugin-badge">Core</span>`);
    if (plugin.slot) meta.push(`<span class="plugin-meta-text">slot: ${escapeHtml(plugin.slot)}</span>`);
    if (Array.isArray(plugin.routes) && plugin.routes.length) {
      meta.push(`<span class="plugin-meta-text">${escapeHtml(plugin.routes.join(", "))}</span>`);
    }

    return `
      <div class="plugin-card${plugin.enabled ? " is-enabled" : ""}" data-id="${escapeHtml(plugin.id)}">
        <div class="plugin-info">
          <span class="plugin-name">${escapeHtml(humanize(plugin.id, plugin.title))}</span>
          ${meta.length ? `<span class="plugin-meta">${meta.join(" · ")}</span>` : ""}
        </div>
        <div class="plugin-actions">
          ${editing ? this._renderInclude(plugin) : this._renderRowControls(plugin, pending)}
        </div>
      </div>`;
  }

  /** Enable/disable controls + settings link (normal, non-editing view). */
  _renderRowControls(plugin, pending) {
    // Settings control only when the plugin is enabled: an inline drawer for
    // plugins whose settings were extracted here, else a link to its admin page.
    let settingsLink = "";
    if (plugin.enabled && PLUGIN_SETTINGS[plugin.id]) {
      settingsLink = `<button type="button" class="plugin-settings-link" data-settings-id="${escapeHtml(plugin.id)}">Settings</button>`;
    } else if (plugin.enabled && SETTINGS_PAGE_PATHS[plugin.id]) {
      settingsLink = `<a class="plugin-settings-link" href="${escapeHtml(SETTINGS_PAGE_PATHS[plugin.id])}">Settings</a>`;
    }

    if (plugin.locked) {
      return `${settingsLink}
        <span class="plugin-pill plugin-pill-locked" title="Required — at least one plugin must stay enabled in this area">
          <span class="plugin-lock" aria-hidden="true">🔒</span>
          <span class="setting-pill-label">Required</span>
        </span>`;
    }

    return `${settingsLink}
      <label class="setting-pill plugin-pill">
        <input type="checkbox" class="setting-pill-input plugin-toggle"
          data-id="${escapeHtml(plugin.id)}" ${plugin.enabled ? "checked" : ""} ${pending ? "disabled" : ""}>
        <span class="setting-pill-label">${plugin.enabled ? "Enabled" : "Disabled"}</span>
      </label>`;
  }

  /** Preset-membership checkbox (edit mode). */
  _renderInclude(plugin) {
    const list = this.state.presets[this.state.editingPreset] || [];
    const included = list.includes(plugin.id);
    // Single-member core areas (admin pages) are always on regardless of preset.
    const forced = plugin.core && this._areaSize(plugin.area) <= 1;

    return `
      <label class="setting-pill plugin-pill plugin-include">
        <input type="checkbox" class="setting-pill-input plugin-include-toggle"
          data-id="${escapeHtml(plugin.id)}" ${included || forced ? "checked" : ""} ${forced ? "disabled" : ""}>
        <span class="setting-pill-label">${forced ? "Always on" : "Include"}</span>
      </label>`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: "/light/plugins",
    });

    if (this.state.loading || this.state.error) return;

    // Collapse/expand group cards (header click, ignoring the presets header).
    this.container.querySelectorAll(".plugins-group-header").forEach((header) => {
      const card = header.closest(".plugins-group");
      const type = card?.dataset.group;
      const toggle = () => {
        const nowCollapsed = card.classList.toggle("collapsed");
        header.setAttribute("aria-expanded", String(!nowCollapsed));
        this.state.collapsed[type] = nowCollapsed; // persist across re-renders, no re-render needed
      };
      header.addEventListener("click", toggle);
      header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    });

    // Preset pills: apply (normal) or select-to-edit (editing).
    this.container.querySelectorAll(".preset-pill").forEach((btn) => {
      btn.addEventListener("click", () => this._handlePresetPill(btn.dataset.preset));
    });
    this.container.querySelector(".preset-edit-toggle")?.addEventListener("click", () => this._toggleEdit());

    // Enable/disable toggles.
    this.container.querySelectorAll(".plugin-toggle").forEach((input) => {
      input.addEventListener("change", () => this._handleToggle(input.dataset.id, input.checked));
    });

    // Per-plugin settings drawer triggers.
    this.container.querySelectorAll("[data-settings-id]").forEach((btn) => {
      btn.addEventListener("click", () => this._openPanel(btn.dataset.settingsId));
    });

    // Preset-membership checkboxes (edit mode).
    this.container.querySelectorAll(".plugin-include-toggle").forEach((input) => {
      input.addEventListener("change", () => this._handleInclude(input.dataset.id, input.checked));
    });
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
    this._closePanel();
  }

  mount() {
    super.mount();
    this._load();
  }

  /**
   * Open the per-plugin settings drawer. Settings are fetched (and cached on the
   * instance) only when the plugin has a settings form; Instagram additionally
   * needs its live connection status for the connect/disconnect block.
   */
  async _openPanel(id) {
    const cfg = PLUGIN_SETTINGS[id];
    if (!cfg) return;
    this._closePanel();
    try {
      let settings = {};
      if (cfg.keys) {
        if (!this._settingsCache) this._settingsCache = await getAllSettings();
        settings = this._settingsCache;
      }
      const igStatus = id === "instagram" ? await getInstagramStatus().catch(() => null) : null;
      const mount = document.createElement("div");
      document.body.appendChild(mount);
      this._panel = new PluginSettingsPanel(mount, {
        pluginId: id,
        title: humanize(id, this.state.plugins.find((p) => p.id === id)?.title),
        keys: cfg.keys || null,
        sections: cfg.sections || null,
        settings,
        igStatus,
        onClose: () => this._closePanel(),
      });
      this._panel.mount();
    } catch (err) {
      console.error("[PluginsPage] open settings error:", err);
      store.set("toast", { message: "Could not load plugin settings.", type: "error" });
    }
  }

  _closePanel() {
    if (!this._panel) return;
    const mount = this._panel.container;
    this._panel.unmount();
    mount?.remove();
    this._panel = null;
    // Settings may have changed; drop the cache so the next open re-fetches.
    this._settingsCache = null;
  }

  async _load() {
    try {
      const [plugins, presetData] = await Promise.all([getPlugins(), getPresets()]);
      this.setState({
        loading: false,
        plugins: Array.isArray(plugins) ? plugins : [],
        presets: (presetData && presetData.presets) || {},
        activePreset: (presetData && presetData.active) || "custom",
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
      const updated = await setPluginEnabled(id, enabled);
      let plugins = this.state.plugins.map((p) => (p.id === id ? { ...p, ...updated } : p));
      // Exclusive area: enabling one member disables its peers server-side; mirror
      // that here so the sibling toggles flip off without a reload.
      if (enabled && updated.exclusive && updated.area) {
        plugins = plugins.map((p) =>
          p.id !== id && p.area === updated.area ? { ...p, enabled: false } : p,
        );
      }
      const pending = { ...this.state.pending };
      delete pending[id];
      // An individual toggle diverges from any preset (backend does the same).
      this.setState({ plugins: this._withLocks(plugins), pending, activePreset: "custom" });
      
      // Mutate pluginHost directly so navigation menus can immediately appear/disappear without a hard refresh.
      if (enabled) {
        pluginHost._byId.set(id, updated);
        if (!pluginHost._manifest.some(e => e.id === id)) pluginHost._manifest.push(updated);
      } else {
        pluginHost._byId.delete(id);
        pluginHost._manifest = pluginHost._manifest.filter(e => e.id !== id);
      }
      store.set('plugin_toggled', Date.now());

      store.set("toast", {
        message: `${humanize(id)} ${enabled ? "enabled" : "disabled"}. Reload the public site to see the change.`,
        type: "success",
      });
    } catch (err) {
      // Revert the optimistic checkbox state on failure (e.g. locked core area).
      const pending = { ...this.state.pending };
      delete pending[id];
      this.setState({ pending });
      store.set("toast", { message: err.message || "Failed to update plugin.", type: "error" });
    }
  }

  /**
   * Recompute the `locked` flag client-side after a toggle so the last enabled
   * plugin in a core area immediately becomes read-only without a reload.
   */
  _withLocks(plugins) {
    return plugins.map((p) => {
      if (!p.core) return p;
      const enabledInArea = plugins.filter((q) => q.area === p.area && q.enabled);
      return { ...p, locked: p.enabled && enabledInArea.length === 1 };
    });
  }

  _handlePresetPill(id) {
    if (!id) return;
    if (this.state.editingPreset !== null) {
      this.setState({ editingPreset: id });
      return;
    }
    this._applyPreset(id);
  }

  _toggleEdit() {
    if (this.state.editingPreset !== null) {
      this.setState({ editingPreset: null });
      return;
    }
    const start = PRESET_TITLES[this.state.activePreset] ? this.state.activePreset : PRESETS[0].id;
    this.setState({ editingPreset: start });
  }

  async _applyPreset(id) {
    try {
      const plugins = await applyPreset(id);
      this.setState({
        plugins: Array.isArray(plugins) ? plugins : this.state.plugins,
        activePreset: id,
      });
      store.set("toast", {
        message: `Applied “${PRESET_TITLES[id] || id}” preset. Reload the public site to see the change.`,
        type: "success",
      });
    } catch (err) {
      store.set("toast", { message: err.message || "Failed to apply preset.", type: "error" });
    }
  }

  async _handleInclude(id, included) {
    const presetId = this.state.editingPreset;
    if (!presetId) return;
    const current = this.state.presets[presetId] || [];
    const next = included ? [...new Set([...current, id])] : current.filter((p) => p !== id);
    try {
      const data = await updatePreset(presetId, next);
      this.setState({ presets: (data && data.presets) || { ...this.state.presets, [presetId]: next } });
    } catch (err) {
      // Revert by re-rendering from unchanged state.
      this.setState({ presets: { ...this.state.presets } });
      store.set("toast", { message: err.message || "Failed to update preset.", type: "error" });
    }
  }
}
