/**
 * PasskeysSection — the WebAuthn passkey block for the `passkeys` plugin.
 * Self-loads passkey status and handles register/remove. Extracted from
 * SecurityPage into the plugin settings drawer.
 */

import { Component } from "../../Component.js";
import { getPasskeyStatus, registerPasskey, deletePasskey } from "../../../api/auth.js";
import { store } from "../../../store.js";
import { showConfirm } from "../../../utils/dialogs.js";

export class PasskeysSection extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      supported: typeof window.PublicKeyCredential !== "undefined",
      status: null,
      working: false,
    };
  }

  render() {
    const { loading, supported, status, working } = this.state;

    let body;
    if (!supported) {
      body = '<p class="text-muted">Passkeys are not supported by this browser.</p>';
    } else if (loading) {
      body = '<div class="loading-spinner btn-sm"></div>';
    } else if (!status?.configured) {
      body = '<p class="text-muted">Passkeys are not configured on this server.</p>';
    } else if (status?.registered) {
      body = `
        <div class="passkey-status success">
          <p>Passkey is registered.</p>
          <button id="delete-passkey-btn" class="btn btn-sm btn-danger" ${working ? "disabled" : ""}>Remove Passkey</button>
        </div>`;
    } else {
      body = `
        <p>Register a passkey for faster, more secure login.</p>
        <button id="register-passkey-btn" class="btn btn-primary" ${working ? "disabled" : ""}>Register Passkey</button>`;
    }

    return `
      <section class="card">
        <div class="card-header"><h2>Passkeys (WebAuthn)</h2></div>
        <div class="card-body">${body}</div>
      </section>`;
  }

  afterRender() {
    this.$("#register-passkey-btn")?.addEventListener("click", () => this._handleRegister());
    this.$("#delete-passkey-btn")?.addEventListener("click", () => this._handleDelete());
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    if (!this.state.supported) {
      this.setState({ loading: false });
      return;
    }
    const status = await getPasskeyStatus().catch(() => null);
    this.setState({ loading: false, status });
  }

  async _handleRegister() {
    this.setState({ working: true });
    try {
      await registerPasskey();
      store.set("toast", { message: "Passkey registered.", type: "success" });
      this._load();
    } catch (err) {
      if (err.name !== "NotAllowedError") {
        store.set("toast", { message: err.message || "Failed to register passkey.", type: "error" });
      }
    } finally {
      this.setState({ working: false });
    }
  }

  _handleDelete() {
    showConfirm({
      title: "Remove Passkey",
      message: "Remove passkey? You will need to use your password to login.",
      confirmText: "Remove",
      variant: "danger",
      onConfirm: async () => {
        this.setState({ working: true });
        try {
          await deletePasskey();
          store.set("toast", { message: "Passkey removed.", type: "success" });
          this._load();
        } catch (err) {
          store.set("toast", { message: err.message || "Failed to remove passkey.", type: "error" });
        } finally {
          this.setState({ working: false });
        }
      },
    });
  }
}
