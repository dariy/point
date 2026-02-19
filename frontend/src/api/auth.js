/**
 * Auth API — session login / logout / current user.
 *
 * Backend endpoints: POST /api/auth/login, POST /api/auth/logout,
 *                    GET  /api/auth/me
 */

import { api } from './client.js';

/**
 * Log in with username + password.
 * Returns the user object on success; throws ApiError on failure.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<object>}
 */
export function login(username, password) {
  const body = new URLSearchParams({ username, password });
  return api.request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
}

/**
 * Log out the current session.
 * @returns {Promise<null>}
 */
export function logout() {
  return api.post('/api/auth/logout');
}

/**
 * Return the currently authenticated user, or null if not authenticated.
 * Does NOT throw on 401 — returns null instead.
 *
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
