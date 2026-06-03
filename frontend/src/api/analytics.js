import { api } from './client.js';

/**
 * Fetch aggregated post analytics.
 * @returns {Promise<{total_views: number, average_views_per_post: number, most_viewed_post_id: number}>}
 */
export async function getPostAnalytics() {
  return api.get('/api/posts/analytics');
}

/**
 * Fetch top performing posts by views.
 * @param {number} limit
 * @returns {Promise<{posts: Array, total: number, page: number, per_page: number, pages: number}>}
 */
export async function getTopPosts(limit = 10) {
  return api.get('/api/posts', {
    sort: 'views',
    per_page: limit,
    status: 'published'
  });
}
