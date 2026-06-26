/**
 * BackupsSection — the database-backup block for the `backups` plugin.
 *
 * Self-contained: loads the backup list on mount and handles create/restore/
 * delete. Extracted from SystemPage so it can live in the plugin's settings
 * drawer (PluginSettingsPanel). Renders a `.card` with a swipe-to-reveal list:
 * each row shows the filename then date · size, and swiping the row left (or
 * hovering on pointer devices) uncovers the restore/delete actions.
 */

import { Component } from "../../Component.js";
import { listBackups, createBackup, restoreBackup, deleteBackup } from "../../../api/system.js";
import { getAllSettings, updateSettings } from "../../../api/settings.js";
import { store } from "../../../store.js";
import { escapeHtml } from "../../../utils/helpers.js";
import { formatFileSize } from "../../../utils/formatters.js";
import { RESTORE_SVG, X_SVG } from "../../../utils/icons.js";
import { showConfirm } from "../../../utils/dialogs.js";
import { GestureController } from "../../../core/gestures.js";

export class BackupsSection extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      backups: [],
      creatingBackup: false,
      // Backup automation settings (loaded alongside the list).
      enableBackup: true,
      intervalDays: 1,
      keep: 7,
    };
  }

  _renderSettings() {
    const { enableBackup, intervalDays, keep } = this.state;
    const preset = [1, 7, 30].includes(intervalDays);
    const opt = (v, label) =>
      `<option value="${v}"${String(intervalDays) === String(v) ? " selected" : ""}>${label}</option>`;
    return `
      <div class="backup-settings">
        <label class="backup-setting-row">
          <input type="checkbox" id="bk-enable"${enableBackup ? " checked" : ""}>
          <span>Automatic backups</span>
        </label>
        <div class="backup-setting-row">
          <label for="bk-freq">Frequency</label>
          <select id="bk-freq" class="filter-select"${enableBackup ? "" : " disabled"}>
            ${opt(1, "Daily")}
            ${opt(7, "Weekly")}
            ${opt(30, "Monthly")}
            <option value="custom"${preset ? "" : " selected"}>Every N days…</option>
          </select>
          <input type="number" id="bk-freq-days" class="form-input backup-num" min="1" step="1"
                 value="${intervalDays}"${preset ? ' style="display:none"' : ""}${enableBackup ? "" : " disabled"}>
        </div>
        <div class="backup-setting-row">
          <label for="bk-keep">Keep last</label>
          <input type="number" id="bk-keep" class="form-input backup-num" min="0" step="1" value="${keep}">
          <span class="backup-setting-hint">backups (0 = keep all)</span>
        </div>
      </div>`;
  }

  render() {
    const { loading, backups, creatingBackup } = this.state;
    const items = loading
      ? '<li class="backup-empty">Loading…</li>'
      : backups.length
        ? backups
            .map(
              (b) => `
              <li class="backup-swipe-item">
                <div class="backup-swipe-actions">
                  <button class="btn restore-backup-btn" data-filename="${escapeHtml(b.filename)}" title="Restore" aria-label="Restore">${RESTORE_SVG}</button>
                  <button class="btn btn-danger delete-backup-btn" data-filename="${escapeHtml(b.filename)}" title="Delete" aria-label="Delete">${X_SVG}</button>
                </div>
                <div class="backup-swipe-content">
                  <div class="backup-name font-mono">${escapeHtml(b.filename)}</div>
                  <div class="backup-sub">
                    <span class="backup-sub-date">${escapeHtml(new Date(b.created_at).toLocaleString())}</span>
                    <span class="backup-sub-size">${escapeHtml(formatFileSize(b.size))}</span>
                  </div>
                </div>
              </li>`,
            )
            .join("")
        : '<li class="backup-empty">No backups found.</li>';

    return `
      <section class="card">
        <div class="card-header">
          <button id="create-backup-btn" class="btn btn-sm btn-primary" ${creatingBackup ? "disabled" : ""}>
            ${creatingBackup ? "Creating…" : "Create New Backup"}
          </button>
        </div>
        <div class="card-body">
          ${this._renderSettings()}
          <ul class="backup-list">${items}</ul>
        </div>
      </section>`;
  }

  afterRender() {
    this.$("#create-backup-btn")?.addEventListener("click", () => this._handleCreate());

    this._bindSettings();

    this._bindSwipe();

    this.$$(".restore-backup-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const file = btn.dataset.filename;
        showConfirm({
          title: "Restore backup",
          message: `Restore from "${file}"? This will overwrite the current database.`,
          confirmText: "Restore",
          variant: "danger",
          onConfirm: () => this._handleRestore(file),
        });
      });
    });

    this.$$(".delete-backup-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const file = btn.dataset.filename;
        showConfirm({
          title: "Delete backup",
          message: `Delete backup "${file}"? This cannot be undone.`,
          confirmText: "Delete",
          variant: "danger",
          onConfirm: () => this._handleDelete(file),
        });
      });
    });
  }

  /**
   * Wire each backup row for swipe-to-reveal. The row's content slides left to
   * uncover the restore/delete buttons parked behind it on the right; a rightward
   * swipe (or a tap on an open row) hides them again. Only one row stays open at a
   * time. Each row owns its own GestureController, and the drawer is told to ignore
   * touches on `.backup-swipe-item` (see PluginSettingsPanel) so this horizontal
   * drag never also closes the drawer.
   */
  _bindSwipe() {
    this._destroySwipe();
    this._itemGestures = [];

    const items = [...this.$$(".backup-swipe-item")];
    const closeAll = (except) => {
      items.forEach((it) => {
        if (it === except) return;
        const c = it.querySelector(".backup-swipe-content");
        c.style.transition = "";
        c.style.transform = "translateX(0)";
        it.classList.remove("is-open");
      });
    };

    items.forEach((item) => {
      const content = item.querySelector(".backup-swipe-content");
      const actions = item.querySelector(".backup-swipe-actions");

      const open = () => {
        closeAll(item);
        content.style.transition = "";
        content.style.transform = `translateX(-${actions.offsetWidth}px)`;
        item.classList.add("is-open");
      };
      const close = () => {
        content.style.transition = "";
        content.style.transform = "translateX(0)";
        item.classList.remove("is-open");
      };
      const snap = () => (item.classList.contains("is-open") ? open() : close());

      const g = new GestureController(content, {
        swipeThresholdPx: 24,
        onSwipeMove: (mx, my) => {
          // Vertical drags belong to the drawer's native scroll — leave them alone.
          if (Math.abs(my) >= Math.abs(mx)) return;
          const w = actions.offsetWidth;
          const base = item.classList.contains("is-open") ? -w : 0;
          const x = Math.max(-w, Math.min(0, base + mx));
          content.style.transition = "none";
          content.style.transform = `translateX(${x}px)`;
        },
        onSwipeCommit: (dir) => {
          if (dir === "left") open();
          else if (dir === "right") close();
          else snap();
        },
        onSwipeCancel: snap,
        onTap: () => {
          if (item.classList.contains("is-open")) close();
        },
      });
      this._itemGestures.push(g);
    });
  }

  _destroySwipe() {
    this._itemGestures?.forEach((g) => g.destroy());
    this._itemGestures = [];
  }

  // Wire the automation controls. Frequency toggles a custom day-count input;
  // every control persists on change (no separate Save button).
  _bindSettings() {
    const enable = this.$("#bk-enable");
    const freq = this.$("#bk-freq");
    const freqDays = this.$("#bk-freq-days");
    const keep = this.$("#bk-keep");

    enable?.addEventListener("change", () => {
      // Enable/disable the cadence controls in place without a full re-render.
      const on = enable.checked;
      if (freq) freq.disabled = !on;
      if (freqDays) freqDays.disabled = !on;
      this._saveSettings();
    });

    freq?.addEventListener("change", () => {
      if (freqDays) freqDays.style.display = freq.value === "custom" ? "" : "none";
      this._saveSettings();
    });

    freqDays?.addEventListener("change", () => this._saveSettings());
    keep?.addEventListener("change", () => this._saveSettings());
  }

  async _saveSettings() {
    const enable = this.$("#bk-enable")?.checked ?? true;
    const freq = this.$("#bk-freq")?.value;
    const freqDays = this.$("#bk-freq-days")?.value;
    const interval = freq === "custom" ? Math.max(1, parseInt(freqDays, 10) || 1) : parseInt(freq, 10) || 1;
    const keep = Math.max(0, parseInt(this.$("#bk-keep")?.value, 10) || 0);

    // Keep local state in sync so a later re-render shows the saved values.
    this.state.enableBackup = enable;
    this.state.intervalDays = interval;
    this.state.keep = keep;

    try {
      await updateSettings({
        enable_backup: String(enable),
        backup_interval_days: String(interval),
        backup_keep: String(keep),
      });
      store.set("toast", { message: "Backup settings saved.", type: "success" });
    } catch (err) {
      store.set("toast", { message: err.message || "Could not save settings.", type: "error" });
    }
  }

  // Release per-row gesture controllers before each re-render and on unmount.
  beforeRender() {
    this._destroySwipe();
  }

  beforeUnmount() {
    this._destroySwipe();
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const [backups, settings] = await Promise.all([
        listBackups().catch(() => []),
        getAllSettings().catch(() => ({})),
      ]);
      this.setState({
        loading: false,
        backups: Array.isArray(backups) ? backups : [],
        enableBackup: (settings.enable_backup ?? "true") === "true",
        intervalDays: parseInt(settings.backup_interval_days, 10) || 1,
        keep: settings.backup_keep != null ? parseInt(settings.backup_keep, 10) || 0 : 7,
      });
    } catch (err) {
      this.setState({ loading: false });
      store.set("toast", { message: err.message || "Could not load backups.", type: "error" });
    }
  }

  async _handleCreate() {
    this.setState({ creatingBackup: true });
    try {
      await createBackup();
      store.set("toast", { message: "Backup created.", type: "success" });
      this._load();
    } catch (err) {
      store.set("toast", { message: err.message || "Backup failed.", type: "error" });
    } finally {
      this.setState({ creatingBackup: false });
    }
  }

  async _handleRestore(filename) {
    store.set("toast", { message: "Restoring backup…", type: "info" });
    try {
      await restoreBackup(filename);
      store.set("toast", { message: "Backup restored. Reloading…", type: "success" });
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      store.set("toast", { message: err.message || "Restore failed.", type: "error" });
    }
  }

  async _handleDelete(filename) {
    try {
      await deleteBackup(filename);
      store.set("toast", { message: "Backup deleted.", type: "success" });
      this._load();
    } catch (err) {
      store.set("toast", { message: err.message || "Delete failed.", type: "error" });
    }
  }
}
