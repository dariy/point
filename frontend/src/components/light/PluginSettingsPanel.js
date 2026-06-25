/**
 * PluginSettingsPanel — a right slide-in drawer holding one plugin's settings.
 *
 * Opened from a plugin card on the Plugins page (PluginsPage._openPanel). A
 * plugin's drawer is composed of two optional parts:
 *   - a settings form rendered from its `keys` (via the shared settingsFields
 *     renderer), saved together through PUT /api/settings with a Save button;
 *   - one or more rich `sections` — self-contained Components (backups, the
 *     Instagram importer, passkeys, API keys) that manage their own state and
 *     actions, mounted into the drawer body.
 *
 * Mounted into a throwaway node appended to <body>; `onClose` is responsible for
 * unmounting this component and removing that node.
 *
 * Props:
 *   pluginId  {string}     Plugin id (drives the Instagram connection block)
 *   title     {string}     Heading shown in the drawer header
 *   keys      {string[]?}  Setting keys to render and collect (optional)
 *   sections  {string[]?}  Section keys to mount (optional; see SECTIONS)
 *   settings  {object}     Current settings map (for `keys`)
 *   igStatus  {object?}    Instagram connection status (instagram only)
 *   onClose   {Function}   Tear-down callback
 */

import { Component } from "../Component.js";
import { GestureController } from "../../core/gestures.js";
import { renderFields, collectUpdates } from "./settingsFields.js";
import { updateSettings } from "../../api/settings.js";
import { store } from "../../store.js";
import { escapeHtml } from "../../utils/helpers.js";
import { CHECK_SVG, X_SVG } from "../../utils/icons.js";
import { BackupsSection } from "./sections/BackupsSection.js";
import { InstagramImportSection } from "./sections/InstagramImportSection.js";
import { PasskeysSection } from "./sections/PasskeysSection.js";
import { ApiKeysSection } from "./sections/ApiKeysSection.js";
import { OfflineDataSection } from "./sections/OfflineDataSection.js";
import { SyncQueueSection } from "./sections/SyncQueueSection.js";

// Section key → component class. Referenced by PLUGIN_SETTINGS in PluginsPage.
const SECTIONS = {
  backups: BackupsSection,
  "instagram-import": InstagramImportSection,
  passkeys: PasskeysSection,
  "api-keys": ApiKeysSection,
  "offline-data": OfflineDataSection,
  "sync-queue": SyncQueueSection,
};

export class PluginSettingsPanel extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { saving: false };
  }

  get _hasForm() {
    return Array.isArray(this.props.keys) && this.props.keys.length > 0;
  }

  render() {
    const { title, sections, settings, pluginId } = this.props;
    const { saving } = this.state;

    let formHtml = "";
    if (this._hasForm) {
      const { inputs, toggles } = renderFields(this.props.keys, settings, {});
      const toggleSection = toggles ? `<div class="settings-toggles">${toggles}</div>` : "";
      const connection = pluginId === "instagram" ? this._renderInstagramConnection() : "";
      formHtml = `
        <form id="plugin-settings-form" class="plugin-settings-form">
          ${inputs}
          ${toggleSection}
          ${connection}
        </form>`;
    }

    const sectionsHtml =
      Array.isArray(sections) && sections.length
        ? `<div class="plugin-settings-sections">${sections
            .map((_, i) => `<div class="plugin-section-mount" data-section-index="${i}"></div>`)
            .join("")}</div>`
        : "";

    const saveBtn = this._hasForm
      ? `<button type="submit" form="plugin-settings-form" class="btn btn-primary" ${saving ? "disabled" : ""}>
           ${CHECK_SVG}<span class="btn-label">${saving ? "Saving…" : "Save"}</span>
         </button>`
      : "";

    return `
      <div class="plugin-settings-overlay" data-close></div>
      <aside class="plugin-settings-drawer" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)} settings">
        <header class="plugin-settings-header">
          <h2 class="plugin-settings-title">${escapeHtml(title)}</h2>
          <button type="button" class="plugin-settings-close" data-close aria-label="Close">${X_SVG}</button>
        </header>
        <div class="plugin-settings-body">
          ${formHtml}
          ${sectionsHtml}
        </div>
        <footer class="plugin-settings-footer">
          <button type="button" class="btn btn-secondary" data-close>${this._hasForm ? "Cancel" : "Close"}</button>
          ${saveBtn}
        </footer>
      </aside>`;
  }

  /** Connect/disconnect block for the Instagram plugin (ported from SettingsPage). */
  _renderInstagramConnection() {
    const { settings, igStatus } = this.props;
    const isEnabled =
      settings.enable_instagram === "true" ||
      settings.enable_instagram === "1" ||
      settings.enable_instagram === true ||
      settings.enable_instagram === 1;
    if (!isEnabled || !igStatus) return "";

    if (igStatus.connected) {
      return `
        <div class="ig-connection-status connected">
          <p>Connected as <strong>@${escapeHtml(igStatus.username)}</strong></p>
          <button type="button" class="btn btn-sm btn-danger" id="ig-disconnect-btn">Disconnect Instagram</button>
        </div>`;
    }
    const authUrl = `/api/instagram/auth?state=${encodeURIComponent(location.origin + "/light/plugins")}`;
    return `
      <div class="ig-connection-status disconnected">
        <p>Instagram is enabled but not connected.</p>
        <a href="${authUrl}" class="btn btn-sm btn-primary">Connect Instagram</a>
      </div>`;
  }

  afterRender() {
    // Lock the page behind the drawer so swiping the panel doesn't scroll it.
    this._prevBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Slide in on the next frame so the CSS transition runs from off-screen.
    requestAnimationFrame(() => this.$(".plugin-settings-drawer")?.classList.add("is-open"));

    this.$$("[data-close]").forEach((el) =>
      el.addEventListener("click", () => this._close()),
    );

    this._onKeydown = (e) => {
      if (e.key === "Escape") this._close();
    };
    document.addEventListener("keydown", this._onKeydown);

    this.$("#plugin-settings-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      this._save();
    });

    this.$("#ig-disconnect-btn")?.addEventListener("click", () => this._disconnectInstagram());

    // Mount rich section components (as children so they're torn down with us).
    (this.props.sections || []).forEach((key, i) => {
      const Cls = SECTIONS[key];
      const mountEl = this.$(`.plugin-section-mount[data-section-index="${i}"]`);
      if (Cls && mountEl) this.mountChild(Cls, mountEl, {});
    });

    this._bindSwipeToClose();
  }

  /**
   * Drag the drawer rightward with a finger to dismiss it. Built on the shared
   * GestureController, which axis-locks the touch — vertical drags stay as native
   * scrolling inside the body and only a dominant rightward swipe moves the drawer.
   * A drag past 35% of the drawer width commits to a close; anything shorter snaps
   * back via the CSS transition.
   */
  _bindSwipeToClose() {
    const drawer = this.$(".plugin-settings-drawer");
    if (!drawer) return;

    let dx = 0;
    const reset = () => {
      drawer.style.transition = "";
      drawer.style.transform = "";
    };

    this._gestures = new GestureController(drawer, {
      // Swipe-to-reveal rows (e.g. the backups list) own their horizontal drag;
      // a swipe starting on one must not also close the drawer. Empty space still
      // closes it.
      ignoreSelector: ".backup-swipe-item",
      onSwipeMove: (mx, my) => {
        // Ignore vertical drags (the controller still reports them here).
        if (Math.abs(my) > Math.abs(mx)) return;
        dx = Math.max(0, mx); // rightward only; the drawer can't open further left
        drawer.style.transition = "none";
        drawer.style.transform = `translateX(${dx}px)`;
      },
      onSwipeCommit: (dir) => {
        if (dir === "right" && dx > drawer.offsetWidth * 0.35) {
          reset(); // restore the transition so _close animates out from here
          this._close();
        } else {
          reset();
        }
        dx = 0;
      },
      onSwipeCancel: () => {
        reset();
        dx = 0;
      },
    });
  }

  beforeUnmount() {
    if (this._onKeydown) document.removeEventListener("keydown", this._onKeydown);
    document.body.style.overflow = this._prevBodyOverflow ?? "";
    this._gestures?.destroy();
  }

  /** Animate the drawer out, then hand control back to the opener to tear down. */
  _close() {
    if (this._closing) return;
    this._closing = true;
    const drawer = this.$(".plugin-settings-drawer");
    const done = () => this.props.onClose?.();
    if (!drawer) return done();
    drawer.classList.remove("is-open");
    let called = false;
    const once = () => {
      if (called) return;
      called = true;
      done();
    };
    drawer.addEventListener("transitionend", once, { once: true });
    setTimeout(once, 300); // fallback if transitionend doesn't fire
  }

  async _save() {
    const form = this.$("#plugin-settings-form");
    if (!form) return;
    this.setState({ saving: true });

    const updates = collectUpdates(form, this.props.keys);
    try {
      await updateSettings(updates);
      // Reflect changes immediately in the global settings store.
      const currentSettings = store.get("settings") || {};
      const { normalizeSettings } = await import("../../utils/helpers.js");
      store.set("settings", { ...currentSettings, ...normalizeSettings(updates) });
      store.set("toast", { message: "Settings saved.", type: "success" });
      this._close();
    } catch (err) {
      console.error("[PluginSettingsPanel] save error:", err);
      store.set("toast", { message: err.message || "Could not save settings.", type: "error" });
      this.setState({ saving: false });
    }
  }

  async _disconnectInstagram() {
    try {
      const { disconnectInstagram } = await import("../../api/instagram.js");
      await disconnectInstagram();
      store.set("toast", { message: "Instagram disconnected.", type: "success" });
      this._close();
    } catch (err) {
      store.set("toast", { message: err.message || "Failed to disconnect.", type: "error" });
    }
  }
}
