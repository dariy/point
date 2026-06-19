/**
 * SystemPage — system administration (cache, backups, migrations).
 *
 * Fetches: GET /api/system/*
 */

import { Component } from "../../components/Component.js";
import {
  adminLayoutTemplate,
  setupAdminLayout,
} from "../../components/light/AdminLayout.js";
import {
  clearCache,
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
  getMigrations,
  updateMapCoords,
  getDiskInfo,
} from "../../api/system.js";
import { getOfflineStats, getOfflineSnapshot } from "../../api/offline.js";
import {
  getInstagramStatus,
  triggerInstagramImport,
  getInstagramImportStatus,
} from "../../api/instagram.js";
import { saveSnapshot, saveMeta, getMeta } from "../../utils/offlineStore.js";
import { preCacheImages } from "../../utils/imageCache.js";
import {
  getQueue,
  resetFailedOps,
  updateStatus,
} from "../../utils/mutationQueue.js";
import { syncQueue } from "../../utils/sync.js";
import { store } from "../../store.js";
import { escapeHtml } from "../../utils/helpers.js";
import { formatFileSize, formatDateShort } from "../../utils/formatters.js";
import { RESTORE_SVG, X_SVG, WARNING_SVG } from "../../utils/icons.js";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog.js";

export default class SystemPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      backups: [],
      migrations: [],
      creatingBackup: false,
      updatingCoords: false,
      coordsResult: null,
      error: null,

      // Offline states
      offlineStats: null,
      loadingOfflineStats: false,
      downloadingOffline: false,
      offlineProgress: 0,
      offlineStatusText: "",
      lastSync: null,

      // Sync queue state
      syncQueue: [],

      diskInfo: null,

      // Instagram import state
      igConnected: false,
      igImportStatus: null, // last fetched importStatusResponse
      igImporting: false,
    };
  }

  render() {
    return adminLayoutTemplate({
      title: "System",
      content: this._renderContent(),
    });
  }

  _renderContent() {
    const {
      loading,
      error,
      backups,
      migrations,
      creatingBackup,
      updatingCoords,
      coordsResult,
      offlineStats,
      loadingOfflineStats,
      downloadingOffline,
      offlineProgress,
      offlineStatusText,
      lastSync,
      syncQueue: queue,
      diskInfo,
      igConnected,
      igImportStatus,
      igImporting,
    } = this.state;

    if (loading)
      return '<div class="loading-spinner" aria-label="Loading system info\u2026"></div>';
    if (error)
      return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    const offlineSection = this._renderOfflineSection(
      offlineStats,
      loadingOfflineStats,
      downloadingOffline,
      offlineProgress,
      offlineStatusText,
      lastSync,
    );
    const syncSection = this._renderSyncSection(queue);
    const diskSection = diskInfo ? this._renderDiskSection(diskInfo) : "";
    const igImportSection = igConnected
      ? this._renderInstagramImportSection(igImportStatus, igImporting)
      : "";

    return `
      <div class="system-grid">
        <section class="card">
          <div class="card-header"><h2>Cache</h2></div>
          <div class="card-body">
            <p>Clear the server-side image cache (thumbnails and processed images). Original files won't be touched.</p>
            <button id="clear-cache-btn" class="btn btn-secondary">Clear Image Cache</button>
          </div>
        </section>

        <section class="card">
          <div class="card-header"><h2>Map Data</h2></div>
          <div class="card-body">
            <p>Re-extract coordinates from EXIF data for all media files to update the global map. This won't change manually set tag coordinates.</p>
            <button id="update-coords-btn" class="btn btn-secondary" ${updatingCoords ? "disabled" : ""}>
              ${updatingCoords ? "Updating\u2026" : "Update Map Coords"}
            </button>
            ${coordsResult ? `<p class="system-msg success">${escapeHtml(coordsResult)}</p>` : ""}
          </div>
        </section>

        ${diskSection}
        ${offlineSection}
        ${syncSection}
        ${igImportSection}

        <section class="card system-full-width">
          <div class="card-header">
            <h2>Backups</h2>
            <button id="create-backup-btn" class="btn btn-sm btn-primary" ${creatingBackup ? "disabled" : ""}>
              ${creatingBackup ? "Creating\u2026" : "Create New Backup"}
            </button>
          </div>
          <div class="card-body">
            <div class="table-container">
              <table class="table">
                <thead>
                  <tr>
                    <th>Filename</th>
                    <th>Date</th>
                    <th class="text-right">Size</th>
                    <th class="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    backups.length
                      ? backups
                          .map(
                            (b) => `
                    <tr>
                      <td><code class="font-mono">${escapeHtml(b.filename)}</code></td>
                      <td>${escapeHtml(new Date(b.created_at).toLocaleString())}</td>
                      <td class="text-right font-mono">${escapeHtml(formatFileSize(b.size))}</td>
                      <td class="text-right">
                        <button class="btn btn-sm restore-backup-btn" data-filename="${escapeHtml(b.filename)}" title="Restore">${RESTORE_SVG}</button>
                        <button class="btn btn-sm btn-danger delete-backup-btn" data-filename="${escapeHtml(b.filename)}" title="Delete">${X_SVG}</button>
                      </td>
                    </tr>
                  `,
                          )
                          .join("")
                      : '<tr><td colspan="4" class="empty-state">No backups found.</td></tr>'
                  }
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <section class="card system-full-width">
          <div class="card-header"><h2>Database Migrations</h2></div>
          <div class="card-body">
            <div class="table-container">
              <table class="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th class="text-right">Applied At</th>
                  </tr>
                </thead>
                <tbody>
                  ${migrations
                    .map(
                      (m) => `
                    <tr>
                      <td>${escapeHtml(m.name)}</td>
                      <td class="text-right">${m.applied_at ? escapeHtml(new Date(m.applied_at).toLocaleString()) : '<span class="text-muted">Pending</span>'}</td>
                    </tr>
                  `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>`;
  }

  _renderDiskSection(disk) {
    const usagePercent = Math.round((disk.used / disk.total) * 100);
    const barClass =
      usagePercent >= 90 ? "danger" : usagePercent >= 70 ? "warning" : "";
    return `
      <section class="card">
        <div class="card-header"><h2>Disk Usage (Server)</h2></div>
        <div class="card-body">
          <p>
            ${escapeHtml(formatFileSize(disk.used))} of ${escapeHtml(formatFileSize(disk.total))} used (${usagePercent}%)
          </p>
          <div class="storage-bar">
            <div class="storage-bar-fill ${barClass}" style="width: ${usagePercent}%"></div>
          </div>
          <p class="form-hint" style="margin-top: var(--spacing-sm)">Path: <code>${escapeHtml(disk.path)}</code></p>
        </div>
      </section>`;
  }

  _renderOfflineSection(
    stats,
    loading,
    downloading,
    progress,
    statusText,
    lastSync,
  ) {
    let body = "";
    if (loading) {
      body = '<div class="loading-spinner btn-sm"></div>';
    } else if (!stats) {
      body = '<p class="error-state">Could not load offline stats.</p>';
    } else {
      const syncText = lastSync
        ? `Last updated: ${formatDateShort(lastSync)}`
        : "Never updated";
      body = `
        <div class="offline-stats">
          <div class="stat-row"><span>Posts:</span> <strong>${stats.post_count}</strong></div>
          <div class="stat-row"><span>Media:</span> <strong>${stats.image_count}</strong> (${formatFileSize((stats.original_bytes || 0) + (stats.thumbnail_bytes || 0))})</div>
          <p class="form-hint">${syncText}</p>
        </div>
        <div class="offline-actions" style="margin-top: var(--spacing-md)">
          <button id="download-offline-btn" class="btn btn-primary" ${downloading ? "disabled" : ""}>
            ${downloading ? "Updating\u2026" : "Update Offline Data"}
          </button>
        </div>
        ${
          downloading
            ? `
          <div class="progress-container" style="margin-top: var(--spacing-md)">
            <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>
            <p class="progress-text">${escapeHtml(statusText)} (${Math.round(progress)}%)</p>
          </div>
        `
            : ""
        }
      `;
    }

    return `
      <section class="card">
        <div class="card-header"><h2>Offline Data (Local)</h2></div>
        <div class="card-body">${body}</div>
      </section>`;
  }

  _renderInstagramImportSection(status, importing) {
    const running = status?.running || importing;
    const btnLabel = running ? "Importing\u2026" : "Import / Sync Now";
    let statusHtml = "";
    if (status) {
      if (running && status.progress) {
        const p = status.progress;
        const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
        statusHtml = `
          <div class="progress-container" style="margin-top:var(--spacing-sm)">
            <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
            <p class="progress-text">${p.done}/${p.total} — imported: ${p.imported}, skipped: ${p.skipped}, errors: ${p.errors}</p>
          </div>`;
      } else if (!running) {
        const parts = [];
        if (status.imported !== undefined)
          parts.push(`Imported: ${status.imported}`);
        if (status.skipped !== undefined)
          parts.push(`Skipped: ${status.skipped}`);
        if (status.errors !== undefined) parts.push(`Errors: ${status.errors}`);
        if (status.finished_at)
          parts.push(`Last run: ${formatDateShort(status.finished_at)}`);
        if (parts.length)
          statusHtml = `<p class="system-msg">${escapeHtml(parts.join(" · "))}</p>`;
        if (status.error)
          statusHtml += `<p class="system-msg error">${escapeHtml(status.error)}</p>`;
        if (Array.isArray(status.messages) && status.messages.length) {
          const items = status.messages
            .map((m) => `<li>${escapeHtml(m)}</li>`)
            .join("");
          statusHtml += `
            <details class="ig-import-details">
              <summary>${status.messages.length} message${status.messages.length === 1 ? "" : "s"}</summary>
              <ul class="ig-import-messages">${items}</ul>
            </details>`;
        }
      }
    }
    return `
      <section class="card">
        <div class="card-header"><h2>Instagram Import</h2></div>
        <div class="card-body">
          <p>Import all Instagram posts into Point as drafts. Already-imported posts are skipped (idempotent).</p>
          <button id="ig-import-btn" class="btn btn-secondary" ${running ? "disabled" : ""}>${btnLabel}</button>
          ${statusHtml}
        </div>
      </section>`;
  }

  _renderSyncSection(queue) {
    const failedCount = queue.filter((op) => op.failed).length;
    const pendingCount = queue.filter((op) => !op.failed).length;

    let rows = queue
      .map((op) => {
        const icon = op.failed ? WARNING_SVG : "●";
        const statusCls = op.failed ? "status-failed" : "status-pending";
        return `
        <div class="sync-queue-item ${statusCls}">
          <span class="sync-icon">${icon}</span>
          <div class="sync-details">
            <div class="sync-op"><strong>${escapeHtml(op.method)}</strong> ${escapeHtml(op.url)}</div>
            ${op.error ? `<div class="sync-error">${escapeHtml(op.error)}</div>` : ""}
          </div>
          <div class="sync-meta">${formatDateShort(op.timestamp)}</div>
        </div>`;
      })
      .join("");

    if (!queue.length) {
      rows = '<p class="empty-state">No pending operations.</p>';
    }

    return `
      <section class="card system-full-width">
        <div class="card-header">
          <h2>Pending Sync Queue</h2>
          <div class="header-actions">
            ${failedCount > 0 ? '<button id="reset-sync-btn" class="btn btn-sm btn-secondary">Retry Failed</button>' : ""}
            ${pendingCount > 0 ? '<button id="sync-now-btn" class="btn btn-sm btn-primary">Sync Now</button>' : ""}
          </div>
        </div>
        <div class="card-body">
          <div class="sync-queue-list">${rows}</div>
        </div>
      </section>`;
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: "/light/system",
    });

    if (this.state.loading || this.state.error) return;

    this.container
      .querySelector("#clear-cache-btn")
      ?.addEventListener("click", () => this._handleClearCache());
    this.container
      .querySelector("#update-coords-btn")
      ?.addEventListener("click", () => this._handleUpdateCoords());
    this.container
      .querySelector("#create-backup-btn")
      ?.addEventListener("click", () => this._handleCreateBackup());
    this.container
      .querySelector("#download-offline-btn")
      ?.addEventListener("click", () => this._handleDownloadOffline());
    this.container
      .querySelector("#reset-sync-btn")
      ?.addEventListener("click", () => this._handleResetSync());
    this.container
      .querySelector("#sync-now-btn")
      ?.addEventListener("click", () => this._handleSyncNow());
    this.container
      .querySelector("#ig-import-btn")
      ?.addEventListener("click", () => this._handleStartImport());

    this.container.querySelectorAll(".restore-backup-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const file = btn.dataset.filename;
        this._showConfirm(
          "Restore backup",
          `Restore from "${file}"? This will overwrite the current database.`,
          "Restore",
          "danger",
          () => {
            this._handleRestoreBackup(file);
          },
        );
      });
    });

    this.container.querySelectorAll(".delete-backup-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const file = btn.dataset.filename;
        this._showConfirm(
          "Delete backup",
          `Delete backup "${file}"? This cannot be undone.`,
          "Delete",
          "danger",
          () => {
            this._handleDeleteBackup(file);
          },
        );
      });
    });
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
    if (this._importPollTimer) {
      clearInterval(this._importPollTimer);
      this._importPollTimer = null;
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const [
        backups,
        migrations,
        offlineStats,
        meta,
        queue,
        diskInfo,
        igStatus,
      ] = await Promise.all([
        listBackups(),
        getMigrations(),
        getOfflineStats(),
        getMeta("last_sync"),
        getQueue(),
        getDiskInfo(),
        getInstagramStatus().catch(() => null),
      ]);
      const igConnected = igStatus?.connected || false;
      let igImportStatus = null;
      if (igConnected) {
        igImportStatus = await getInstagramImportStatus().catch(() => null);
      }
      this.setState({
        loading: false,
        backups: Array.isArray(backups) ? backups : [],
        migrations: Array.isArray(migrations) ? migrations : [],
        offlineStats,
        lastSync: meta || null,
        syncQueue: queue,
        diskInfo,
        igConnected,
        igImportStatus,
        error: null,
      });
      // If an import was already running when we loaded, start polling.
      if (igImportStatus?.running) this._startImportPoll();
    } catch (err) {
      console.error("[SystemPage] load error:", err);
      this.setState({
        loading: false,
        error:
          "Could not load system information: " +
          (err.message || err.toString() || JSON.stringify(err)),
      });
    }
  }

  async _handleClearCache() {
    try {
      await clearCache();
      store.set("toast", { message: "Cache cleared.", type: "success" });
    } catch (err) {
      store.set("toast", {
        message: err.message || "Failed to clear cache.",
        type: "error",
      });
    }
  }

  async _handleUpdateCoords() {
    this.setState({ updatingCoords: true, coordsResult: null });
    try {
      const result = await updateMapCoords();
      this.setState({
        updatingCoords: false,
        coordsResult: `Updated ${result.updated_count} media files.`,
      });
    } catch (err) {
      this.setState({ updatingCoords: false });
      store.set("toast", {
        message: err.message || "Update failed.",
        type: "error",
      });
    }
  }

  async _handleCreateBackup() {
    this.setState({ creatingBackup: true });
    try {
      await createBackup();
      store.set("toast", { message: "Backup created.", type: "success" });
      this._load();
    } catch (err) {
      store.set("toast", {
        message: err.message || "Backup failed.",
        type: "error",
      });
    } finally {
      this.setState({ creatingBackup: false });
    }
  }

  async _handleRestoreBackup(filename) {
    store.set("toast", { message: "Restoring backup\u2026", type: "info" });
    try {
      await restoreBackup(filename);
      store.set("toast", {
        message: "Backup restored. Reloading\u2026",
        type: "success",
      });
      setTimeout(() => location.reload(), 1500);
    } catch (err) {
      store.set("toast", {
        message: err.message || "Restore failed.",
        type: "error",
      });
    }
  }

  async _handleDeleteBackup(filename) {
    try {
      await deleteBackup(filename);
      store.set("toast", { message: "Backup deleted.", type: "success" });
      this._load();
    } catch (err) {
      store.set("toast", {
        message: err.message || "Delete failed.",
        type: "error",
      });
    }
  }

  async _handleDownloadOffline() {
    this.setState({
      downloadingOffline: true,
      offlineProgress: 0,
      offlineStatusText: "Fetching snapshot\u2026",
    });
    try {
      const data = await getOfflineSnapshot();
      this.setState({
        offlineProgress: 20,
        offlineStatusText: "Saving data\u2026",
      });

      await saveSnapshot(data);
      this.setState({
        offlineProgress: 40,
        offlineStatusText: "Caching images\u2026",
      });

      // Extract all image URLs from posts and media
      const images = new Set();
      data.posts.forEach((p) => {
        if (p.media_url) images.add(p.media_url);
        // Add thumbnails too
        if (p.media_url) images.add(p.media_url + "?thumb");
      });
      data.media.forEach((m) => {
        if (m.path) {
          images.add(m.path);
          images.add(m.path + "?thumb");
        }
      });

      const imageUrls = Array.from(images);
      await preCacheImages(imageUrls, (prog) => {
        this.setState({
          offlineProgress: 40 + prog * 0.6,
          offlineStatusText: `Caching images (${Math.round(prog * 100)}%)\u2026`,
        });
      });

      const lastSync = new Date().toISOString();
      await saveMeta("last_sync", lastSync);

      this.setState({
        downloadingOffline: false,
        lastSync,
        offlineStatusText: "",
      });
      store.set("toast", { message: "Offline data updated.", type: "success" });
    } catch (err) {
      console.error("[SystemPage] offline update error:", err);
      this.setState({ downloadingOffline: false });
      store.set("toast", { message: "Offline update failed.", type: "error" });
    }
  }

  async _handleResetSync() {
    try {
      await resetFailedOps();
      this._load();
      updateStatus();
    } catch (err) {
      store.set("toast", { message: "Failed to reset queue.", type: "error" });
    }
  }

  async _handleSyncNow() {
    try {
      await syncQueue();
      this._load();
    } catch (err) {
      /* already handled in syncQueue */
    }
  }

  async _handleStartImport() {
    this.setState({ igImporting: true });
    try {
      await triggerInstagramImport();
      this._startImportPoll();
    } catch (err) {
      this.setState({ igImporting: false });
      store.set("toast", {
        message: err.message || "Import failed to start.",
        type: "error",
      });
    }
  }

  _startImportPoll() {
    if (this._importPollTimer) return; // already polling
    this._importPollTimer = setInterval(async () => {
      try {
        const status = await getInstagramImportStatus();
        this.setState({ igImportStatus: status, igImporting: status.running });
        if (!status.running) {
          clearInterval(this._importPollTimer);
          this._importPollTimer = null;
          if (status.imported > 0) {
            store.set("toast", {
              message: `Import done: ${status.imported} imported, ${status.skipped} skipped.`,
              type: "success",
            });
          }
        }
      } catch (e) {
        /* silently ignore poll errors */
      }
    }, 2500);
  }

  _showConfirm(title, message, confirmText, variant, onConfirm) {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const dialog = new ConfirmDialog(mount, {
      title,
      message,
      confirmText,
      variant,
      onConfirm: () => {
        dialog.unmount();
        mount.remove();
        onConfirm();
      },
      onCancel: () => {
        dialog.unmount();
        mount.remove();
      },
    });
    dialog.mount();
  }
}
