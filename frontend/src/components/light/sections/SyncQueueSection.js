/**
 * SyncQueueSection — the "Pending Sync Queue" block for the `offline-sync`
 * plugin. Lists queued offline mutations and lets the admin retry failed ones or
 * sync now. Extracted from SystemPage into the plugin settings drawer.
 */

import { Component } from "../../Component.js";
import { getQueue, resetFailedOps, updateStatus } from "../../../utils/mutationQueue.js";
import { syncQueue } from "../../../utils/sync.js";
import { store } from "../../../store.js";
import { html, raw } from "../../../utils/helpers.js";
import { formatDateShort } from "../../../utils/formatters.js";
import { WARNING_SVG } from "../../../utils/icons.js";

export class SyncQueueSection extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, queue: [] };
  }

  render() {
    const { loading, queue } = this.state;
    const failedCount = queue.filter((op) => op.failed).length;
    const pendingCount = queue.filter((op) => !op.failed).length;

    let rows;
    if (loading) {
      rows = html`<div class="loading-spinner btn-sm"></div>`;
    } else if (!queue.length) {
      rows = html`<p class="empty-state">No pending operations.</p>`;
    } else {
      rows = queue
        .map((op) => {
          const icon = op.failed ? raw(WARNING_SVG) : "●";
          const statusCls = op.failed ? "status-failed" : "status-pending";
          return html`
          <div class="sync-queue-item ${statusCls}">
            <span class="sync-icon">${icon}</span>
            <div class="sync-details">
              <div class="sync-op"><strong>${op.method}</strong> ${op.url}</div>
              ${op.error ? html`<div class="sync-error">${op.error}</div>` : ""}
            </div>
            <div class="sync-meta">${formatDateShort(op.timestamp)}</div>
          </div>`;
        });
    }

    return html`
      <section class="card">
        <div class="card-header">
          <h2>Pending Sync Queue</h2>
          <div class="header-actions">
            ${failedCount > 0 ? html`<button id="reset-sync-btn" class="btn btn-sm btn-secondary">Retry Failed</button>` : ""}
            ${pendingCount > 0 ? html`<button id="sync-now-btn" class="btn btn-sm btn-primary">Sync Now</button>` : ""}
          </div>
        </div>
        <div class="card-body">
          <div class="sync-queue-list">${rows}</div>
        </div>
      </section>`;
  }

  afterRender() {
    this.$("#reset-sync-btn")?.addEventListener("click", () => this._handleReset());
    this.$("#sync-now-btn")?.addEventListener("click", () => this._handleSync());
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const queue = await getQueue().catch(() => []);
    this.setState({ loading: false, queue: Array.isArray(queue) ? queue : [] });
  }

  async _handleReset() {
    try {
      await resetFailedOps();
      this._load();
      updateStatus();
    } catch (_err) {
      store.set("toast", { message: "Failed to reset queue.", type: "error" });
    }
  }

  async _handleSync() {
    try {
      await syncQueue();
      this._load();
    } catch (_err) {
      /* already handled in syncQueue */
    }
  }
}
