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

import { api } from './client.js';

/**
 * SHA-256 hash a string. Uses Web Crypto API when available (secure context),
 * falls back to a pure-JS implementation for plain-HTTP dev environments.
 *
 * @param {string} value
 * @returns {Promise<string>} hex digest
 */
async function sha256(value) {
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

/**
 * Log in. `username` may be omitted for single-user blogs.
 *
 * @param {string|null} username
 * @param {string} password
 * @param {boolean} [rememberMe]
 * @returns {Promise<{ message: string, user: object }>}
 */
export async function login(username, password, rememberMe = false) {
  return api.post('/api/auth/login', {
    username: username || null,
    name: await sha256(password),
    remember_me: rememberMe,
  });
}

/** @returns {Promise<null>} */
export function logout() {
  return api.post('/api/auth/logout');
}

/**
 * Return the current user, or null if unauthenticated.
 * @returns {Promise<object|null>}
 */
export async function getMe() {
  try {
    return await api.get('/api/auth/me');
  } catch (err) {
    if (err.status === 401) return null;
    throw err;
  }
}

/**
 * Change the current user's password.
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<{ message: string }>}
 */
export async function changePassword(currentPassword, newPassword) {
  return api.post('/api/auth/change-password', {
    current_name: await sha256(currentPassword),
    new_name: await sha256(newPassword),
  });
}

/**
 * List active sessions.
 * @returns {Promise<{ sessions: object[], total: number }>}
 */
export function getSessions() {
  return api.get('/api/auth/sessions');
}

/**
 * Terminate a specific session.
 * @param {number} sessionId
 * @returns {Promise<{ message: string }>}
 */
export function deleteSession(sessionId) {
  return api.delete(`/api/auth/sessions/${sessionId}`);
}

/**
 * Terminate all other sessions (keep current).
 * @returns {Promise<{ message: string }>}
 */
export function deleteAllOtherSessions() {
  return api.delete('/api/auth/sessions');
}
