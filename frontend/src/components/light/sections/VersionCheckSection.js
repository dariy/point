/**
 * VersionCheckSection — the settings block for the `version-check` plugin.
 *
 * The plugin's whole job happens invisibly: once a day it asks GitHub for the
 * newest tag and, if it is ahead of the running build, the dashboard grows an
 * update banner. When no banner appears there is nothing to distinguish "you're
 * up to date" from "the check never ran" or "GitHub refused us", which is what
 * this block exists to answer.
 *
 * It shows the running version, the newest upstream tag, and when that answer
 * was last obtained; "Check now" (POST /api/system/version/check) bypasses the
 * 24h cache so the admin can watch a real round-trip happen — and read the
 * error verbatim when it fails.
 */

import { Component } from "../../Component.js";
import { getVersion, checkVersionNow } from "../../../api/system.js";
import { setToast } from "../../../store.js";
import { html } from "../../../utils/helpers.js";
import { formatDatetime, isoDatetime } from "../../../utils/formatters.js";

export class VersionCheckSection extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, checking: false, info: null, error: null, justChecked: false };
  }

  render() {
    const { loading, checking, info, error, justChecked } = this.state;

    // Rendered flush inside the plugin drawer, which supplies the "Version
    // Check" title — no inner card header of its own (matching the passkeys,
    // backups and API-key sections).
    if (loading) return html`<div class="loading-spinner btn-sm"></div>`;
    if (error) return html`<p class="empty-state" role="alert">${error}</p>`;

    return html`
      <div class="version-headline">
        <span class="version-headline-label">Running</span>
        <code class="version-current">${info.current || "unknown"}</code>
      </div>
      ${this._renderVerdict(info)}
      <dl class="version-facts">
        <div class="version-fact">
          <dt>Latest upstream</dt>
          <dd>${info.latest ? html`<code>${info.latest}</code>` : html`<span class="version-unknown">not known yet</span>`}</dd>
        </div>
        <div class="version-fact">
          <dt>Last checked</dt>
          <dd>${
            info.checked_at
              ? html`<time datetime="${isoDatetime(info.checked_at)}">${formatDatetime(info.checked_at)}</time>`
              : html`<span class="version-unknown">never</span>`
          }</dd>
        </div>
      </dl>
      <div class="section-actions">
        <button id="version-check-now" class="btn btn-sm btn-primary" ${checking ? "disabled" : ""}>
          ${checking ? "Checking…" : "Check now"}
        </button>
        ${
          // "fetched" means this very request reached GitHub — worth saying once,
          // right after a manual check, since that round-trip is what was asked for.
          justChecked && info.fetched
            ? html`<span class="version-fresh">Answer came from GitHub just now.</span>`
            : ""
        }
      </div>
      <p class="version-check-hint">
        Checks <code>github.com/dariy/point</code> tags at most once a day, and shows a
        banner on the dashboard when a newer release exists. “Check now” skips that
        cache and calls out immediately.
      </p>`;
  }

  /** The one-line answer: broken, update available, unknown, or current. */
  _renderVerdict(info) {
    if (info.error) {
      return html`<p class="version-verdict is-error" role="alert">Check failed: ${info.error}</p>`;
    }
    if (info.update_available) {
      return html`<p class="version-verdict is-update">
        Point ${info.latest} is available. Update with <code>./update.sh</code>.
      </p>`;
    }
    if (!info.latest) {
      return html`<p class="version-verdict">No upstream version known yet — run a check.</p>`;
    }
    return html`<p class="version-verdict is-ok">You're running the latest release.</p>`;
  }

  afterRender() {
    this.$("#version-check-now")?.addEventListener("click", () => this._check());
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const info = await getVersion();
      this.setState({ loading: false, info, error: null });
    } catch (err) {
      console.error("[VersionCheckSection] load error:", err);
      this.setState({ loading: false, error: "Could not read version status." });
    }
  }

  async _check() {
    // Offline, the shared client would queue the POST for later instead of
    // answering — useless for a check whose whole value is the live round-trip.
    if (!navigator.onLine) {
      setToast({ message: "You're offline — cannot reach GitHub.", type: "error" });
      return;
    }
    this.setState({ checking: true });
    try {
      const info = await checkVersionNow();
      this.setState({ checking: false, info, error: null, justChecked: true });
      setToast({
        message: info.error
          ? `Check failed: ${info.error}`
          : info.update_available
            ? `Point ${info.latest} is available.`
            : "Checked — you're up to date.",
        type: info.error ? "error" : "success",
      });
    } catch (err) {
      this.setState({ checking: false });
      setToast({ message: err.message || "Version check failed.", type: "error" });
    }
  }
}
