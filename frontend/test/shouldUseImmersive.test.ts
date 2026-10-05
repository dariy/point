import { test, describe } from 'node:test';
import assert from 'node:assert';

import { shouldUseImmersive } from '../src/components/public/PostContent.ts';
import type { Post } from '../src/api/posts.ts';

const post = (paths: string[]) =>
  ({ content_html: '', media: paths.map((path) => ({ path, alt_text: null, metadata: null })) }) as unknown as Post;

describe('shouldUseImmersive media type', () => {
  test('audio-only post is not immersive', () => {
    assert.strictEqual(shouldUseImmersive(post(['/2026/03/a.mp3'])), false);
  });
  test('image post is immersive', () => {
    assert.strictEqual(shouldUseImmersive(post(['/2026/03/a.jpg'])), true);
  });
  test('mixed audio and image post is immersive', () => {
    assert.strictEqual(shouldUseImmersive(post(['/a.mp3', '/b.jpg'])), true);
  });
});
