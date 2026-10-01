/**
 * Auth API — session login / logout / current user / sessions / password.
 *
 * Backend prefix: /api/auth
 *
 * Note: The backend LoginRequest schema uses `name` as the password field
 * (deliberate naming obfuscation in the schema). We normalize this here.
 *
 * Passwords are SHA-256 hashed client-side before transmission. The server
 * stores bcrypt(sha256(password)), matching the legacy SSR behaviour.
 */

import { api } from './client.ts';

/** The signed-in user, as login, passkey login and /api/auth/me report them. */
export interface User {
  id: number;
  username: string;
  display_name: string;
  email: string;
}

/**
 * One signed-in session — ListSessions in api/internal/api/auth.go.
 * `ua_browser` and `ua_os` are parsed from `user_agent` server-side.
 */
export interface Session {
  id: number;
  ip_address: string;
  user_agent: string;
  ua_browser: string;
  ua_os: string;
  created_at: string;
  last_active_at: string;
  expires_at: string;
  /** The session making this request. */
  is_current: boolean;
}

/** An API key without its secret — apiKeyToResponse in api/internal/api/mappers.go. */
export interface ApiKey {
  id: number;
  user_id: number;
  name: string;
  /** The key's visible start, to tell keys apart. */
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * SHA-256 hash a string. Uses Web Crypto API when available (secure context),
 * falls back to a pure-JS implementation for plain-HTTP dev environments.
 *
 * @returns hex digest
 */
export async function sha256(value: string): Promise<string> {
  if (window.crypto?.subtle && window.TextEncoder) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // Pure-JS fallback for non-secure contexts (plain HTTP, non-localhost)
  function rightRotate(v, n) { return (v >>> n) | (v << (32 - n)); }
  const mp = Math.pow, mw = mp(2, 32);
  let ascii = value, result = '', words = [];
  const h = []; const k = [];
  let pc = 0; const ic = {};
  for (let c = 2; pc < 64; c++) {
    if (!ic[c]) {
      for (let i = 0; i < 313; i += c) ic[i] = c;
      h[pc] = (mp(c, 0.5) * mw) | 0;
      k[pc++] = (mp(c, 1/3) * mw) | 0;
    }
  }
  ascii += '\x80';
  while (ascii.length % 64 - 56) ascii += '\x00';
  for (let i = 0; i < ascii.length; i++) {
    const j = ascii.charCodeAt(i);
    if (j >> 8) return '';
    words[i >> 2] |= j << ((3 - i) % 4) * 8;
  }
  const abl = value.length * 8;
  words[words.length] = (abl / mw) | 0;
  words[words.length] = abl | 0;
  let hash = h.slice();
  for (let j = 0; j < words.length; j += 16) {
    const w = words.slice(j, j + 16);
    const oh = hash.slice();
    for (let i = 0; i < 64; i++) {
      const w15 = w[i-15], w2 = w[i-2];
      const [a, e] = [hash[0], hash[4]];
      const t1 = hash[7] + (rightRotate(e,6)^rightRotate(e,11)^rightRotate(e,25)) +
                 ((e & hash[5]) ^ (~e & hash[6])) + k[i] +
                 (w[i] = i < 16 ? w[i] : (w[i-16] + (rightRotate(w15,7)^rightRotate(w15,18)^(w15>>>3)) + w[i-7] + (rightRotate(w2,17)^rightRotate(w2,19)^(w2>>>10))) | 0);
      const t2 = (rightRotate(a,2)^rightRotate(a,13)^rightRotate(a,22)) + ((a&hash[1])^(a&hash[2])^(hash[1]&hash[2]));
      hash = [(t1+t2)|0, ...hash]; hash[4] = (hash[4]+t1)|0;
    }
    for (let i = 0; i < 8; i++) hash[i] = (hash[i]+oh[i])|0;
  }
  for (let i = 0; i < 8; i++)
    for (let j = 3; j+1; j--) { const b = (hash[i]>>(j*8))&255; result += (b<16?'0':'')+b.toString(16); }
  return result;
}

/** Log in. `username` may be omitted for single-user blogs. */
export async function login(
  username: string | null,
  password: string,
  rememberMe = false,
): Promise<{ message: string, user: User }> {
  return api.post('/api/auth/login', {
    username: username || null,
    name: await sha256(password),
    remember_me: rememberMe,
  });
}

export function logout(): Promise<null> {
  return api.post('/api/auth/logout');
}

/** Return the current user, or null if unauthenticated. */
export async function getMe(): Promise<User | null> {
  try {
    return await api.get('/api/auth/me');
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

/** Change the current user's password. */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ message: string }> {
  return api.post('/api/auth/change-password', {
    current_name: await sha256(currentPassword),
    new_name: await sha256(newPassword),
  });
}

/** Change the current user's email (where password-reset links go). */
export async function changeEmail(
  currentPassword: string,
  email: string,
): Promise<{ message: string }> {
  return api.post('/api/auth/change-email', {
    current_name: await sha256(currentPassword),
    email,
  });
}

/** List active sessions. */
export function getSessions(): Promise<{ sessions: Session[], total: number }> {
  return api.get('/api/auth/sessions');
}

/** Terminate a specific session. */
export function deleteSession(sessionId: number): Promise<{ message: string }> {
  return api.delete(`/api/auth/sessions/${sessionId}`);
}

/** Terminate all other sessions (keep current). */
export function deleteAllOtherSessions(): Promise<{ message: string }> {
  return api.delete('/api/auth/sessions');
}

// ── WebAuthn / Passkey ────────────────────────────────────────────────────────

function base64urlToBuffer(base64url: string): ArrayBuffer {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
  return buf.buffer;
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function prepareCreationOptions(json) {
  const pk = json.publicKey;
  pk.challenge = base64urlToBuffer(pk.challenge);
  pk.user.id = base64urlToBuffer(pk.user.id);
  if (pk.excludeCredentials) {
    pk.excludeCredentials = pk.excludeCredentials.map(c => ({ ...c, id: base64urlToBuffer(c.id) }));
  }
  return pk;
}

function prepareRequestOptions(json) {
  const pk = json.publicKey;
  pk.challenge = base64urlToBuffer(pk.challenge);
  if (pk.allowCredentials) {
    pk.allowCredentials = pk.allowCredentials.map(c => ({ ...c, id: base64urlToBuffer(c.id) }));
  }
  return pk;
}

function serializeCredential(cred) {
  const res: {
    id: string;
    rawId: string;
    type: string;
    response: Record<string, string>;
  } = {
    id: cred.id,
    rawId: bufferToBase64url(cred.rawId),
    type: cred.type,
    response: {
      clientDataJSON: bufferToBase64url(cred.response.clientDataJSON),
    },
  };
  if (cred.response.attestationObject !== undefined) {
    res.response.attestationObject = bufferToBase64url(cred.response.attestationObject);
  }
  if (cred.response.authenticatorData !== undefined) {
    res.response.authenticatorData = bufferToBase64url(cred.response.authenticatorData);
  }
  if (cred.response.signature !== undefined) {
    res.response.signature = bufferToBase64url(cred.response.signature);
  }
  if (cred.response.userHandle) {
    res.response.userHandle = bufferToBase64url(cred.response.userHandle);
  }
  return res;
}

export function getPasskeyStatus(): Promise<{ has_passkey: boolean, configured: boolean }> {
  return api.get('/api/auth/webauthn/status');
}

/** Full registration ceremony: begin → browser → finish. */
export async function registerPasskey(): Promise<void> {
  const options = await api.post('/api/auth/webauthn/register/begin');
  const publicKey = prepareCreationOptions(options);
  const credential = await navigator.credentials.create({ publicKey });
  await api.post('/api/auth/webauthn/register/finish', serializeCredential(credential));
}

/** Full login ceremony: begin → browser → finish. */
export async function loginWithPasskey(): Promise<{ message: string, user: User }> {
  const options = await api.post('/api/auth/webauthn/login/begin');
  const publicKey = prepareRequestOptions(options);
  const assertion = await navigator.credentials.get({ publicKey });
  return api.post('/api/auth/webauthn/login/finish', serializeCredential(assertion));
}

/** Remove the registered passkey for the current user. */
export function deletePasskey() {
  return api.delete('/api/auth/webauthn/credential');
}

// ── API Keys ──────────────────────────────────────────────────────────────

/** List API keys for the current user. */
export function getApiKeys(): Promise<{ api_keys: ApiKey[], total: number }> {
  return api.get('/api/auth/api-keys');
}

/**
 * Create a new API key.
 *
 * @param expiresAt - ISO string
 * @returns `raw_key` is the secret, returned this once.
 */
export function createApiKey(
  name: string,
  expiresAt: string | null = null,
): Promise<{ api_key: ApiKey, raw_key: string }> {
  return api.post('/api/auth/api-keys', { name, expires_at: expiresAt });
}

/** Revoke an API key. */
export function revokeApiKey(id: number): Promise<void> {
  return api.post(`/api/auth/api-keys/${id}/revoke`);
}

/** Delete an API key record. */
export function deleteApiKey(id: number): Promise<void> {
  return api.delete(`/api/auth/api-keys/${id}`);
}

// ── Connected OAuth apps (MCP) ────────────────────────────────────────────────

/** A connected MCP OAuth client — oauthClientResponse in api/internal/mcp/server.go. */
export interface OAuthClient {
  client_id: string;
  /** where the app receives its codes */
  redirect_hosts: string[];
  registered_at: string;
  live_tokens: number;
}

/** List connected OAuth clients. 404 when the mcp plugin is off. */
export function getOAuthClients(): Promise<{ clients: OAuthClient[] }> {
  return api.get('/api/auth/oauth-clients');
}

/** Revoke a connected OAuth client and every token issued to it. */
export function revokeOAuthClient(clientId: string): Promise<void> {
  return api.delete(`/api/auth/oauth-clients/${encodeURIComponent(clientId)}`);
}
