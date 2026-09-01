/**
 * AdminLayout — shared layout helpers for all /light pages.
 *
 * Provides a template function for render() and a setup function for afterRender().
 */

import { LightSidebar } from "./LightSidebar.js";
import { AdminBottomBar } from "./AdminBottomBar.js";
import { CommandPalette } from "./CommandPalette.js";
import { ShortcutHelp } from "./ShortcutHelp.js";
import { store } from "../../store.js";
import { syncQueue } from "../../utils/sync.js";
import { setupHeaderCompact } from "../../utils/headerCompact.js";
import { html, navigate, raw } from "../../utils/helpers.js";
import { EXTERNAL_LINK_SVG } from "../../utils/icons.js";

/**
 * Shared markup for admin pages, for use inside component.render().
 *
 * `title`, `actions`, `banner` and `content` are markup slots: pass html``
 * output. A plain string is escaped, which is the safe default — a page that
 * wants markup there says so with the tag.
 *
 * @returns {import('../../utils/helpers.js').RawHtml}
 */
export function adminLayoutTemplate({
  title = "Admin",
  actions = "",
  banner = "",
  content = "",
  contentClass = ""
}) {
  const offline = store.get("offline_status") || {};
  const autosave = store.get("autosave_status") || {};
  const syncPill = renderSyncPill(offline, autosave);
  return html`
    <div class="light-layout">
      <div id="sidebar-mount"></div>
      <div class="light-main">
        <header class="light-header">
          <div class="header-title-row">
            <h1>${title}</h1>
            ${syncPill}
          </div>
          <div class="header-actions">
            ${actions}
          </div>
        </header>
        ${banner}
        <main class="light-content${contentClass ? ` ${contentClass}` : ""}">${content}</main>
      </div>
      <div id="bottom-bar-mount"></div>
      <div id="command-palette-mount"></div>
      <div id="shortcut-help-mount"></div>
    </div>`;
}

/**
 * Shared behavior for admin pages.
 *
 * Call from component.afterRender() and ignore the return value: everything
 * acquired here is registered on the component's per-render cleanup list, so
 * the next re-render releases it. There is nothing for the caller to store or
 * to call from beforeUnmount() — it used to return a teardown closure, and
 * every page overwrote its handle on the next render without ever calling it,
 * which leaked an observer and two store subscriptions per setState().
 */
export function setupAdminLayout(component, {
  currentPath,
  publicUrl
}) {
  component.registerCleanup(setupHeaderCompact(component.$(".light-header")));
  // Public-site link — icon button pinned to the right edge of the header
  // actions. Deliberately a plain in-app link: the public site and the admin
  // are one SPA, so this is a route change, not a document load. Opening it in
  // a second tab (target="_blank") forked the session instead — the new tab got
  // its own copy of everything the app holds per document, so a setting just
  // changed in the admin (the active theme, most visibly) was not what the
  // visitor then looked at.
  const headerActions = component.$(".header-actions");
  if (headerActions) {
    headerActions.insertAdjacentHTML("beforeend", html`<a href="${publicUrl || "/"}" class="btn btn-secondary public-home-link" title="View public site" aria-label="View public site">${raw(EXTERNAL_LINK_SVG)}</a>`);
  }
  const onLogout = async () => {
    try {
      const {
        logout
      } = await import("../../api/auth.js");
      await logout();
    } catch {
      /* ignore */
    }
    store.set("user", null);
    // Hard navigation: drop all in-memory admin state and load a fresh public
    // document (with analytics restored for the now-guest), mirroring the
    // public-footer logout.
    window.location.assign("/");
  };
  component.mountChild(LightSidebar, "#sidebar-mount", {
    currentPath,
    publicUrl,
    user: store.get("user") || {},
    onLogout
  });
  component.mountChild(AdminBottomBar, "#bottom-bar-mount", {
    currentPath,
    publicUrl,
    onLogout
  });
  component.mountChild(CommandPalette, "#command-palette-mount");
  component.mountChild(ShortcutHelp, "#shortcut-help-mount");
  component.$("#sync-pill-btn")?.addEventListener("click", () => onSyncPillClick());
  component.subscribeStore(store, "offline_status", () => updateSyncPill(component));
  component.subscribeStore(store, "autosave_status", () => updateSyncPill(component));
}
function renderSyncPill(offline, autosave = {}) {
  let text = "";
  let cls = "sync-pill";
  if (autosave.status === "saving") {
    text = "Saving…";
    cls += " syncing";
  } else if (autosave.status === "failed") {
    text = "⚠ Save failed";
    cls += " failed";
  } else if (offline.syncing) {
    text = "⟳ Syncing…";
    cls += " syncing";
  } else if (offline.failed) {
    text = `⚠ ${offline.failed} failed`;
    cls += " failed";
  } else if (offline.pending) {
    text = `● ${offline.pending} pending`;
    cls += " pending";
  } else if (autosave.lastSaved) {
    const age = Math.round((Date.now() - autosave.lastSaved) / 1000);
    text = age < 5 ? "✓ Saved" : `✓ Saved ${age}s ago`;
    cls += " synced";
  } else if (offline.has_ops) {
    text = "✓ Synced";
    cls += " synced";
  } else {
    return "";
  }
  return html`<button class="${cls}" id="sync-pill-btn" type="button">${text}</button>`;
}
function onSyncPillClick() {
  const offline = store.get("offline_status") || {};
  const autosave = store.get("autosave_status") || {};
  if (autosave.status === "failed") {
    window.dispatchEvent(new CustomEvent("autosave:retry"));
  } else if (offline.failed) {
    navigate("/light/system");
  } else if (!offline.syncing && offline.pending) {
    syncQueue();
  }
}
function updateSyncPill(component) {
  const offline = store.get("offline_status") || {};
  const autosave = store.get("autosave_status") || {};
  const newPill = renderSyncPill(offline, autosave);
  const titleRow = component.$(".header-title-row");
  if (!titleRow) return;
  const existing = component.$(".sync-pill");
  if (existing) existing.remove();
  if (newPill) {
    titleRow.insertAdjacentHTML("beforeend", html`${raw(newPill)}`);
    component.$("#sync-pill-btn")?.addEventListener("click", () => onSyncPillClick());
  }
}