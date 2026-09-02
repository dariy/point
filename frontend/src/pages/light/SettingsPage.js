/**
 * SettingsPage — admin configuration form.
 *
 * Fetches all settings and renders them in a grouped form. Plugin-specific
 * settings (AI, Instagram, immersive, tags) live in their per-plugin drawer on
 * /light/plugins — this page holds only the general blog/display config.
 * Operator-level knobs (storage quota, session TTL) are env vars, not settings:
 * they are properties of the deployment, not of the blog.
 */

import { Component } from "../../components/Component.js";
import { adminLayoutTemplate, setupAdminLayout } from "../../components/light/AdminLayout.js";
import { listPosts } from "../../api/posts.js";
import { mergeSettings, setToast } from "../../store.js";
import { html, raw } from "../../utils/helpers.js";
import { CHECK_SVG } from "../../utils/icons.js";
import { renderFields, collectUpdates } from "../../components/light/settingsFields.js";

const SETTING_GROUPS = [
  {
    title: "General",
    keys: [
      "blog_title",
      "blog_subtitle",
      "logo_url",
      "author_name",
      "about_post_id",
      "home_page_post_id",
    ],
  },
  {
    title: "Posts",
    keys: [
      "default_post_title_format",
    ],
  },
  {
    title: "Display",
    keys: [
      "posts_per_page",
      "default_theme",
      "show_view_counts",
      "exif_visibility",
    ],
  },
];

export default class SettingsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      saving: false,
      settings: {},
      posts: [],
      error: null,
    };
  }

  render() {
    const { saving } = this.state;

    const actions = html`
        <button type="submit" form="settings-form" class="btn btn-primary" title="Save Settings" ${saving ? "disabled" : ""}>
          ${raw(CHECK_SVG)}<span class="btn-label">${saving ? "Saving…" : "Save Settings"}</span>
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

    if (loading) return html`<div class="loading-spinner" aria-label="Loading…"></div>`;
    if (error) return html`<p class="error-state" role="alert">${error}</p>`;

    return html`
        <form id="settings-form" class="settings-grid">
          ${SETTING_GROUPS.map((group) => this._renderGroup(group, settings, posts))}
        </form>`;
  }

  _renderGroup(group, settings, posts) {
    const { inputs, toggles } = renderFields(group.keys, settings, { posts });
    const toggleSection = toggles
      ? html`<div class="settings-toggles">${toggles}</div>`
      : "";

    let extra = "";

    return html`
      <section class="settings-group" id="group-${group.title.toLowerCase().replace(/\s+/g, "-")}">
        <h2 class="settings-group-title">${group.title}</h2>
        <div class="settings-group-body">
          ${inputs}
          ${toggleSection}
          ${extra}
        </div>
      </section>`;
  }

  afterRender() {
    setupAdminLayout(this, {
      currentPath: "/light/settings",
    });

    if (this.state.loading || this.state.error) return;

    const form = this.$("#settings-form");
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._save();
    });

    this.$(".settings-logo-pick")?.addEventListener("click", () => this._pickLogo());

    // Auto-scroll to group if hash is present
    if (location.hash) {
      const id = location.hash.slice(1);
      setTimeout(() => {
        this.$(`#${id}`)?.scrollIntoView({ behavior: "smooth" });
      }, 100);
    }

  }

  beforeUnmount() {
    this._logoPicker?.destroy();
    this._logoPicker = null;
  }

  async _pickLogo() {
    if (!this._logoPicker) {
      const { MediaPickerDialog } = await import("../../components/light/MediaPickerDialog.js");
      this._logoPicker = new MediaPickerDialog({
        onConfirm: (items) => {
          const path = items[0]?.path;
          if (!path) return;
          const input = /** @type {HTMLInputElement|null} */ (this.$("#logo_url"));
          if (input) input.value = path;
          let preview = /** @type {HTMLImageElement|null} */ (this.$(".settings-logo-preview"));
          if (!preview) {
            preview = document.createElement("img");
            preview.className = "settings-logo-preview";
            preview.alt = "Logo preview";
            input.parentElement.insertBefore(preview, input);
          }
          preview.src = path;
        },
      });
    }
    this._logoPicker.open();
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const { getAllSettings } = await import('../../api/settings.js');
      const [settings, postsResp] = await Promise.all([
        getAllSettings(),
        listPosts({ type: "page", per_page: 500 }),
      ]);
      this.setState({
        loading: false,
        settings,
        posts: postsResp.posts || [],
      });
    } catch (err) {
      console.error("[SettingsPage] load error:", err);
      this.setState({ loading: false, error: "Could not load settings." });
    }
  }

  async _save() {
    const form = /** @type {HTMLFormElement|null} */ (this.$("#settings-form"));
    if (!form) return;

    this.setState({ saving: true });
    const keys = SETTING_GROUPS.flatMap((g) => g.keys);
    const updates = collectUpdates(form, keys);

    try {
      const { updateSettings } = await import('../../api/settings.js');
      await updateSettings(updates);
      setToast({ message: "Settings saved.", type: "success" });
      // Update global store with the new settings immediately so the UI reflects changes (like blog title).
      const { normalizeSettings } = await import('../../utils/helpers.js');
      mergeSettings(normalizeSettings(updates));
      this.setState({ saving: false, settings: { ...this.state.settings, ...updates } });
    } catch (err) {
      console.error("[SettingsPage] save error:", err);
      setToast({
        message: err.message || "Could not save settings.",
        type: "error",
      });
      this.setState({ saving: false });
    }
  }
}
