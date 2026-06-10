/**
 * SettingsPage — admin configuration form.
 *
 * Fetches all settings and renders them in a grouped form.
 */

import { Component } from "../../components/Component.js";
import { adminLayoutTemplate, setupAdminLayout } from "../../components/light/AdminLayout.js";
import { getAllSettings, updateSettings } from "../../api/settings.js";
import { listPosts } from "../../api/posts.js";
import { getInstagramStatus, disconnectInstagram } from "../../api/instagram.js";
import { store } from "../../store.js";
import {
  escapeHtml,
  normalizeSettings,
} from "../../utils/helpers.js";
import { CHECK_SVG } from "../../utils/icons.js";

const SETTING_GROUPS = [
  {
    title: "General",
    keys: [
      "blog_title",
      "blog_subtitle",
      "author_name",
      "about_post_id",
      "home_page_post_id",
    ],
  },
  {
    title: "Display",
    keys: [
      "posts_per_page",
      "min_tag_posts_to_show",
      "default_theme",
      "immersive_nav_direction",
      "show_view_counts",
      "use_thumbnails",
      "show_tag_cloud",
      "show_immersive_excerpt",
      "exif_visibility",
      "map_mode",
      "timeline_mode",
    ],
  },
  {
    title: "Storage & System",
    keys: [
      "storage_quota_mb",
      "session_ttl_days",
      "cleanup_interval_days",
      "multi_user_mode",
      "require_registration_code",
    ],
  },
  {
    title: "AI Integration",
    keys: ["enable_gemini", "gemini_model", "gemini_api_key"],
  },
  {
    title: "Instagram",
    keys: ["enable_instagram", "instagram_client_id", "instagram_client_secret"],
  },
];

const NUMERIC_KEYS = new Set([
  "posts_per_page",
  "min_tag_posts_to_show",
  "storage_quota_mb",
  "session_ttl_days",
  "cleanup_interval_days",
]);

export default class SettingsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      saving: false,
      settings: {},
      posts: [],
      error: null,
      igStatus: null,
    };
  }

  render() {
    const { saving } = this.state;

    const actions = `
        <button type="submit" form="settings-form" class="btn btn-primary" title="Save Settings" ${saving ? "disabled" : ""}>
          ${CHECK_SVG}<span class="btn-label">${saving ? "Saving…" : "Save Settings"}</span>
        </button>
    `;

    return adminLayoutTemplate({
      title: "Settings",
      actions,
      content: this._renderContent()
    });
  }

  _renderContent() {
    const { loading, settings, posts, error } = this.state;

    if (loading) return `<div class="loading-spinner" aria-label="Loading…"></div>`;
    if (error) return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    return `
        <form id="settings-form" class="settings-grid">
          ${SETTING_GROUPS.map((group) => this._renderGroup(group, settings, posts)).join("")}
        </form>`;
  }

  _renderGroup(group, settings, posts) {
    if (group.title === "Instagram") {
      return this._renderInstagramGroup(group, settings);
    }

    const inputs = [];
    const toggles = [];

    for (const key of group.keys) {
      if (key === "gemini_prompt_tags" || key === "gemini_prompt_excerpt")
        continue;
      const value = settings[key] ?? "";
      const label = key
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

      let input = "";
      let isToggle = false;

      if (key === "about_post_id" || key === "home_page_post_id") {
        const options = posts
          .filter((p) => p.type === "page")
          .map((p) => {
            const slug = escapeHtml(p.slug);
            const title = escapeHtml(p.title || p.slug);
            const selected = p.slug === value ? " selected" : "";
            return `<option value="${slug}"${selected}>${title}</option>`;
          })
          .join("");
        const previewLink = value
          ? `<a href="/posts/${escapeHtml(String(value))}" target="_blank" class="settings-preview-link">Preview ↗</a>`
          : "";
        input = `<div class="settings-input-with-preview">
          <select name="${key}" id="${key}" class="form-select">
            <option value="">— None —</option>
            ${options}
          </select>
          ${previewLink}
        </div>`;
      } else if (key === "default_theme") {
        input = `
          <select name="${key}" id="${key}" class="form-select">
            <option value="light"${value === "light" ? " selected" : ""}>Light</option>
            <option value="dark"${value === "dark" ? " selected" : ""}>Dark</option>
            <option value="auto"${value === "auto" ? " selected" : ""}>Auto (System)</option>
          </select>`;
      } else if (key === "immersive_nav_direction") {
        const isFeed = value === "feed";
        input = `
          <select name="${key}" id="${key}" class="form-select">
            <option value="chronological"${!isFeed ? " selected" : ""}>Chronological (◁ older, ▷ newer)</option>
            <option value="feed"${isFeed ? " selected" : ""}>Feed order (◁ newer, ▷ older)</option>
          </select>`;
      } else if (key === "exif_visibility") {
        const v = value || "hide";
        input = `
          <select name="${key}" id="${key}" class="form-select">
            <option value="hide"${v === "hide" ? " selected" : ""}>Hide</option>
            <option value="admin"${v === "admin" ? " selected" : ""}>Admins only</option>
            <option value="all"${v === "all" ? " selected" : ""}>Everyone</option>
          </select>`;
      } else if (key === "map_mode" || key === "timeline_mode") {
        const v = value || "off";
        input = `
          <select name="${key}" id="${key}" class="form-select">
            <option value="off"${v === "off" ? " selected" : ""}>Off</option>
            <option value="hidden"${v === "hidden" ? " selected" : ""}>Hidden (Admins only)</option>
            <option value="all"${v === "all" ? " selected" : ""}>All (Everyone)</option>
          </select>`;
      } else if (
        NUMERIC_KEYS.has(key) ||
        key.includes("per_page") ||
        key.includes("quota") ||
        key.includes("interval") ||
        key.includes("posts_to_show")
      ) {
        input = `<input type="number" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}">`;
      } else if (
        key.includes("enable") ||
        key.includes("show") ||
        key.includes("use") ||
        key === "multi_user_mode" ||
        key === "require_registration_code"
      ) {
        isToggle = true;
        const checked =
          value === "true" || value === "1" || value === true || value === 1;
        input = `
          <label class="setting-pill">
            <input type="checkbox" name="${key}" id="${key}" class="setting-pill-input" ${checked ? "checked" : ""}>
            <span class="setting-pill-label">${label}</span>
          </label>`;
      } else if (key === "gemini_api_key" || key === "instagram_client_secret") {
        input = `<input type="password" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}" autocomplete="new-password">`;
      } else {
        input = `<input type="text" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}">`;
      }

      if (isToggle) {
        toggles.push(input);
      } else {
        inputs.push(`
          <div class="form-group">
            <label class="form-label" for="${key}">${label}</label>
            ${input}
          </div>`);
      }
    }

    const toggleSection = toggles.length
      ? `<div class="settings-toggles">${toggles.join("")}</div>`
      : "";

    return `
      <section class="settings-group" id="group-${group.title.toLowerCase().replace(/\s+/g, "-")}">
        <h2 class="settings-group-title">${group.title}</h2>
        <div class="settings-group-body">
          ${inputs.join("")}
          ${toggleSection}
        </div>
      </section>`;
  }

  _renderInstagramGroup(group, settings) {
    const { igStatus } = this.state;
    const isEnabled =
      settings.enable_instagram === "true" || settings.enable_instagram === "1" || settings.enable_instagram === true || settings.enable_instagram === 1;

    const fields = group.keys
      .map((key) => {
        const value = settings[key] ?? "";
        const label = key
          .split("_")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");

        if (key === "enable_instagram") {
          return `
          <label class="setting-pill">
            <input type="checkbox" name="${key}" id="${key}" class="setting-pill-input" ${isEnabled ? "checked" : ""}>
            <span class="setting-pill-label">${label}</span>
          </label>`;
        }
        return `
        <div class="form-group">
          <label class="form-label" for="${key}">${label}</label>
          <input type="${key.includes("secret") ? "password" : "text"}" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}">
        </div>`;
      })
      .join("");

    let connectionSection = "";
    if (isEnabled && igStatus) {
      if (igStatus.connected) {
        connectionSection = `
          <div class="ig-connection-status connected">
            <p>Connected as <strong>@${escapeHtml(igStatus.username)}</strong></p>
            <button type="button" class="btn btn-sm btn-danger" id="ig-disconnect-btn">Disconnect Instagram</button>
          </div>`;
      } else {
        const authUrl = `/api/instagram/auth?state=${encodeURIComponent(location.origin + "/light/settings")}`;
        connectionSection = `
          <div class="ig-connection-status disconnected">
            <p>Instagram is enabled but not connected.</p>
            <a href="${authUrl}" class="btn btn-sm btn-primary">Connect Instagram</a>
          </div>`;
      }
    }

    return `
      <section class="settings-group" id="instagram">
        <h2 class="settings-group-title">Instagram</h2>
        <div class="settings-group-body">
          ${fields}
          ${connectionSection}
        </div>
      </section>`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: "/light/settings",
    });

    if (this.state.loading || this.state.error) return;

    const form = this.container.querySelector("#settings-form");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._save();
    });

    this.container.querySelector("#ig-disconnect-btn")?.addEventListener("click", async () => {
      if (confirm("Disconnect Instagram? You will need to re-authenticate to post to Instagram.")) {
        try {
          const { disconnectInstagram } = await import('../../api/instagram.js');
          await disconnectInstagram();
          this._load(); // Refresh settings and status
        } catch (err) {
          store.set("toast", {
            message: err.message || "Failed to disconnect.",
            type: "error",
          });
        }
      }
    });

    // Auto-scroll to group if hash is present
    if (location.hash) {
      const id = location.hash.slice(1);
      setTimeout(() => {
        this.container.querySelector(`#${id}`)?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    }
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
      const { getAllSettings } = await import('../../api/settings.js');
      const [settings, postsResp, igStatus] = await Promise.all([
        getAllSettings(),
        listPosts({ type: "page", per_page: 500 }),
        getInstagramStatus().catch(() => null),
      ]);
      this.setState({
        loading: false,
        settings,
        posts: postsResp.posts || [],
        igStatus,
      });
    } catch (err) {
      console.error("[SettingsPage] load error:", err);
      this.setState({ loading: false, error: "Could not load settings." });
    }
  }

  async _save() {
    const form = this.container.querySelector("#settings-form");
    if (!form) return;

    this.setState({ saving: true });
    const fd = new FormData(form);
    const updates = {};

    // Standard FormData doesn't include unchecked checkboxes.
    // We must manually add all checkbox keys from our schema.
    for (const group of SETTING_GROUPS) {
      for (const key of group.keys) {
        if (
          key.includes("enable") ||
          key.includes("show") ||
          key.includes("use") ||
          key === "multi_user_mode" ||
          key === "require_registration_code"
        ) {
          updates[key] = fd.has(key) ? "true" : "false";
        } else if (fd.has(key)) {
          updates[key] = fd.get(key);
        }
      }
    }

    try {
      const { updateSettings } = await import('../../api/settings.js');
      await updateSettings(updates);
      store.set("toast", { message: "Settings saved.", type: "success" });
      // Update global store with the new settings immediately so the UI reflects changes (like blog title).
      const currentSettings = store.get("settings") || {};
      const { normalizeSettings } = await import('../../utils/helpers.js');
      store.set("settings", { ...currentSettings, ...normalizeSettings(updates) });
      this.setState({ saving: false, settings: updates });
    } catch (err) {
      console.error("[SettingsPage] save error:", err);
      store.set("toast", {
        message: err.message || "Could not save settings.",
        type: "error",
      });
      this.setState({ saving: false });
    }
  }
}
