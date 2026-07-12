/**
 * SystemPage — system administration (cache, map data, disk, migrations).
 *
 * Offline data and the pending sync queue moved to the offline-sync plugin's
 * settings drawer on /light/plugins.
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
  getMigrations,
  updateMapCoords,
  getDiskInfo,
  auditPostLinks,
} from "../../api/system.js";
import { store } from "../../store.js";
import { escapeHtml } from "../../utils/helpers.js";
import { formatFileSize } from "../../utils/formatters.js";

const CHEVRON = `<svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

export default class SystemPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      migrations: [],
      updatingCoords: false,
      coordsResult: null,
      diskInfo: null,
      error: null,
      // Database Migrations is a low-traffic section — collapsed by default.
      migrationsCollapsed: true,
      auditingLinks: false,
      linkAudit: null, // { issues, scanned } after a scan
    };
  }

  render() {
    return adminLayoutTemplate({
      title: "System",
      content: this._renderContent(),
    });
  }

  _renderContent() {
    const { loading, error, migrations, updatingCoords, coordsResult, diskInfo, migrationsCollapsed, auditingLinks, linkAudit } =
      this.state;

    if (loading)
      return '<div class="loading-spinner" aria-label="Loading system info…"></div>';
    if (error)
      return `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;

    const diskSection = diskInfo ? this._renderDiskSection(diskInfo) : "";

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
              ${updatingCoords ? "Updating…" : "Update Map Coords"}
            </button>
            ${coordsResult ? `<p class="system-msg success">${escapeHtml(coordsResult)}</p>` : ""}
          </div>
        </section>

        ${diskSection}

        <section class="card system-full-width">
          <div class="card-header"><h2>Content Health</h2></div>
          <div class="card-body">
            <p>Scan published posts for internal links that anonymous visitors can't open (target missing, unpublished, or hidden by a hides-posts tag).</p>
            <button id="audit-links-btn" class="btn btn-secondary" ${auditingLinks ? "disabled" : ""}>
              ${auditingLinks ? "Scanning…" : "Check Internal Links"}
            </button>
            ${this._renderLinkAudit(linkAudit)}
          </div>
        </section>

        <section class="card system-full-width system-collapsible${migrationsCollapsed ? " collapsed" : ""}" data-collapsible="migrations">
          <div class="card-header" role="button" tabindex="0" aria-expanded="${migrationsCollapsed ? "false" : "true"}">
            <h2>Database Migrations</h2>
            ${CHEVRON}
          </div>
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

  _renderLinkAudit(audit) {
    if (!audit) return "";
    if (!audit.issues.length) {
      return `<p class="system-msg success">No broken internal links — checked ${audit.scanned} public posts.</p>`;
    }
    return `
      <p class="system-msg error" role="alert">${audit.issues.length} broken link${audit.issues.length === 1 ? "" : "s"} found (checked ${audit.scanned} public posts):</p>
      <div class="table-container">
        <table class="table">
          <thead>
            <tr><th>Post</th><th>Links to</th><th>Problem</th></tr>
          </thead>
          <tbody>
            ${audit.issues
              .map(
                (i) => `
              <tr>
                <td><a href="/light/posts/${i.source_id}/edit">${escapeHtml(i.source_title || i.source_slug)}</a></td>
                <td><code>/posts/${escapeHtml(i.target_slug)}</code></td>
                <td>${escapeHtml(i.reason)}</td>
              </tr>
            `,
              )
              .join("")}
          </tbody>
        </table>
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
      .querySelector("#audit-links-btn")
      ?.addEventListener("click", () => this._handleAuditLinks());

    // Collapse/expand the Database Migrations card (persisted across re-renders).
    const header = this.container.querySelector('[data-collapsible="migrations"] .card-header');
    const card = header?.closest('[data-collapsible="migrations"]');
    if (header && card) {
      const toggle = () => {
        const nowCollapsed = card.classList.toggle("collapsed");
        header.setAttribute("aria-expanded", String(!nowCollapsed));
        this.state.migrationsCollapsed = nowCollapsed;
      };
      header.addEventListener("click", toggle);
      header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      });
    }
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const [migrations, diskInfo] = await Promise.all([getMigrations(), getDiskInfo()]);
      this.setState({
        loading: false,
        migrations: Array.isArray(migrations) ? migrations : [],
        diskInfo,
        error: null,
      });
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

  async _handleAuditLinks() {
    this.setState({ auditingLinks: true });
    try {
      const linkAudit = await auditPostLinks();
      this.setState({ auditingLinks: false, linkAudit });
    } catch (err) {
      this.setState({ auditingLinks: false });
      store.set("toast", {
        message: err.message || "Link audit failed.",
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
}
