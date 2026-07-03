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
import { navigate, escapeHtml } from "../../utils/helpers.js";
import { EXTERNAL_LINK_SVG } from "../../utils/icons.js";

/**
 * Shared HTML template for admin pages.
 * To be used inside component.render().
 */
export function adminLayoutTemplate({
  title = "Admin",
  actions = "",
  banner = "",
  content = "",
  contentClass = "",
}) {
  const offline = store.get("offline_status") || {};
  const autosave = store.get("autosave_status") || {};
  const syncPill = renderSyncPill(offline, autosave);

  return `
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
 * To be used inside component.afterRender().
 */
export function setupAdminLayout(component, { currentPath, publicUrl }) {
  component._cleanupHeaderCompact = setupHeaderCompact(
    component.$(".light-header"),
  );

  // Public-site link — icon button pinned to the right edge of the header actions.
  const headerActions = component.$(".header-actions");
  if (headerActions) {
    headerActions.insertAdjacentHTML(
      "beforeend",
      `<a href="${escapeHtml(publicUrl || "/")}" class="btn btn-secondary public-home-link" title="View public site" aria-label="View public site" target="_blank" rel="noopener" data-external>${EXTERNAL_LINK_SVG}</a>`,
    );
  }

  const onLogout = async () => {
    try {
      const { logout } = await import("../../api/auth.js");
      await logout();
    } catch {
      /* ignore */
    }
    store.set("user", null);
    navigate("/", { replace: true });
  };

  component.mountChild(LightSidebar, "#sidebar-mount", {
    currentPath,
    publicUrl,
    user: store.get("user") || {},
    onLogout,
  });

  component.mountChild(AdminBottomBar, "#bottom-bar-mount", {
    currentPath,
    publicUrl,
    onLogout,
  });

  component.mountChild(CommandPalette, "#command-palette-mount");
  component.mountChild(ShortcutHelp, "#shortcut-help-mount");

  component
    .$("#sync-pill-btn")
    ?.addEventListener("click", () => onSyncPillClick());

  const unsubOffline = store.subscribe("offline_status", () =>
    updateSyncPill(component),
  );
  const unsubAutosave = store.subscribe("autosave_status", () =>
    updateSyncPill(component),
  );

  return () => {
    unsubOffline();
    unsubAutosave();
    component._cleanupHeaderCompact?.();
  };
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

  return `<button class="${cls}" id="sync-pill-btn" type="button">${text}</button>`;
}

function onSyncPillClick() {
  const offline = store.get("offline_status") || {};
  const autosave = store.get("autosave_status") || {};

  if (autosave.status === "failed") {
    window.Point.emit("autosave:retry");
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
    titleRow.insertAdjacentHTML("beforeend", newPill);
    component
      .$("#sync-pill-btn")
      ?.addEventListener("click", () => onSyncPillClick());
  }
}
