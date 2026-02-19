/**
 * Posts API — CRUD for blog posts.
 *
 * Backend prefix: /api/posts
 */

import { api } from './client.js';

/**
 * List posts with optional filters.
 *
 * @param {{ page?: number, per_page?: number, status?: string, tag?: string, q?: string }} [params]
 * @returns {Promise<{ items: object[], total: number, page: number, per_page: number, pages: number }>}
 */
export function listPosts(params = {}) {
  return api.get('/api/posts', params);
}

/**
 * Get a single post by numeric ID.
 * @param {number} id
 * @returns {Promise<object>}
 */
export function getPost(id) {
  return api.get(`/api/posts/${id}`);
}

/**
 * Get a single post by slug (public, no auth).
 * @param {string} slug
 * @returns {Promise<object>}
 */
export function getPostBySlug(slug) {
  return api.get(`/api/posts/slug/${slug}`);
}

/**
 * Create a new post.
 * @param {object} data  PostCreate payload
 * @returns {Promise<object>}
 */
export function createPost(data) {
  return api.post('/api/posts', data);
}

/**
 * Update a post.
 * @param {number} id
 * @param {object} data  PostUpdate payload
 * @returns {Promise<object>}
 */
export function updatePost(id, data) {
  return api.put(`/api/posts/${id}`, data);
}

/**
 * Delete a post.
 * @param {number} id
 * @returns {Promise<null>}
 */
export function deletePost(id) {
  return api.delete(`/api/posts/${id}`);
}

/**
 * Get a draft post for preview via its preview token.
 * @param {string} token
 * @returns {Promise<object>}
 */
export function previewPost(token) {
  return api.get(`/api/posts/preview/${token}`);
}

/**
 * Update post status only.
 * @param {number} id
 * @param {string} status  'draft' | 'published' | 'hidden'
 * @returns {Promise<object>}
 */
export function setPostStatus(id, status) {
  return api.patch(`/api/posts/${id}/status`, { status });
}

/**
 * Get posts adjacent to a given post for prev/next navigation.
 * @param {number} id
 * @returns {Promise<{ prev: object|null, next: object|null }>}
 */
export function getPostNavigation(id) {
  return api.get(`/api/posts/${id}/navigation`);
}
