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
import {
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
  authorizeBackupDownload,
  backupDownloadUrl,
  uploadBackupArchive,
  restartServer,
} from "../../../api/system.js";
import { sha256 } from "../../../api/auth.js";
import { getAllSettings, updateSettings } from "../../../api/settings.js";
import { store } from "../../../store.js";
import { escapeHtml } from "../../../utils/helpers.js";
import { formatFileSize } from "../../../utils/formatters.js";
import { RESTORE_SVG, X_SVG, DOWNLOAD_SVG, UPLOAD_SVG, REFRESH_SVG } from "../../../utils/icons.js";
import { showConfirm, showPrompt } from "../../../utils/dialogs.js";
import { GestureController } from "../../../core/gestures.js";

export class BackupsSection extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      backups: [],
      creatingBackup: false,
      // Move-in upload progress (0..100); uploading gates the controls.
      uploading: false,
      uploadPct: 0,
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

  // A single backup row: a live "Creating…" placeholder while the archive is
  // still being written, otherwise the normal swipe row with actions.
  _renderItem(b) {
    if (b.in_progress) {
      return `
        <li class="backup-item backup-in-progress">
          <span class="backup-spinner" aria-hidden="true"></span>
          <div class="backup-progress-content">
            <div class="backup-name font-mono">${escapeHtml(b.filename)}</div>
            <div class="backup-sub">
              <span class="backup-sub-status">Creating… ${escapeHtml(formatFileSize(b.size))} so far</span>
            </div>
          </div>
        </li>`;
    }
    return `
      <li class="backup-swipe-item">
        <div class="backup-swipe-actions">
          <button class="btn download-backup-btn" data-filename="${escapeHtml(b.filename)}" title="Download" aria-label="Download">${DOWNLOAD_SVG}</button>
          <button class="btn restore-backup-btn" data-filename="${escapeHtml(b.filename)}" title="Restore" aria-label="Restore">${RESTORE_SVG}</button>
          <button class="btn btn-danger delete-backup-btn" data-filename="${escapeHtml(b.filename)}" title="Delete" aria-label="Delete">${X_SVG}</button>
        </div>
        <div class="backup-swipe-content">
          <div class="backup-name font-mono">${escapeHtml(b.filename)}</div>
          <div class="backup-sub">
            <span class="backup-sub-date">${escapeHtml(new Date(b.created_at).toLocaleString())}</span>
            <span class="backup-sub-size">${escapeHtml(formatFileSize(b.size))}</span>
            ${
              b.sha256
                ? `<span class="backup-sub-sha font-mono" title="SHA-256: ${escapeHtml(b.sha256)}">sha256 ${escapeHtml(b.sha256.slice(0, 10))}…</span>`
                : ""
            }
          </div>
        </div>
      </li>`;
  }

  render() {
    const { loading, backups, creatingBackup, uploading, uploadPct } = this.state;
    const backupInProgress = backups.some((b) => b.in_progress);
    const items = loading
      ? '<li class="backup-empty">Loading…</li>'
      : backups.length
        ? backups.map((b) => this._renderItem(b)).join("")
        : '<li class="backup-empty">No backups found.</li>';

    const creating = creatingBackup || backupInProgress;
    // Rendered flush inside the plugin drawer, which supplies the "Backups" title.
    return `
      <div class="section-actions">
        <button id="create-backup-btn" class="btn btn-sm btn-primary" ${creating || uploading ? "disabled" : ""}>
          ${creating ? "Creating…" : "Create backup"}
        </button>
        <button id="upload-backup-btn" class="btn btn-sm btn-secondary" ${creating || uploading ? "disabled" : ""} title="Add a local archive to your backups (apply it later with Restore)">
          ${UPLOAD_SVG}<span>Upload archive</span>
        </button>
        <span class="section-actions-spacer"></span>
        <button id="restart-server-btn" class="btn btn-sm section-action-muted" title="Restart the server (applies a scheduled restore)">
          ${REFRESH_SVG}<span>Restart</span>
        </button>
        <input type="file" id="upload-backup-input" accept=".gz,.tar.gz,application/gzip" hidden>
      </div>
      ${
        uploading
          ? `<div class="progress-bar"><div class="progress-fill" style="width:${uploadPct}%"></div></div>
             <p class="progress-text">Uploading archive… ${uploadPct}%</p>`
          : ""
      }
      <div class="section-block">
        <h3 class="section-subhead">Schedule</h3>
        ${this._renderSettings()}
      </div>
      <div class="section-block">
        <h3 class="section-subhead">Backups</h3>
        <ul class="backup-list">${items}</ul>
      </div>`;
  }

  afterRender() {
    this.$("#create-backup-btn")?.addEventListener("click", () => this._handleCreate());

    const uploadInput = this.$("#upload-backup-input");
    this.$("#upload-backup-btn")?.addEventListener("click", () => uploadInput?.click());
    uploadInput?.addEventListener("change", () => {
      const file = uploadInput.files?.[0];
      uploadInput.value = ""; // allow re-picking the same file later
      if (file) this._handleUpload(file);
    });

    this.$("#restart-server-btn")?.addEventListener("click", () => this._handleRestartServer());

    this._bindSettings();

    this._bindSwipe();

    this.$$(".download-backup-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._handleDownload(btn.dataset.filename));
    });

    this.$$(".restore-backup-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const file = btn.dataset.filename;
        showPrompt({
          title: "Restore backup",
          message:
            `Apply "${file}"? This replaces ALL current data — posts, media, settings, ` +
            `and your login password — with the contents of the archive, then restarts the ` +
            `server to take effect. This cannot be undone.\n` +
            `Enter your password to confirm:`,
          inputType: "password",
          variant: "danger",
          confirmText: "Restore & restart",
          onConfirm: (password) => {
            if (password) this._handleRestore(file, password);
          },
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
    this._stopPoll();
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
      this._syncPoll();
    } catch (err) {
      this.setState({ loading: false });
      store.set("toast", { message: err.message || "Could not load backups.", type: "error" });
    }
  }

  // Refresh only the backup list (used while polling, so it doesn't disturb the
  // settings inputs' loaded values).
  async _refreshBackups() {
    try {
      const backups = await listBackups();
      this.setState({ backups: Array.isArray(backups) ? backups : this.state.backups });
    } catch {
      /* keep the last list; try again on the next tick */
    }
    this._syncPoll();
  }

  // Poll while a backup is being created so the in-progress row (and its growing
  // size) update live and the list flips to "done" without a manual refresh.
  // We poll while a backup is in progress AND, right after clicking Create, during
  // a grace window — the background job writes the .partial file a moment after the
  // request returns, so a single immediate refresh can miss it.
  _syncPoll() {
    const active = this.state.backups.some((b) => b.in_progress);
    if (active) this._awaitingBackupStart = false; // now tracked by its in-progress row
    const awaitingStart =
      this._awaitingBackupStart && Date.now() - this._backupInitiatedAt < 30000;
    const shouldPoll = active || awaitingStart;
    if (shouldPoll && !this._pollTimer) {
      this._pollTimer = setInterval(() => this._refreshBackups(), 2000);
    } else if (!shouldPoll) {
      this._awaitingBackupStart = false;
      this._stopPoll();
    }
  }

  _stopPoll() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _handleCreate() {
    this.setState({ creatingBackup: true });
    try {
      await createBackup();
      store.set("toast", { message: "Backup started…", type: "info" });
      // The background job creates the .partial a moment later; poll until it
      // appears (then until it completes) instead of relying on one refresh.
      this._backupInitiatedAt = Date.now();
      this._awaitingBackupStart = true;
      await this._refreshBackups();
    } catch (err) {
      const msg =
        err?.status === 409
          ? "A backup is already in progress."
          : err.message || "Backup failed.";
      store.set("toast", { message: msg, type: "error" });
    } finally {
      this.setState({ creatingBackup: false });
    }
  }

  // Restore is applied on the next startup (it can't overwrite the live DB
  // safely), so it's a single "restore & restart" action. The blocking overlay
  // goes up immediately and covers the whole flow — scheduling the restore
  // (validating the archive can take a moment) and the restart — so there's no
  // confusing gap or intermediate dialog.
  async _handleRestore(filename, password) {
    this._mountRestartOverlay("Restoring backup…");
    try {
      const hashed = await sha256(password);
      await restoreBackup(filename, hashed);
    } catch (err) {
      this._unmountRestartOverlay();
      const msg = err?.status === 403 ? "Incorrect password." : err.message || "Restore failed.";
      store.set("toast", { message: msg, type: "error" });
      return;
    }
    await this._restartAndReload("Restarting server…");
  }

  _handleRestartServer() {
    showConfirm({
      title: "Restart server",
      message: "Restart the server now? It will be unavailable for a few seconds.",
      confirmText: "Restart",
      variant: "danger",
      onConfirm: () => {
        this._mountRestartOverlay("Restarting server…");
        this._restartAndReload("Restarting server…");
      },
    });
  }

  // Trigger the in-place restart, then hold the (already-mounted) blocking overlay
  // until the server is reachable again before reloading — so the operator never
  // sees a raw "connection refused" during the restart window.
  async _restartAndReload(text) {
    try {
      await restartServer();
    } catch (err) {
      this._unmountRestartOverlay();
      store.set("toast", { message: err.message || "Restart failed.", type: "error" });
      return;
    }
    this._mountRestartOverlay(text); // update the label if it was showing something else
    await this._awaitServerBack();
    location.reload();
  }

  _mountRestartOverlay(text = "Restarting server…") {
    if (this._restartOverlay) {
      const label = this._restartOverlay.querySelector(".restart-overlay-text");
      if (label) label.textContent = text;
      return;
    }
    const el = document.createElement("div");
    el.className = "restart-overlay";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    const card = document.createElement("div");
    card.className = "restart-overlay-card";
    card.innerHTML =
      '<span class="restart-overlay-spinner" aria-hidden="true"></span>' +
      '<p class="restart-overlay-text"></p>' +
      '<p class="restart-overlay-sub">This will only take a moment.</p>';
    card.querySelector(".restart-overlay-text").textContent = text;
    el.appendChild(card);
    document.body.appendChild(el);
    this._restartOverlay = el;
  }

  _unmountRestartOverlay() {
    this._restartOverlay?.remove();
    this._restartOverlay = null;
  }

  // Resolve once the server has gone down and come back up (a resolved fetch —
  // even a 401 after a restore invalidates the session — means it's serving).
  // Falls back to resolving on a timeout so we never hang forever.
  _awaitServerBack() {
    return new Promise((resolve) => {
      const start = Date.now();
      let sawDown = false;
      const ping = () =>
        fetch("/api/system/version", { cache: "no-store" })
          .then(() => true)
          .catch(() => false);
      const tick = async () => {
        const up = await ping();
        if (!up) sawDown = true;
        const elapsed = Date.now() - start;
        // Reload when it has cycled down→up, or it's clearly up and we never caught
        // the (very brief) down window, or after a hard 60s cap.
        if ((sawDown && up) || (up && elapsed > 8000) || elapsed > 60000) {
          resolve();
          return;
        }
        setTimeout(tick, 400);
      };
      tick();
    });
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

  // Move out: re-enter the password, exchange it for a one-time token, then let
  // the browser stream the archive to disk (supports resume; never buffered in JS).
  _handleDownload(filename) {
    showPrompt({
      title: "Download backup",
      message: `Confirm your password to download "${filename}".`,
      inputType: "password",
      confirmText: "Download",
      onConfirm: async (password) => {
        if (!password) return;
        try {
          const hashed = await sha256(password);
          const { token } = await authorizeBackupDownload(filename, hashed);
          const a = document.createElement("a");
          a.href = backupDownloadUrl(filename, token);
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch (err) {
          store.set("toast", { message: err.message || "Download failed.", type: "error" });
        }
      },
    });
  }

  // Move in: upload the archive into the backups folder (staging only — it is not
  // applied). The user reviews it in the list and Restores it if they choose to.
  _handleUpload(file) {
    showConfirm({
      title: "Upload archive",
      message: `Add "${file.name}" to your backups? It won't be applied — you can Restore it afterward if you want to.`,
      confirmText: "Upload",
      onConfirm: async () => {
        this.setState({ uploading: true, uploadPct: 0 });
        try {
          const res = await uploadBackupArchive(file, (frac) => {
            this.setState({ uploading: true, uploadPct: Math.round(frac * 100) });
          });
          store.set("toast", {
            message: res.message || "Archive uploaded to backups. Use Restore to apply it.",
            type: "success",
          });
          await this._load();
        } catch (err) {
          store.set("toast", { message: err.message || "Upload failed.", type: "error" });
        } finally {
          this.setState({ uploading: false, uploadPct: 0 });
        }
      },
    });
  }
}
