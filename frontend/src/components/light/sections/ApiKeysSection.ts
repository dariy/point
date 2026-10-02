/**
 * ApiKeysSection — the API-keys block for the `api-keys` plugin. Self-loads the
 * key list and handles create (shows the secret once) / delete. Extracted from
 * SecurityPage into the plugin settings drawer.
 *
 * It also lists the MCP OAuth clients (connected apps), each with a Revoke
 * button. That list is empty and hidden when the mcp plugin is off.
 */

import { Component } from "../../Component.ts";
import { getApiKeys, createApiKey, deleteApiKey, getOAuthClients, revokeOAuthClient } from "../../../api/auth.ts";
import type { ApiKey, OAuthClient } from "../../../api/auth.ts";
import { setToast } from "../../../store.ts";
import { html } from "../../../utils/helpers.ts";
import { formatDateShort } from "../../../utils/formatters.ts";
import { showConfirm, showPrompt } from "../../../utils/dialogs.ts";

export class ApiKeysSection extends Component {
  constructor(container: HTMLElement, props: object = {}) {
    super(container, props);
    this.state = { loading: true, apiKeys: [], oauthClients: [] };
  }

  render() {
    const { loading, apiKeys, oauthClients } = this.state;

    const list = loading
      ? html`<p class="empty-state">Loading…</p>`
      : !apiKeys.length
        ? html`<p class="empty-state">No API keys found.</p>`
        : html`
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
                    (k: ApiKey) => html`
                  <tr>
                    <td><strong>${k.name}</strong></td>
                    <td><code class="font-mono">${k.prefix}…</code></td>
                    <td>${formatDateShort(k.created_at)}</td>
                    <td class="text-right">
                      <button class="btn btn-sm btn-danger delete-api-key-btn" data-id="${k.id}" title="Delete">Delete</button>
                    </td>
                  </tr>`,
                  )}
              </tbody>
            </table>
          </div>`;

    // Rendered flush inside the plugin drawer, which supplies the "Api Keys" title.
    return html`
      <div class="section-actions">
        <span class="section-actions-spacer"></span>
        <button id="create-api-key-btn" class="btn btn-sm btn-primary">Create API Key</button>
      </div>
      ${list}
      ${this._renderOAuthClients(oauthClients)}`;
  }

  _renderOAuthClients(clients: OAuthClient[]) {
    if (!clients.length) return "";
    return html`
      <h3 class="section-subhead">Connected apps</h3>
      <div class="table-container">
        <table class="table">
          <thead>
            <tr>
              <th>Redirects to</th>
              <th>Connected</th>
              <th>Live tokens</th>
              <th class="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            ${clients.map(
              (c) => html`
              <tr>
                <td><strong>${(c.redirect_hosts || []).join(", ") || "—"}</strong></td>
                <td>${formatDateShort(c.registered_at)}</td>
                <td>${c.live_tokens}</td>
                <td class="text-right">
                  <button class="btn btn-sm btn-danger revoke-oauth-client-btn" data-id="${c.client_id}" title="Revoke">Revoke</button>
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>`;
  }

  afterRender() {
    this.$("#create-api-key-btn")?.addEventListener("click", () => this._handleCreate());
    this.$$(".delete-api-key-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._handleDelete(Number(btn.dataset.id)));
    });
    this.$$(".revoke-oauth-client-btn").forEach((btn) => {
      btn.addEventListener("click", () => this._handleRevokeClient(btn.dataset.id!));
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    const [apiKeys, oauth] = await Promise.all([
      getApiKeys().catch(() => ({ api_keys: [] })),
      // 404 while the mcp plugin is off: no connected apps to show.
      getOAuthClients().catch(() => ({ clients: [] })),
    ]);
    this.setState({ loading: false, apiKeys: apiKeys.api_keys || [], oauthClients: oauth.clients || [] });
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
            message: `Please copy your API key now. It will not be shown again:\n\n${result.raw_key}`,
            confirmText: "Copy to Clipboard",
            variant: "primary",
            onConfirm: () => navigator.clipboard.writeText(result.raw_key),
          });
          this._load();
        } catch (err) {
          setToast({ message: (err as Error).message || "Failed to create API key.", type: "error" });
        }
      },
    });
  }

  _handleDelete(id: number) {
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
          setToast({ message: (err as Error).message || "Failed to delete API key.", type: "error" });
        }
      },
    });
  }

  _handleRevokeClient(clientId: string) {
    showConfirm({
      title: "Revoke Connected App",
      message: "Revoke this app? Its tokens stop working now, and it must sign in again to reconnect.",
      confirmText: "Revoke",
      variant: "danger",
      onConfirm: async () => {
        try {
          await revokeOAuthClient(clientId);
          this._load();
        } catch (err) {
          setToast({ message: (err as Error).message || "Failed to revoke the app.", type: "error" });
        }
      },
    });
  }
}
