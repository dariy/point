/**
 * ApiKeysSection — the API-keys block for the `api-keys` plugin. Self-loads the
 * key list and handles create (shows the secret once) / delete. Extracted from
 * SecurityPage into the plugin settings drawer.
 */

import { Component } from "../../Component.js";
import { getApiKeys, createApiKey, deleteApiKey } from "../../../api/auth.js";
import { store } from "../../../store.js";
import { escapeHtml } from "../../../utils/helpers.js";
import { formatDateShort } from "../../../utils/formatters.js";
import { showConfirm, showPrompt } from "../../../utils/dialogs.js";

export class ApiKeysSection extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, apiKeys: [] };
  }

  render() {
    const { loading, apiKeys } = this.state;

    const list = loading
      ? '<p class="empty-state">Loading…</p>'
      : !apiKeys.length
        ? '<p class="empty-state">No API keys found.</p>'
        : `
          <div class="table-container">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Key Prefix</th>
                  <th>Created</th>
                  <th class="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                ${apiKeys
                  .map(
                    (k) => `
                  <tr>
                    <td><strong>${escapeHtml(k.name)}</strong></td>
                    <td><code class="font-mono">${escapeHtml(k.prefix)}…</code></td>
                    <td>${escapeHtml(formatDateShort(k.created_at))}</td>
                    <td class="text-right">
                      <button class="btn btn-sm btn-danger delete-api-key-btn" data-id="${k.id}" title="Delete">Delete</button>
                    </td>
                  </tr>`,
                  )
                  .join("")}
              </tbody>
            </table>
          </div>`;

    // Rendered flush inside the plugin drawer, which supplies the "Api Keys" title.
    return `
      <div class="section-actions">
        <span class="section-actions-spacer"></span>
        <button id="create-api-key-btn" class="btn btn-sm btn-primary">Create API Key</button>
      </div>
      ${list}`;
  }

  afterRender() {
    this.$("#create-api-key-btn")?.addEventListener("click", () => this._handleCreate());
    this.$$(".delete-api-key-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._handleDelete(btn.dataset.id));
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const apiKeys = await getApiKeys().catch(() => ({}));
    this.setState({ loading: false, apiKeys: apiKeys.keys || [] });
  }

  _handleCreate() {
    showPrompt({
      title: "Create API Key",
      message: "Enter a name for the new API key:",
      confirmText: "Create",
      onConfirm: async (name) => {
        if (!name) return;
        try {
          const result = await createApiKey(name);
          showConfirm({
            title: "API Key Created",
            message: `Please copy your API key now. It will not be shown again:\n\n${result.key}`,
            confirmText: "Copy to Clipboard",
            variant: "primary",
            onConfirm: () => navigator.clipboard.writeText(result.key),
          });
          this._load();
        } catch (err) {
          store.set("toast", { message: err.message || "Failed to create API key.", type: "error" });
        }
      },
    });
  }

  _handleDelete(id) {
    showConfirm({
      title: "Delete API Key",
      message: "Permanently delete this API key? Applications using it will lose access.",
      confirmText: "Delete",
      variant: "danger",
      onConfirm: async () => {
        try {
          await deleteApiKey(id);
          this._load();
        } catch (err) {
          store.set("toast", { message: err.message || "Failed to delete API key.", type: "error" });
        }
      },
    });
  }
}
