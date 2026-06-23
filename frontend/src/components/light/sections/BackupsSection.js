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
import { store } from "../../../store.js";
import { escapeHtml } from "../../../utils/helpers.js";
import { formatFileSize } from "../../../utils/formatters.js";
import { RESTORE_SVG, X_SVG } from "../../../utils/icons.js";
import { showConfirm } from "../../../utils/dialogs.js";
import { GestureController } from "../../../core/gestures.js";

export class BackupsSection extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, backups: [], creatingBackup: false };
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
          <h2>Backups</h2>
          <button id="create-backup-btn" class="btn btn-sm btn-primary" ${creatingBackup ? "disabled" : ""}>
            ${creatingBackup ? "Creating…" : "Create New Backup"}
          </button>
        </div>
        <div class="card-body">
          <ul class="backup-list">${items}</ul>
        </div>
      </section>`;
  }

  afterRender() {
    this.$("#create-backup-btn")?.addEventListener("click", () => this._handleCreate());

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
      const backups = await listBackups().catch(() => []);
      this.setState({ loading: false, backups: Array.isArray(backups) ? backups : [] });
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
