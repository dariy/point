/**
 * InstagramImportSection — the "Instagram Import" block for the `instagram`
 * plugin. Self-loads connection + import status, triggers an import and polls
 * progress. Extracted from SystemPage into the plugin settings drawer.
 *
 * When Instagram isn't connected it shows a hint pointing at the connection
 * controls that live in the same drawer's settings form.
 */

import { Component } from "../../Component.js";
import {
  getInstagramStatus,
  triggerInstagramImport,
  getInstagramImportStatus,
} from "../../../api/instagram.js";
import { store } from "../../../store.js";
import { escapeHtml } from "../../../utils/helpers.js";
import { formatDateShort } from "../../../utils/formatters.js";

export class InstagramImportSection extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      connected: false,
      importStatus: null,
      importing: false,
    };
  }

  render() {
    const { loading, connected, importStatus, importing } = this.state;

    let body;
    if (loading) {
      body = '<div class="loading-spinner btn-sm"></div>';
    } else if (!connected) {
      body = `<p class="text-muted">Connect Instagram above to import your posts.</p>`;
    } else {
      const running = importStatus?.running || importing;
      const btnLabel = running ? "Importing…" : "Import / Sync Now";
      body = `
        <p>Import all Instagram posts into Point as drafts. Already-imported posts are skipped (idempotent).</p>
        <button id="ig-import-btn" class="btn btn-secondary" ${running ? "disabled" : ""}>${btnLabel}</button>
        ${this._statusHtml(importStatus, running)}`;
    }

    return `
      <section class="card">
        <div class="card-header"><h2>Instagram Import</h2></div>
        <div class="card-body">${body}</div>
      </section>`;
  }

  _statusHtml(status, running) {
    if (!status) return "";
    if (running && status.progress) {
      const p = status.progress;
      const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0;
      return `
        <div class="progress-container" style="margin-top:var(--spacing-sm)">
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
          <p class="progress-text">${p.done}/${p.total} — imported: ${p.imported}, skipped: ${p.skipped}, errors: ${p.errors}</p>
        </div>`;
    }
    if (running) return "";

    const parts = [];
    if (status.imported !== undefined) parts.push(`Imported: ${status.imported}`);
    if (status.skipped !== undefined) parts.push(`Skipped: ${status.skipped}`);
    if (status.errors !== undefined) parts.push(`Errors: ${status.errors}`);
    if (status.finished_at) parts.push(`Last run: ${formatDateShort(status.finished_at)}`);

    let html = parts.length ? `<p class="system-msg">${escapeHtml(parts.join(" · "))}</p>` : "";
    if (status.error) html += `<p class="system-msg error">${escapeHtml(status.error)}</p>`;
    if (Array.isArray(status.messages) && status.messages.length) {
      const items = status.messages.map((m) => `<li>${escapeHtml(m)}</li>`).join("");
      html += `
        <details class="ig-import-details">
          <summary>${status.messages.length} message${status.messages.length === 1 ? "" : "s"}</summary>
          <ul class="ig-import-messages">${items}</ul>
        </details>`;
    }
    return html;
  }

  afterRender() {
    this.$("#ig-import-btn")?.addEventListener("click", () => this._handleStart());
  }

  beforeUnmount() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const status = await getInstagramStatus().catch(() => null);
      const connected = status?.connected || false;
      let importStatus = null;
      if (connected) importStatus = await getInstagramImportStatus().catch(() => null);
      this.setState({ loading: false, connected, importStatus, importing: !!importStatus?.running });
      if (importStatus?.running) this._startPoll();
    } catch (err) {
      this.setState({ loading: false });
    }
  }

  async _handleStart() {
    this.setState({ importing: true });
    try {
      await triggerInstagramImport();
      this._startPoll();
    } catch (err) {
      this.setState({ importing: false });
      store.set("toast", { message: err.message || "Import failed to start.", type: "error" });
    }
  }

  _startPoll() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      try {
        const status = await getInstagramImportStatus();
        this.setState({ importStatus: status, importing: status.running });
        if (!status.running) {
          clearInterval(this._pollTimer);
          this._pollTimer = null;
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
}
