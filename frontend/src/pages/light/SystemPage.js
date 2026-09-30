/**
 * SystemPage — system administration (cache, map data, disk, migrations).
 *
 * Offline data and the pending sync queue moved to the offline-sync plugin's
 * settings drawer on /light/plugins.
 *
 * Fetches: GET /api/system/*
 */

import { Component } from "../../components/Component.js";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog.js";
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
  getHealth,
  getJobs,
  retryJob,
  clearFailedJobs,
} from "../../api/system.js";
import { setToast } from "../../store.js";
import { html, raw } from "../../utils/helpers.js";
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
      health: null, // { tasks, degraded, uptime } from /api/system/health
    };
  }

  render() {
    return adminLayoutTemplate({
      title: "System",
      content: this._renderContent(),
    });
  }

  _renderContent() {
    const { loading, error, migrations, updatingCoords, coordsResult, diskInfo, migrationsCollapsed, auditingLinks, linkAudit, health, jobs } =
      this.state;

    if (loading)
      return html`<div class="loading-spinner" aria-label="Loading system info…"></div>`;
    if (error)
      return html`<p class="error-state" role="alert">${error}</p>`;

    const diskSection = diskInfo ? this._renderDiskSection(diskInfo) : "";
    const healthSection = this._renderHealthSection(health);
    const jobsSection = this._renderJobsSection(jobs);

    return html`
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
            ${coordsResult ? html`<p class="system-msg success">${coordsResult}</p>` : ""}
          </div>
        </section>

        ${diskSection}

        ${healthSection}
        ${jobsSection}

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
            ${raw(CHEVRON)}
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
                      (m) => html`
                    <tr>
                      <td>${m.name}</td>
                      <td class="text-right">${m.applied_at ? new Date(m.applied_at).toLocaleString() : html`<span class="text-muted">Pending</span>`}</td>
                    </tr>
                  `,
                    )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>`;
  }

  /**
   * Background-job health. Answers "is anything quietly broken" — before this
   * a failing scheduled task was only visible by reading the server log.
   * @param {Awaited<ReturnType<typeof getHealth>>|null} health
   */
  _renderHealthSection(health) {
    if (!health) return '';

    const rows = (health.tasks || [])
      .map((t) => {
        const state = t.healthy
          ? html`<span class="badge badge-success">OK</span>`
          : html`<span class="badge badge-danger">Failing</span>`;
        const err = t.last_error
          ? html`<div class="job-health-error">${t.last_error}</div>`
          : "";
        return html`
          <tr>
            <td>${t.name}${err}</td>
            <td>${state}</td>
            <td>${this._ago(t.last_run)}</td>
            <td>${this._ago(t.last_success)}</td>
            <td>${t.failures || 0} / ${t.runs || 0}</td>
          </tr>`;
      });

    // No rows is the normal state moments after a restart, not an error.
    const body = rows.length
      ? html`<table class="table">
           <thead>
             <tr><th>Job</th><th>State</th><th>Last run</th><th>Last success</th><th>Failures</th></tr>
           </thead>
           <tbody>${rows}</tbody>
         </table>`
      : html`<p>No background jobs have reported yet.</p>`;

    const summary =
      health.degraded > 0
        ? html`<p class="error-state" role="alert">${health.degraded} job${health.degraded === 1 ? "" : "s"} failing.</p>`
        : "";

    return html`
      <section class="card system-full-width">
        <div class="card-header"><h2>Background Jobs</h2></div>
        <div class="card-body">
          <p>Last outcome of each scheduled task, recorded since the server started ${this._ago(new Date(Date.now() - (health.uptime || 0) * 1000).toISOString())}. Restarting clears this.</p>
          ${summary}
          ${body}
        </div>
      </section>`;
  }

  /**
   * The durable job queue. Unlike the health section it survives a restart:
   * a job in backoff or failed after max_attempts is visible here.
   * @param {Awaited<ReturnType<typeof getJobs>>|null} jobs
   */
  _renderJobsSection(jobs) {
    if (!jobs) return "";
    const counts = jobs.counts || {};
    const countLine = ["queued", "running", "failed", "done"]
      .map((st) => `${st} ${counts[st] || 0}`)
      .join(" · ");

    const rows = (jobs.jobs || []).map((j) => {
      const refs = Object.entries(j.refs || {})
        .map(([k, v]) => `${k} ${v}`)
        .join(", ");
      const badge =
        j.state === "failed"
          ? html`<span class="badge badge-danger">Failed</span>`
          : html`<span class="badge">${j.state}</span>`;
      const err = j.last_error
        ? html`<div class="job-health-error">${j.last_error}</div>`
        : "";
      const retry =
        j.state === "failed"
          ? html`<button type="button" class="btn btn-secondary btn-sm" data-retry-job="${j.id}">Retry</button>`
          : "";
      return html`
        <tr>
          <td>${j.kind}${refs ? html` <small>(${refs})</small>` : ""}${err}</td>
          <td>${badge}</td>
          <td>${j.attempts} / ${j.max_attempts}</td>
          <td>${j.state === "queued" ? this._until(j.next_run_at) : "—"}</td>
          <td>${retry}</td>
        </tr>`;
    });

    const body = rows.length
      ? html`<table class="table">
           <thead>
             <tr><th>Job</th><th>State</th><th>Attempts</th><th>Next run</th><th></th></tr>
           </thead>
           <tbody>${rows}</tbody>
         </table>`
      : html`<p>No queued, running or failed jobs.</p>`;

    return html`
      <section class="card system-full-width">
        <div class="card-header">
          <h2>Job Queue</h2>
          ${counts.failed > 0
            ? html`<button type="button" class="btn btn-danger btn-sm" id="clear-failed-jobs-btn">Clear failed</button>`
            : ""}
        </div>
        <div class="card-body">
          <p>${countLine}</p>
          ${body}
        </div>
      </section>`;
  }

  /**
   * Render an ISO timestamp as a coarse time from now; a past time is "now".
   * @param {string|undefined} iso
   */
  _until(iso) {
    if (!iso) return "—";
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "—";
    const secs = Math.round((then - Date.now()) / 1000);
    if (secs <= 0) return "now";
    if (secs < 60) return `in ${secs}s`;
    if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
    if (secs < 86400) return `in ${Math.round(secs / 3600)}h`;
    return `in ${Math.round(secs / 86400)}d`;
  }

  /**
   * Render an ISO timestamp as a coarse relative age. Returns an em dash for a
   * missing value — "never run" must not render as an epoch date.
   * @param {string|undefined} iso
   */
  _ago(iso) {
    if (!iso) return "—";
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "—";
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
    return `${Math.round(secs / 86400)}d ago`;
  }

  _renderLinkAudit(audit) {
    if (!audit) return '';
    if (!audit.issues.length) {
      return html`<p class="system-msg success">No broken internal links — checked ${audit.scanned} public posts.</p>`;
    }
    return html`
      <p class="system-msg error" role="alert">${audit.issues.length} broken link${audit.issues.length === 1 ? "" : "s"} found (checked ${audit.scanned} public posts):</p>
      <div class="table-container">
        <table class="table">
          <thead>
            <tr><th>Post</th><th>Links to</th><th>Problem</th></tr>
          </thead>
          <tbody>
            ${audit.issues
              .map(
                (i) => html`
              <tr>
                <td><a href="/light/posts/${i.source_id}/edit">${i.source_title || i.source_slug}</a></td>
                <td><code>/posts/${i.target_slug}</code></td>
                <td>${i.reason}</td>
              </tr>
            `,
              )}
          </tbody>
        </table>
      </div>`;
  }

  _renderDiskSection(disk) {
    const usagePercent = Math.round((disk.used / disk.total) * 100);
    const barClass =
      usagePercent >= 90 ? "danger" : usagePercent >= 70 ? "warning" : "";
    return html`
      <section class="card">
        <div class="card-header"><h2>Disk Usage (Server)</h2></div>
        <div class="card-body">
          <p>
            ${formatFileSize(disk.used)} of ${formatFileSize(disk.total)} used (${usagePercent}%)
          </p>
          <div class="storage-bar">
            <div class="storage-bar-fill ${barClass}" style="width: ${usagePercent}%"></div>
          </div>
          <p class="form-hint" style="margin-top: var(--spacing-sm)">Path: <code>${disk.path}</code></p>
        </div>
      </section>`;
  }

  afterRender() {
    setupAdminLayout(this, {
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
    this.container
      .querySelector("#clear-failed-jobs-btn")
      ?.addEventListener("click", () => this._confirmClearFailedJobs());
    this.container.querySelectorAll("[data-retry-job]").forEach((btn) =>
      btn.addEventListener("click", () =>
        this._handleRetryJob(Number(btn.getAttribute("data-retry-job"))),
      ),
    );

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

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      // Health is best-effort: an older server without the endpoint, or a
      // transient failure, must not blank the whole page.
      const [migrations, diskInfo, health, jobs] = await Promise.all([
        getMigrations(),
        getDiskInfo(),
        getHealth().catch(() => null),
        getJobs().catch(() => null),
      ]);
      this.setState({
        loading: false,
        migrations: Array.isArray(migrations) ? migrations : [],
        diskInfo,
        health,
        jobs,
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

  async _handleRetryJob(id) {
    try {
      await retryJob(id);
      setToast({ message: "Job queued again.", type: "success" });
      const jobs = await getJobs().catch(() => this.state.jobs);
      this.setState({ jobs });
    } catch (err) {
      setToast({ message: "Could not retry job: " + (err.message || err), type: "error" });
    }
  }

  _confirmClearFailedJobs() {
    const n = this.state.jobs?.counts?.failed || 0;
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const dialog = new ConfirmDialog(mount, {
      title: "Clear failed jobs",
      message: `Remove ${n} failed job${n === 1 ? "" : "s"}? Their errors are lost.`,
      confirmText: "Clear failed",
      variant: "danger",
      onConfirm: () => { dialog.unmount(); mount.remove(); this._handleClearFailedJobs(); },
      onCancel: () => { dialog.unmount(); mount.remove(); },
    });
    dialog.mount();
  }

  async _handleClearFailedJobs() {
    try {
      const { deleted } = await clearFailedJobs();
      setToast({ message: `Removed ${deleted} failed job${deleted === 1 ? "" : "s"}.`, type: "success" });
    } catch (err) {
      setToast({ message: "Could not clear failed jobs: " + (err.message || err), type: "error" });
    }
    const jobs = await getJobs().catch(() => this.state.jobs);
    this.setState({ jobs });
  }

  async _handleClearCache() {
    try {
      await clearCache();
      setToast({ message: "Cache cleared.", type: "success" });
    } catch (err) {
      setToast({
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
      setToast({
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
      setToast({
        message: err.message || "Update failed.",
        type: "error",
      });
    }
  }
}
