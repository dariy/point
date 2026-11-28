/**
 * SystemPage — system administration (cache, map data, disk, migrations).
 *
 * Offline data and the pending sync queue moved to the offline-sync plugin's
 * settings drawer on /light/plugins.
 *
 * Fetches: GET /api/system/*
 */

import { Component } from "../../components/Component.ts";
import { ConfirmDialog } from "../../components/shared/ConfirmDialog.ts";
import {
  adminLayoutTemplate,
  setupAdminLayout,
} from "../../components/light/AdminLayout.ts";
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
  getPhotoLibraryStatus,
  getHealthChecks,
  refreshHealthChecks,
} from "../../api/system.ts";
import type { Migration, SiteHealthItem, SiteHealthReport, SiteHealthStatus, JobView } from "../../api/system.ts";
import { rebuildDerivatives } from "../../api/media.ts";
import { setToast } from "../../store.ts";
import { html, raw } from "../../utils/helpers.ts";
import { formatFileSize } from "../../utils/formatters.ts";

const CHEVRON = `<svg class="toggle-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

export default class SystemPage extends Component {
  /** The page scrolled to #health once; a re-render does not scroll again. */
  _scrolledToHealth = false;

  constructor(container: HTMLElement, props = {}) {
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
      checks: null, // SiteHealthReport from /api/system/health/checks
      checksRunning: false,
      rebuildingDerivatives: false,
      // Owner-only and only when PHOTO_LIBRARY_PATH is a readable directory.
      photoLibrary: null, // { configured, path }
    };
  }

  render() {
    return adminLayoutTemplate({
      title: "System",
      content: this._renderContent(),
    });
  }

  _renderContent() {
    const { loading, error, migrations, updatingCoords, coordsResult, diskInfo, migrationsCollapsed, auditingLinks, linkAudit, health, jobs, photoLibrary, checks } =
      this.state;

    if (loading)
      return html`<div class="loading-spinner" aria-label="Loading system info…"></div>`;
    if (error)
      return html`<p class="error-state" role="alert">${error}</p>`;

    const diskSection = diskInfo ? this._renderDiskSection(diskInfo) : "";

    return html`
      <div class="system-grid">
        <section id="health" class="system-health system-full-width" aria-labelledby="health-title">
          <h2 id="health-title" class="system-health-title">Health</h2>
          ${this._renderChecksSection(checks, jobs)}
          ${this._renderJobsSection(jobs)}
          ${this._renderHealthSection(health)}
          ${diskSection}
        </section>

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

        ${photoLibrary ? html`
        <section class="card" data-testid="photo-library-status">
          <div class="card-header"><h2>Photo Library</h2></div>
          <div class="card-body">
            <p>Connected. Set by <code>PHOTO_LIBRARY_PATH</code> in the server environment.</p>
            <p><code>${photoLibrary.path}</code></p>
          </div>
        </section>` : ""}

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
                      (m: Migration) => html`
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
   * The site health items: one row per check, each with its status and its
   * repair action. The failed jobs come first, from the job queue.
   */
  _renderChecksSection(report: SiteHealthReport | null, jobs: Awaited<ReturnType<typeof getJobs>> | null) {
    const { checksRunning } = this.state;
    const rows: unknown[] = [];
    const failedJob = this._renderFailedJobsItem(jobs);
    if (failedJob) rows.push(failedJob);
    for (const item of report?.items || []) rows.push(this._renderCheckItem(item));

    const checked = report
      ? html`<p class="health-checked">Checked ${this._ago(report.checked_at)}.</p>`
      : html`<p class="health-checked">The site checks are not available.</p>`;

    return html`
      <section class="card" data-testid="health-checks">
        <div class="card-header">
          <h3>Site checks</h3>
          <button type="button" class="btn btn-secondary btn-sm" id="run-health-checks-btn" ${checksRunning ? "disabled" : ""}>
            ${checksRunning ? "Checking…" : "Check now"}
          </button>
        </div>
        <div class="card-body">
          ${checked}
          ${rows.length ? html`<ul class="health-items">${rows}</ul>` : ""}
        </div>
      </section>`;
  }

  _renderFailedJobsItem(jobs: Awaited<ReturnType<typeof getJobs>> | null) {
    const failed = jobs?.counts?.failed || 0;
    if (!jobs) return "";
    if (!failed) {
      return this._healthRow("jobs", "ok", "Failed jobs", "No failed jobs.", "");
    }
    // The list is newest first, so the first failed job has the last error.
    const last = (jobs.jobs || []).find((j: JobView) => j.state === "failed");
    const text = html`${failed} failed job${failed === 1 ? "" : "s"}.${last?.last_error
      ? html`<div class="job-health-error">${last.kind}: ${last.last_error}</div>`
      : ""}`;
    const action = last
      ? html`<button type="button" class="btn btn-secondary btn-sm" data-retry-job="${last.id}">Retry job</button>`
      : "";
    return this._healthRow("jobs", "warn", "Failed jobs", text, action);
  }

  _renderCheckItem(item: SiteHealthItem) {
    const partial = item.partial
      ? html` <span class="health-partial">The check stopped at its time limit; the count is not complete.</span>`
      : "";
    const n = item.count || 0;
    const ids = item.ids || [];
    switch (item.key) {
      case "derivatives": {
        const text = item.status === "ok"
          ? html`All media have their derivatives.${partial}`
          : html`${n} media file${n === 1 ? " has" : "s have"} missing derivatives.${n > ids.length ? html` A rebuild repairs the first ${ids.length}.` : ""}${partial}`;
        const action = ids.length
          ? html`<button type="button" class="btn btn-secondary btn-sm" id="health-rebuild-btn" ${this.state.rebuildingDerivatives ? "disabled" : ""}>
              ${this.state.rebuildingDerivatives ? "Rebuilding…" : "Rebuild derivatives"}
            </button>`
          : "";
        return this._healthRow(item.key, item.status, "Derivatives", text, action);
      }
      case "originals": {
        const text = item.status === "ok"
          ? html`All original files are present.${partial}`
          : html`${n} media file${n === 1 ? " has" : "s have"} no original file. Restore the files from a backup.${ids.length ? html` <small>Media IDs: ${ids.slice(0, 20).join(", ")}${ids.length > 20 ? "…" : ""}</small>` : ""}${partial}`;
        return this._healthRow(item.key, item.status, "Originals", text, "");
      }
      case "references": {
        const samples = (item.samples || []).slice(0, 3);
        const text = item.status === "ok"
          ? html`No published post shows missing media.`
          : html`${n} published post${n === 1 ? " shows" : "s show"} missing media.${samples.length
            ? html`<div class="health-samples">${samples.map((p) => html`<code>${p}</code>`)}</div>`
            : ""}`;
        const shown = ids.slice(0, 5);
        const action = shown.length
          ? html`<span class="health-links">${shown.map((id) => html`<a class="btn btn-secondary btn-sm" href="/light/posts/${id}/edit">Open post ${id}</a>`)}</span>`
          : "";
        return this._healthRow(item.key, item.status, "Media in posts", text, action);
      }
      case "backup": {
        const text = item.at
          ? html`Last backup ${this._ago(item.at)}.${item.detail && item.status !== "ok" ? html` ${this._sentence(item.detail)}` : ""}`
          : html`${this._sentence(item.detail || "No backup exists.")}`;
        return this._healthRow(item.key, item.status, "Backup", text, this._enableBackupsAction(item));
      }
      case "restore_check": {
        const text = item.at
          ? html`Last restore check ${this._ago(item.at)}.${item.detail && item.status !== "ok" ? html` ${this._sentence(item.detail)}` : ""}`
          : html`${this._sentence(item.detail || "No restore check has run.")}`;
        return this._healthRow(item.key, item.status, "Restore check", text, this._enableBackupsAction(item));
      }
      case "storage": {
        const text = item.total_bytes
          ? html`${formatFileSize(item.free_bytes || 0)} free of ${formatFileSize(item.total_bytes)}.`
          : html`${this._sentence(item.detail || "Free storage cannot be read.")}`;
        return this._healthRow(item.key, item.status, "Storage", text, "");
      }
      default:
        return this._healthRow(String(item.key), item.status, String(item.key), html`${item.detail || ""}`, "");
    }
  }

  /**
   * The action of an `info` backup or restore check item: scheduled backups
   * are off. The link opens the backups plugin on the Plugins page.
   */
  _enableBackupsAction(item: SiteHealthItem) {
    return item.status === "info"
      ? html`<a class="btn btn-secondary btn-sm" data-enable-backups href="/light/plugins?plugin=backups">Enable backups</a>`
      : "";
  }

  _healthRow(key: string, status: SiteHealthStatus, label: string, text: unknown, action: unknown) {
    const badge = status === "fail"
      ? html`<span class="badge badge-danger">Fail</span>`
      : status === "warn"
        ? html`<span class="badge badge-warning">Warn</span>`
        : status === "info"
          ? html`<span class="badge badge-primary">Info</span>`
          : html`<span class="badge badge-success">OK</span>`;
    return html`
      <li class="health-item health-item--${status}" data-health-item="${key}" data-status="${status}">
        <div class="health-item-head">${badge}<strong>${label}</strong></div>
        <div class="health-item-text">${text}</div>
        ${action ? html`<div class="health-item-action">${action}</div>` : ""}
      </li>`;
  }

  /** Capitalise a server detail string and end it with a full stop. */
  _sentence(s: string) {
    const t = s.trim();
    if (!t) return "";
    const c = t[0].toUpperCase() + t.slice(1);
    return /[.!?]$/.test(c) ? c : c + ".";
  }

  /**
   * Background-job health. Answers "is anything quietly broken" — before this
   * a failing scheduled task was only visible by reading the server log.
   */
  _renderHealthSection(health: Awaited<ReturnType<typeof getHealth>> | null) {
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
      ? html`<div class="table-container"><table class="table">
           <thead>
             <tr><th>Job</th><th>State</th><th>Last run</th><th>Last success</th><th>Failures</th></tr>
           </thead>
           <tbody>${rows}</tbody>
         </table></div>`
      : html`<p>No background jobs have reported yet.</p>`;

    const summary =
      health.degraded > 0
        ? html`<p class="error-state" role="alert">${health.degraded} job${health.degraded === 1 ? "" : "s"} failing.</p>`
        : "";

    return html`
      <section class="card">
        <div class="card-header"><h3>Background Jobs</h3></div>
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
   */
  _renderJobsSection(jobs: Awaited<ReturnType<typeof getJobs>> | null) {
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
      ? html`<div class="table-container"><table class="table">
           <thead>
             <tr><th>Job</th><th>State</th><th>Attempts</th><th>Next run</th><th></th></tr>
           </thead>
           <tbody>${rows}</tbody>
         </table></div>`
      : html`<p>No queued, running or failed jobs.</p>`;

    return html`
      <section class="card" id="job-queue">
        <div class="card-header">
          <h3>Job Queue</h3>
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
   */
  _until(iso: string | undefined) {
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
   */
  _ago(iso: string | undefined) {
    if (!iso) return "—";
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return "—";
    const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
    if (secs < 60) return `${secs}s ago`;
    if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
    return `${Math.round(secs / 86400)}d ago`;
  }

  _renderLinkAudit(audit: Awaited<ReturnType<typeof auditPostLinks>> | null) {
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

  _renderDiskSection(disk: Awaited<ReturnType<typeof getDiskInfo>>) {
    const usagePercent = Math.round((disk.used / disk.total) * 100);
    const barClass =
      usagePercent >= 90 ? "danger" : usagePercent >= 70 ? "warning" : "";
    return html`
      <section class="card">
        <div class="card-header"><h3>Disk Usage (Server)</h3></div>
        <div class="card-body">
          <p>
            ${formatFileSize(disk.used)} of ${formatFileSize(disk.total)} used (${usagePercent}%)
          </p>
          <div class="storage-bar">
            <div class="storage-bar-fill ${barClass}" style="width: ${usagePercent}%"></div>
          </div>
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
    this.container
      .querySelector("#run-health-checks-btn")
      ?.addEventListener("click", () => this._handleRunChecks());
    this.container
      .querySelector("#health-rebuild-btn")
      ?.addEventListener("click", () => this._handleRebuildDerivatives());
    this.container.querySelectorAll("[data-retry-job]").forEach((btn) =>
      btn.addEventListener("click", () =>
        this._handleRetryJob(Number(btn.getAttribute("data-retry-job"))),
      ),
    );

    // The dashboard dot links to /light/system#health. Scroll once, after the
    // first render with data; a later re-render must not move the page.
    if (location.hash === "#health" && !this._scrolledToHealth) {
      this._scrolledToHealth = true;
      this.$("#health")?.scrollIntoView({ block: "start" });
    }

    // Collapse/expand the Database Migrations card (persisted across re-renders).
    const header = this.container.querySelector<HTMLElement>('[data-collapsible="migrations"] .card-header');
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
      const [migrations, diskInfo, health, jobs, photoLibrary, checks] = await Promise.all([
        getMigrations(),
        getDiskInfo(),
        getHealth().catch(() => null),
        getJobs().catch(() => null),
        getPhotoLibraryStatus(),
        getHealthChecks().catch(() => null),
      ]);
      this.setState({
        loading: false,
        migrations: Array.isArray(migrations) ? migrations : [],
        diskInfo,
        health,
        jobs,
        photoLibrary,
        checks,
        error: null,
      });
    } catch (err) {
      console.error("[SystemPage] load error:", err);
      this.setState({
        loading: false,
        error:
          "Could not load system information: " +
          ((err as Error).message || String(err) || JSON.stringify(err)),
      });
    }
  }

  async _handleRetryJob(id: number) {
    try {
      await retryJob(id);
      setToast({ message: "Job queued again.", type: "success" });
      const jobs = await getJobs().catch(() => this.state.jobs);
      this.setState({ jobs });
    } catch (err) {
      setToast({ message: "Could not retry job: " + ((err as Error).message || err), type: "error" });
    }
  }

  async _handleRunChecks() {
    this.setState({ checksRunning: true });
    try {
      const checks = await refreshHealthChecks();
      this.setState({ checksRunning: false, checks });
    } catch (err) {
      this.setState({ checksRunning: false });
      setToast({ message: "Could not run the checks: " + ((err as Error).message || err), type: "error" });
    }
  }

  /**
   * Rebuild the derivatives of the listed media only (the ids of the
   * derivatives item, at most 100), then run the checks again to show the
   * result. A video stays listed until its jobs finish.
   */
  async _handleRebuildDerivatives() {
    const item = (this.state.checks as SiteHealthReport | null)?.items
      .find((i) => i.key === "derivatives");
    const ids = item?.ids || [];
    if (!ids.length) return;
    this.setState({ rebuildingDerivatives: true });
    try {
      const r = await rebuildDerivatives(ids);
      const failed = r.failed?.length || 0;
      const parts = [`Rebuilt ${r.rebuilt}`];
      if (r.video_jobs) parts.push(`queued ${r.video_jobs} video job${r.video_jobs === 1 ? "" : "s"}`);
      if (failed) parts.push(`${failed} failed`);
      setToast({ message: parts.join(", ") + ".", type: failed ? "error" : "success" });
    } catch (err) {
      setToast({ message: "Could not rebuild the derivatives: " + ((err as Error).message || err), type: "error" });
    }
    const checks = await refreshHealthChecks().catch(() => this.state.checks);
    this.setState({ rebuildingDerivatives: false, checks });
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
      setToast({ message: "Could not clear failed jobs: " + ((err as Error).message || err), type: "error" });
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
        message: (err as Error).message || "Failed to clear cache.",
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
        message: (err as Error).message || "Link audit failed.",
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
        message: (err as Error).message || "Update failed.",
        type: "error",
      });
    }
  }
}
