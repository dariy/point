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
import { revelioHeaders } from '../utils/revelio.js';

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
   * The response shape is whatever the endpoint sends, so `T` is chosen by the
   * caller — the per-endpoint wrappers in this directory declare it through
   * their own `@returns`, and it falls back to `unknown` when nobody does.
   *
   * @template [T=unknown]
   * @param {string} path
   * @param {RequestInit} [init]
   * @returns {Promise<T>}
   */
  async request(path, init = {}) {
    const url = this._base + path;

    /** @type {RequestInit} */
    const opts = {
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        // Owner browsing as a guest — see utils/revelio.js. Merged before the
        // caller's own headers so an explicit one still wins.
        ...revelioHeaders(),
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
   *
   * An array value becomes repeated keys (`?p=a&p=b`) rather than a joined
   * string: the values it carries — media paths, say — may contain whatever
   * separator we would have joined on.
   *
   * @template [T=unknown]
   * @param {string} path
   * @param {Record<string,string|number|boolean|(string|number)[]>} [params]  Query parameters
   * @returns {Promise<T>}
   */
  get(path, params) {
    let query;
    if (params) {
      query = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        // String() explicitly: URLSearchParams stringifies anyway, but its type
        // only admits strings, and numbers/booleans are common here.
        if (Array.isArray(v)) for (const item of v) query.append(k, String(item));
        else query.append(k, String(v));
      }
    }
    const url = query ? `${path}?${query}` : path;
    return this.request(url, { method: 'GET' });
  }

  /**
   * POST request with JSON body.
   * @template [T=unknown]
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<T>}
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
   * @template [T=unknown]
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<T>}
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
   * @template [T=unknown]
   * @param {string} path
   * @param {unknown} [body]
   * @returns {Promise<T>}
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
   * @template [T=null]
   * @param {string} path
   * @returns {Promise<T>}
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
   * @template [T=unknown]
   * @param {string} path
   * @param {FormData} formData
   * @returns {Promise<T>}
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
