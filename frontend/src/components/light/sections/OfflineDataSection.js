/**
 * OfflineDataSection — the "Offline Data (Local)" block for the `offline-sync`
 * plugin. Shows local snapshot stats and downloads/caches a fresh snapshot.
 * Extracted from SystemPage into the plugin settings drawer.
 */

import { Component } from "../../Component.js";
import { getOfflineStats, getOfflineSnapshot } from "../../../api/offline.js";
import { saveSnapshot, saveMeta, getMeta } from "../../../utils/offlineStore.js";
import { preCacheImages, clearImageCache } from "../../../utils/imageCache.js";
import { thumbUrl } from "../../../utils/mediaUrl.js";
import { mediaTypeFromPath } from "../../../utils/postMedia.js";
import { setToast } from "../../../store.js";
import { html } from "../../../utils/helpers.js";
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
      body = html`<div class="loading-spinner btn-sm"></div>`;
    } else if (!stats) {
      body = html`<p class="error-state">Could not load offline stats.</p>`;
    } else {
      const syncText = lastSync ? `Last updated: ${formatDateShort(lastSync)}` : "Never updated";
      body = html`
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
            ? html`
          <div class="progress-container" style="margin-top: var(--spacing-md)">
            <div class="progress-bar"><div class="progress-fill" style="width: ${progress}%"></div></div>
            <p class="progress-text">${statusText} (${Math.round(progress)}%)</p>
          </div>`
            : ""
        }`;
    }

    return html`
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
    } catch (_err) {
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

      const { thumbs, originals } = this._imageUrls(data);

      // A rung's URL carries the generation token, so a thumbnail rebuild turns
      // every cached entry into a key nothing will ask for again. The service
      // worker keeps the image caches across its own updates and cannot read the
      // token anyway, so the refresh is all-or-nothing from here: drop both
      // caches, then fill them.
      await clearImageCache("all");

      const onImage = this._imageProgress(thumbs.length + originals.length);
      await preCacheImages(thumbs, "thumbnails", onImage);
      await preCacheImages(originals, "full", onImage);

      const lastSync = new Date().toISOString();
      await saveMeta("last_sync", lastSync);

      this.setState({ downloading: false, lastSync, statusText: "" });
      setToast({ message: "Offline data updated.", type: "success" });
    } catch (err) {
      console.error("[OfflineDataSection] update error:", err);
      this.setState({ downloading: false });
      setToast({ message: "Offline update failed.", type: "error" });
    }
  }

  /**
   * A per-image callback driving the bar over the 40–100% it has left.
   *
   * The count lives here rather than in preCacheImages because there are two
   * passes — one per cache — and each reports its own `completed` starting from
   * one. (The bar used to freeze at 40%: the callback was passed where the cache
   * name goes, so nothing ever reported, and the arithmetic behind it multiplied
   * a progress *object* by 0.6 and rendered NaN.)
   */
  _imageProgress(total) {
    let done = 0;
    let shownPct = -1;
    return () => {
      done++;
      const pct = total ? Math.round((done / total) * 100) : 100;
      // One setState per image would re-render this card hundreds of times for
      // a bar that only moves in whole percents.
      if (pct === shownPct) return;
      shownPct = pct;
      this.setState({
        progress: 40 + pct * 0.6,
        statusText: `Caching images (${pct}%)…`,
      });
    };
  }

  /**
   * The image URLs worth carrying offline, split by the cache they belong in.
   *
   * Not the whole ladder for everything: four rungs per image plus the original
   * multiplies the download several times over for variants most readers never
   * request. A post's cover gets 512 and 1024 — a card on a desktop and the same
   * card on a high-DPR phone; the media grid gets 256, the rung its cells ask
   * for. Everything else is served offline by the service worker's approximate
   * match: a neighbouring rung, slightly soft, rather than a hole.
   *
   * Originals ride along because that is what the viewer opens, and what the
   * size estimate above already counts — but only for images. `media_url` is
   * whatever the post leads with, so it can name a video, whose ladder rung is a
   * poster frame worth caching and whose original is a download nobody asked
   * for. Remote URLs are skipped entirely: `cache.add` cannot store an opaque
   * cross-origin response, and the service worker never sees those requests.
   */
  _imageUrls(data) {
    const thumbs = new Set();
    const originals = new Set();
    const local = (u) => typeof u === "string" && u.startsWith("/");

    (data.posts || []).forEach((p) => {
      if (!local(p.media_url)) return;
      if (mediaTypeFromPath(p.media_url) === "image") originals.add(p.media_url);
      thumbs.add(thumbUrl(p.media_url, 512));
      thumbs.add(thumbUrl(p.media_url, 1024));
    });
    (data.media || []).forEach((m) => {
      if (!local(m.path)) return;
      originals.add(m.path);
      thumbs.add(thumbUrl(m.path, 256));
    });

    return { thumbs: Array.from(thumbs), originals: Array.from(originals) };
  }
}
