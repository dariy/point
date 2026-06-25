/**
 * Base API client — thin fetch wrapper.
 *
 * All API modules import `api` from this module and call its methods.
 * Handles:
 *   - JSON serialisation / deserialisation
 *   - Cookie-based session credentials (credentials: 'include')
 *   - Uniform error objects with `status` and `message`
 *   - Global 401 → 'api:unauthorized' event (router can redirect to login)
 */

/**
 * @typedef {Object} ApiError
 * @property {number}  status   HTTP status code
 * @property {string}  message  Human-readable error message
 */

import { enqueue } from '../utils/mutationQueue.js';

class ApiClient {
  /**
   * @param {string} base  Base URL prefix for all requests (e.g. '')
   */
  constructor(base = '') {
    this._base = base;
  }

  // ── Core request method ───────────────────────────────────────────────────

  /**
   * Perform a fetch request, returning parsed JSON on success.
   * Throws a plain object `{ status, message }` on non-2xx responses.
   *
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<unknown>}
   */
  async request(path, init = {}) {
    const url = this._base + path;

    const opts = {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...init.headers,
      },
      ...init,
    };

    let response;
    try {
      response = await fetch(url, opts);
    } catch {
      throw { status: 0, message: 'Network error — check your connection.' };
    }

    if (response.status === 204) {
      return null;
    }

    // Try to parse JSON body for both success and error responses.
    let body;
    const ct = response.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    if (!response.ok) {
      // /api/auth/me and /api/auth/login expect 401 for guests/bad creds —
      // those are probes/forms, not a session that just expired, so they must
      // not trigger the global login overlay.
      if (
        response.status === 401 &&
        !path.includes('/api/auth/login') &&
        !path.includes('/api/auth/me')
      ) {
        window.dispatchEvent(new CustomEvent('api:unauthorized'));
      }
      const message =
        (body && typeof body === 'object' && (body.detail || body.message)) ||
        (typeof body === 'string' && body) ||
        `HTTP ${response.status}`;
      throw { status: response.status, message };
    }

    return body;
  }

  // ── Convenience methods ───────────────────────────────────────────────────

  /**
   * GET request.
   * @param {string} path
   * @param {Record<string,string|number|boolean>} [params]  Query parameters
   * @returns {Promise<unknown>}
   */
  get(path, params) {
    const url = params ? `${path}?${new URLSearchParams(params)}` : path;
    return this.request(url, { method: 'GET' });
  }

  /**
   * POST request with JSON body.
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<unknown>}
   */
  post(path, body) {
    if (!navigator.onLine && path.startsWith('/api/') && !path.includes('/auth/')) {
      return enqueue('POST', path, body);
    }
    return this.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * PUT request with JSON body.
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<unknown>}
   */
  put(path, body) {
    if (!navigator.onLine && path.startsWith('/api/')) {
      return enqueue('PUT', path, body);
    }
    return this.request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * PATCH request with JSON body.
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<unknown>}
   */
  patch(path, body) {
    if (!navigator.onLine && path.startsWith('/api/')) {
      return enqueue('PATCH', path, body);
    }
    return this.request(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  /**
   * DELETE request.
   * @param {string} path
   * @returns {Promise<null>}
   */
  delete(path) {
    if (!navigator.onLine && path.startsWith('/api/')) {
      return enqueue('DELETE', path);
    }
    return this.request(path, { method: 'DELETE' });
  }

  /**
   * POST with a FormData body (file uploads). No Content-Type header —
   * the browser sets the correct multipart boundary automatically.
   *
   * @param {string} path
   * @param {FormData} formData
   * @returns {Promise<unknown>}
   */
  upload(path, formData) {
    if (!navigator.onLine && path.startsWith('/api/')) {
      // For uploads, we expect a single 'file' field for now in offline mode
      const file = formData.get('file');
      return enqueue('POST', path, {}, file);
    }
    return this.request(path, {
      method: 'POST',
      body: formData,
    });
  }
}

/** Singleton instance used by all API modules. */
export const api = new ApiClient();
