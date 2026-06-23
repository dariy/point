/**
 * OfflineDataSection — the "Offline Data (Local)" block for the `offline-sync`
 * plugin. Shows local snapshot stats and downloads/caches a fresh snapshot.
 * Extracted from SystemPage into the plugin settings drawer.
 */

import { Component } from "../../Component.js";
import { getOfflineStats, getOfflineSnapshot } from "../../../api/offline.js";
import { saveSnapshot, saveMeta, getMeta } from "../../../utils/offlineStore.js";
import { preCacheImages } from "../../../utils/imageCache.js";
import { store } from "../../../store.js";
import { escapeHtml } from "../../../utils/helpers.js";
import { formatFileSize, formatDateShort } from "../../../utils/formatters.js";

export class OfflineDataSection extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      stats: null,
      downloading: false,
      progress: 0,
      statusText: "",
      lastSync: null,
    };
  }

  render() {
    const { loading, stats, downloading, progress, statusText, lastSync } = this.state;

    let body;
    if (loading) {
      body = '<div class="loading-spinner btn-sm"></div>';
    } else if (!stats) {
      body = '<p class="error-state">Could not load offline stats.</p>';
    } else {
      const syncText = lastSync ? `Last updated: ${formatDateShort(lastSync)}` : "Never updated";
      body = `
        <div class="offline-stats">
          <div class="stat-row"><span>Posts:</span> <strong>${stats.post_count}</strong></div>
          <div class="stat-row"><span>Media:</span> <strong>${stats.image_count}</strong> (${formatFileSize((stats.original_bytes || 0) + (stats.thumbnail_bytes || 0))})</div>
          <p class="form-hint">${syncText}</p>
        </div>
        <div class="offline-actions" style="margin-top: var(--spacing-md)">
          <button id="download-offline-btn" class="btn btn-primary" ${downloading ? "disabled" : ""}>
            ${downloading ? "Updating…" : "Update Offline Data"}
          </button>
        </div>
        ${
          downloading
            ? `
          <div class="progress-container" style="margin-top: var(--spacing-md)">
            <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>
            <p class="progress-text">${escapeHtml(statusText)} (${Math.round(progress)}%)</p>
          </div>`
            : ""
        }`;
    }

    return `
      <section class="card">
        <div class="card-header"><h2>Offline Data (Local)</h2></div>
        <div class="card-body">${body}</div>
      </section>`;
  }

  afterRender() {
    this.$("#download-offline-btn")?.addEventListener("click", () => this._handleDownload());
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const [stats, meta] = await Promise.all([getOfflineStats(), getMeta("last_sync")]);
      this.setState({ loading: false, stats, lastSync: meta || null });
    } catch (err) {
      this.setState({ loading: false, stats: null });
    }
  }

  async _handleDownload() {
    this.setState({ downloading: true, progress: 0, statusText: "Fetching snapshot…" });
    try {
      const data = await getOfflineSnapshot();
      this.setState({ progress: 20, statusText: "Saving data…" });

      await saveSnapshot(data);
      this.setState({ progress: 40, statusText: "Caching images…" });

      // Extract all image URLs from posts and media.
      const images = new Set();
      data.posts.forEach((p) => {
        if (p.media_url) {
          images.add(p.media_url);
          images.add(p.media_url + "?thumb");
        }
      });
      data.media.forEach((m) => {
        if (m.path) {
          images.add(m.path);
          images.add(m.path + "?thumb");
        }
      });

      await preCacheImages(Array.from(images), (prog) => {
        this.setState({
          progress: 40 + prog * 0.6,
          statusText: `Caching images (${Math.round(prog * 100)}%)…`,
        });
      });

      const lastSync = new Date().toISOString();
      await saveMeta("last_sync", lastSync);

      this.setState({ downloading: false, lastSync, statusText: "" });
      store.set("toast", { message: "Offline data updated.", type: "success" });
    } catch (err) {
      console.error("[OfflineDataSection] update error:", err);
      this.setState({ downloading: false });
      store.set("toast", { message: "Offline update failed.", type: "error" });
    }
  }
}
