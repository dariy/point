/**
 * Auth API — session login / logout / current user / sessions / password.
 *
 * Backend prefix: /api/auth
 *
 * Note: The backend LoginRequest schema uses `name` as the password field
 * (deliberate naming obfuscation in the schema). We normalize this here.
 */

import { api } from './client.js';

/**
 * Log in. `username` may be omitted for single-user blogs.
 *
 * @param {string|null} username
 * @param {string} password
 * @param {boolean} [rememberMe]
 * @returns {Promise<{ message: string, user: object }>}
 */
export function login(username, password, rememberMe = false) {
  return api.post('/api/auth/login', {
    username: username || null,
    name: password,
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
export function changePassword(currentPassword, newPassword) {
  return api.post('/api/auth/change-password', {
    current_name: currentPassword,
    new_name: newPassword,
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
