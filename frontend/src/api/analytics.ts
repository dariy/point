import { api } from './client.ts';

/** Fetch aggregated post analytics. */
export async function getPostAnalytics(): Promise<{
  total_views: number;
  average_views_per_post: number;
  most_viewed_post_id: number;
}> {
  return api.get('/api/posts/analytics');
}

/** Fetch top performing posts by views. */
export async function getTopPosts(limit = 10): Promise<{
  posts: unknown[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}> {
  return api.get('/api/posts', {
    sort: 'views',
    per_page: limit,
    status: 'published'
  });
}
