/**
 * SettingsPage — admin configuration form.
 *
 * Fetches all settings and renders them in a grouped form.
 */

import { Component } from "../../components/Component.js";
import { LightSidebar } from "../../components/light/LightSidebar.js";
import { getAllSettings, updateSettings } from "../../api/settings.js";
import { listPosts } from "../../api/posts.js";
import { logout } from "../../api/auth.js";
import { store } from "../../store.js";
import {
  escapeHtml,
  navigate,
  normalizeSettings,
} from "../../utils/helpers.js";
import { CHECK_SVG } from "../../utils/icons.js";
import { setupHeaderCompact } from "../../utils/headerCompact.js";

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
    keys: ["storage_quota_mb", "enable_backup", "backup_interval_hours"],
  },
  {
    title: "Advanced",
    keys: [
      "max_upload_size_mb",
      "thumbnail_width",
      "thumbnail_height",
      "jpeg_quality",
    ],
  },
  {
    title: "AI (Gemini)",
    keys: [
      "gemini_api_key",
      "gemini_prompt_title",
      "gemini_prompt_tags",
      "gemini_prompt_excerpt",
    ],
  },
];

const NUMERIC_KEYS = new Set([
  "max_upload_size_mb",
  "thumbnail_width",
  "thumbnail_height",
  "jpeg_quality",
]);

const SETTING_HELP = {
  // General
  blog_title: "The name of your blog, shown in the browser tab and header.",
  blog_subtitle: "A short tagline shown below the blog title.",
  author_name: "Default author name displayed on posts.",
  about_post_id: "A page post linked from 'About' in navigation. Only page-type posts appear here.",
  home_page_post_id: "Show this page post instead of the default post list on the homepage. Leave blank to use the standard feed.",
  // Display — inputs/selects
  posts_per_page: "Number of posts shown per page on the homepage and tag archive pages.",
  min_tag_posts_to_show: "Tags with fewer posts than this number are hidden from public visitors. Set to 0 to show all tags.",
  default_theme: "The colour theme applied to the public-facing site.",
  immersive_nav_direction: "Direction of the left/right navigation arrows in immersive (full-screen) post mode.",
  exif_visibility: "Who can see photo EXIF metadata (camera model, exposure settings, etc.).",
  map_mode: "Controls who can access the /map page. 'Hidden' means admins only.",
  timeline_mode: "Controls who can access the /timeline page. 'Hidden' means admins only.",
  // Display — toggles
  show_view_counts: "Show the number of views on each post, visible to all visitors.",
  use_thumbnails: "Display auto-generated thumbnail images in the post list on the homepage and tag pages.",
  show_tag_cloud: "Show a tag cloud widget listing the most-used tags (respects the min-posts threshold above).",
  show_immersive_excerpt: "Show a short excerpt overlaid on the hero image in immersive (full-screen) post mode.",
  // Storage & System
  storage_quota_mb: "Maximum allowed storage in MB. Set to 0 for no limit.",
  enable_backup: "Enable scheduled automatic database backups.",
  backup_interval_hours: "How often to create automatic backups, in hours.",
  // Advanced
  thumbnail_width: "Width in pixels for auto-generated post thumbnails.",
  thumbnail_height: "Height in pixels for auto-generated post thumbnails.",
  jpeg_quality: "JPEG compression quality for thumbnails (1–100). Higher = better quality, larger files.",
  // AI
  gemini_api_key: "Your Google Gemini API key for AI-assisted title, tag, and excerpt generation on image uploads.",
  gemini_prompt_title: "Customize the prompt sent to Gemini to generate post metadata from uploaded images.",
};

export default class SettingsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      settings: {},
      posts: [],
      saving: false,
      error: null,
    };
  }

  render() {
    const { loading, error, settings, posts, saving } = this.state;

    let content = "";
    if (loading) {
      content = `<div class="loading-spinner" aria-label="Loading settings…"></div>`;
    } else if (error) {
      content = `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;
    } else {
      content = `
        <form id="settings-form" class="settings-grid">
          ${SETTING_GROUPS.map((group) => this._renderGroup(group, settings, posts)).join("")}
        </form>`;
    }

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Settings</h1>
            <div class="header-actions">
              <button type="submit" form="settings-form" class="btn btn-primary" title="Save Settings" ${saving ? "disabled" : ""}>
                ${CHECK_SVG}<span class="btn-label">${saving ? "Saving…" : "Save Settings"}</span>
              </button>
            </div>
          </header>
          <main class="light-content">
            ${content}
          </main>
        </div>
      </div>`;
  }

  _renderGroup(group, settings, posts) {
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
        input = `<input type="number" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}" min="0">`;
      } else if (
        key.includes("enable") ||
        key.includes("show") ||
        key.includes("use")
      ) {
        const checked =
          value === "true" || value === true || value === 1 || value === "1";
        toggles.push({ key, label, checked });
        isToggle = true;
      } else if (key === "gemini_api_key") {
        const isConfigured =
          settings["gemini_api_key_is_set"] === "true" ||
          settings["gemini_api_key_is_set"] === true;
        const placeholder = isConfigured
          ? "******** (Configured)"
          : "Enter Gemini API Key";
        input = `<input type="password" name="${key}" id="${key}" class="form-input" placeholder="${placeholder}" value="">`;
      } else if (key === "gemini_prompt_title") {
        const tv = escapeHtml(settings["gemini_prompt_title"] ?? "");
        const kv = escapeHtml(settings["gemini_prompt_tags"] ?? "");
        const ev = escapeHtml(settings["gemini_prompt_excerpt"] ?? "");
        input = `<div class="prompt-template">
          <div class="prompt-line prompt-line-fixed">Analyze this image and return a JSON object.</div>
          <div class="prompt-line">
            <span class="prompt-key">"title" <span class="prompt-type">(string)</span>:</span>
            <input type="text" name="gemini_prompt_title" class="form-input prompt-part" value="${tv}" placeholder="a concise, descriptive title" maxlength="200">
          </div>
          <div class="prompt-line">
            <span class="prompt-key">"tags" <span class="prompt-type">(array of strings)</span>:</span>
            <input type="text" name="gemini_prompt_tags" class="form-input prompt-part" value="${kv}" placeholder="relevant keyword tags" maxlength="200">
          </div>
          <div class="prompt-line">
            <span class="prompt-key">"excerpt" <span class="prompt-type">(string)</span>:</span>
            <input type="text" name="gemini_prompt_excerpt" class="form-input prompt-part" value="${ev}" placeholder="a 1-2 sentence description" maxlength="200">
          </div>
          <div class="prompt-line prompt-line-fixed">Return only valid JSON, no markdown or extra text.</div>
        </div>`;
      } else {
        input = `<input type="text" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}">`;
      }

      if (!isToggle) {
        const isPromptComposite = key === "gemini_prompt_title";
        const fieldClass = isPromptComposite
          ? "settings-field settings-field-top"
          : "settings-field";
        const displayLabel = isPromptComposite ? "Analysis Prompt" : label;
        const helpText = SETTING_HELP[key];
        const helpTip = helpText
          ? `<span class="settings-help-tip"><span class="settings-help-icon" tabindex="0" aria-label="Help">?</span><span class="settings-help-tooltip">${escapeHtml(helpText)}</span></span>`
          : "";
        inputs.push(`
          <div class="${fieldClass}">
            <div class="settings-field-label-row">
              <label class="settings-field-label"${isPromptComposite ? "" : ` for="${key}"`}>${escapeHtml(displayLabel)}</label>
              ${helpTip}
            </div>
            ${input}
          </div>`);
      }
    }

    const inputsHtml = inputs.join("");

    let groupHeaderExtra = "";
    if (group.title === "Display") {
      groupHeaderExtra = `<a href="/light/themes" class="card-header-link">Manage Themes ↗</a>`;
    }

    const togglesHtml = toggles.length
      ? `
      <div class="setting-pill-group${inputs.length ? " setting-pill-group-divided" : ""}">
        ${toggles
          .map(
            ({ key, label, checked }) => {
              const help = SETTING_HELP[key];
              const helpTip = help
                ? `<span class="settings-help-tip"><span class="settings-help-icon" tabindex="0" aria-label="Help">?</span><span class="settings-help-tooltip">${escapeHtml(help)}</span></span>`
                : "";
              return `
          <div class="setting-pill-item">
            <label class="setting-pill">
              <input type="checkbox" name="${key}" class="setting-pill-input" ${checked ? "checked" : ""}>
              <span class="setting-pill-label">${escapeHtml(label)}</span>
            </label>${helpTip}
          </div>`;
            }
          )
          .join("")}
      </div>`
      : "";

    const wideGroup = group.keys.includes("gemini_prompt_title");
    return `
      <div class="card${wideGroup ? " card-full-width" : ""}">
        <div class="card-header">
          <h2>${escapeHtml(group.title)}</h2>
          ${groupHeaderExtra}
        </div>
        <div class="card-body">
          ${inputsHtml}${togglesHtml}
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
      currentPath: "/light/settings",
      user: store.get("user") || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading || this.state.error) return;

    this.$("#settings-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._handleSave();
    });

    this._wirePostSelectPreview("about_post_id");
    this._wirePostSelectPreview("home_page_post_id");
  }

  _wirePostSelectPreview(name) {
    const select = this.$(`select[name="${name}"]`);
    if (select) {
      select.addEventListener("change", () => {
        const slug = select.value;
        const wrapper = select.closest(".settings-input-with-preview");
        let link = wrapper?.querySelector(".settings-preview-link");
        if (slug) {
          if (link) {
            link.href = `/posts/${slug}`;
          } else {
            const a = document.createElement("a");
            a.href = `/posts/${slug}`;
            a.target = "_blank";
            a.className = "settings-preview-link";
            a.textContent = "Preview ↗";
            wrapper.appendChild(a);
          }
        } else if (link) {
          link.remove();
        }
      });
    }
  }

  mount() {
    super.mount();
    // Delegated listener on the container so it survives re-renders.
    this.container.addEventListener("change", (e) => {
      if (e.target.classList.contains("setting-pill-input")) {
        this._handleCheckboxChange(e.target.name, e.target.checked);
      }
    });
    this._load();
  }

  async _load() {
    this.setState({ loading: true, error: null });
    try {
      const [settings, postsResult] = await Promise.all([
        getAllSettings(),
        listPosts({ per_page: 500 }),
      ]);
      this.setState({
        loading: false,
        settings: normalizeSettings(settings),
        posts: postsResult.posts || [],
      });
    } catch (err) {
      console.error("[SettingsPage] load error:", err);
      store.set("toast", {
        message: "Could not load settings.",
        type: "error",
      });
      this.setState({ loading: false });
    }
  }

  async _handleCheckboxChange(key, checked) {
    try {
      const updated = normalizeSettings(
        await updateSettings({ [key]: String(checked) }),
      );
      const merged = { ...this.state.settings, ...updated };
      this.setState({ settings: merged });
      store.set("settings", merged);
    } catch (err) {
      store.set("toast", {
        message: err.message || "Update failed.",
        type: "error",
      });
    }
  }

  async _handleSave() {
    const form = this.$("#settings-form");
    if (!form) return;

    const formData = new FormData(form);
    const data = {};

    SETTING_GROUPS.forEach((g) => {
      g.keys.forEach((k) => {
        const type = this._getSettingType(k);
        if (type === "boolean") return; // saved on checkbox change
        const val = formData.get(k);
        if (k === "gemini_api_key") {
          if (val) data[k] = val;
          return;
        }
        if (type === "number") {
          data[k] = String(val ? parseInt(val, 10) : 0);
        } else {
          data[k] = val || "";
        }
      });
    });

    this.setState({ saving: true });
    try {
      const updated = normalizeSettings(await updateSettings(data));
      const merged = { ...this.state.settings, ...updated };
      store.set("toast", { message: "Settings updated.", type: "success" });
      this.setState({ saving: false, settings: merged });
      store.set("settings", merged);

      // Update document title if blog_title changed
      if (data.blog_title) {
        document.title = data.blog_title;
      }
    } catch (err) {
      this.setState({ saving: false });
      store.set("toast", {
        message: err.message || "Update failed.",
        type: "error",
      });
    }
  }

  _getSettingType(key) {
    if (
      NUMERIC_KEYS.has(key) ||
      key.includes("per_page") ||
      key.includes("quota") ||
      key.includes("interval") ||
      key.includes("posts_to_show")
    )
      return "number";
    if (key === "map_mode" || key === "timeline_mode") return "string";
    if (key.includes("enable") || key.includes("show") || key.includes("use"))
      return "boolean";
    return "string";
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
