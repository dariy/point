import { test, describe, before } from 'node:test';
import assert from 'node:assert';

/**
 * The tag strip shows a post's *own* tags. Page endpoints (/api/pages/home,
 * /api/pages/tags/:slug) expand each post's tags with their ancestors so a post
 * can be matched against a whole subtree, and mark those extras `inherited`.
 */
describe('renderTagStrip visibility filter', () => {
  let renderTagStrip;

  before(async () => {
    ({ renderTagStrip } = await import('../src/utils/tags.js'));
  });

  test('keeps tags the post carries itself', () => {
    const html = renderTagStrip([
      { name: 'fern', slug: 'fern' },
      { name: 'spiral', slug: 'spiral' },
    ]);
    assert.ok(html.includes('/tags/fern'));
    assert.ok(html.includes('/tags/spiral'));
  });

  test('drops ancestors the server added for subtree matching', () => {
    const html = renderTagStrip([
      { name: 'Montréal', slug: 'montreal' },
      { name: 'city', slug: 'city', inherited: true },
      { name: 'canada', slug: 'canada', inherited: true },
      { name: 'location', slug: 'location', inherited: true },
    ]);
    assert.ok(html.includes('/tags/montreal'));
    assert.ok(!html.includes('/tags/city'), 'inherited ancestor should not render');
    assert.ok(!html.includes('/tags/canada'));
    assert.ok(!html.includes('/tags/location'));
  });

  test('keeps a container tag the post is directly tagged with', () => {
    // "nature" has children, but this post carries it — the post page shows it,
    // so the card must too.
    const html = renderTagStrip([
      { name: 'nature', slug: 'nature' },
      { name: 'color', slug: 'color', inherited: true },
    ]);
    assert.ok(html.includes('/tags/nature'));
    assert.ok(!html.includes('/tags/color'));
  });

  test('renders nothing when every tag is inherited', () => {
    const html = renderTagStrip([{ name: 'location', slug: 'location', inherited: true }]);
    assert.strictEqual(html, '');
  });

  test('handles a missing tag list', () => {
    assert.strictEqual(renderTagStrip(undefined), '');
    assert.strictEqual(renderTagStrip([]), '');
  });
});
