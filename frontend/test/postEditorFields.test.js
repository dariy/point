/**
 * The post editor's field groups — what reaches the markup, not the layout.
 *
 * Each group carries a plain-text `summary` for its collapsed row and a `body`
 * of markup; renderGroup() is what escapes the summary on the way in. That
 * split matters: the summaries used to arrive pre-escaped, and the slug one
 * arrived escaped twice (the local `slug` was escaped, then the summary escaped
 * that), so a slug with a quote in it displayed its entities.
 */

import { test, describe, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';

let dom, buildFieldGroups, renderGroup;

before(async () => {
  dom = setupDOM();
  ({ buildFieldGroups, renderGroup } = await import('../src/components/light/postEditorFields.js'));
  dom.cleanup();
});

beforeEach(() => { dom = setupDOM(); });
afterEach(() => dom.cleanup());

const build = (post = {}, over = {}) =>
  buildFieldGroups({ post, isNew: false, editorMode: 'text', igStatus: {}, ...over });

/** One group as it reaches the DOM. */
const rendered = (key, post, over) => String(renderGroup(key, build(post, over)[key], false));

/** The text inside the collapsed summary span. */
const summaryOf = (markup) =>
  markup.match(/<span class="details-group-summary"[^>]*>([\s\S]*?)<\/span>/)[1];

describe('post editor field groups', () => {
  test('a slug with a quote is escaped once, not twice', () => {
    assert.strictEqual(summaryOf(rendered('slug', { slug: 'a"b' })), 'a&quot;b');
  });

  test('a hostile title cannot open a tag from the summary row', () => {
    const markup = rendered('title', { title: '<img onerror=alert(1)>' });
    assert.match(summaryOf(markup), /&lt;img onerror=alert\(1\)&gt;/);
    assert.doesNotMatch(markup, /<img onerror/);
  });

  test('an ampersand in a tag name survives as one ampersand', () => {
    assert.strictEqual(
      summaryOf(rendered('tags', { tags: [{ name: 'a & b' }] })),
      'a &amp; b',
    );
  });

  test('the group label keeps the entity it is written with', () => {
    // "Status &amp; visibility" is authored encoded, so the title span takes it
    // raw while the handle's aria-label gets the decoded copy re-escaped.
    const markup = rendered('status', { status: 'draft' });
    assert.match(markup, /<span class="details-group-title">Status &amp; visibility<\/span>/);
    assert.match(markup, /aria-label="Move Status &amp; visibility"/);
  });

  test('the body is markup, and a hostile excerpt stays text inside it', () => {
    const markup = rendered('excerpt', { excerpt: '</textarea><script>x</script>' });
    assert.match(markup, /<textarea id="excerpt-editor"/);
    assert.doesNotMatch(markup, /<\/textarea><script>/);
  });
});

/**
 * Settings inputs. The logo preview paints an admin-typed URL into a src=, so
 * it takes the html`` tag's URL policy rather than plain text escaping —
 * escapeHtml leaves `javascript:` and `data:` perfectly intact.
 */
describe('settings field inputs', () => {
  let renderFields;
  before(async () => {
    ({ renderFields } = await import('../src/components/light/settingsFields.js'));
  });

  const preview = (url) =>
    (String(renderFields(['logo_url'], { logo_url: url }, {}).inputs).match(/<img[^>]*>/) || [''])[0];

  test('a real logo URL is left alone', () => {
    assert.match(preview('/media/logo.png'), /src="\/media\/logo\.png"/);
    assert.match(preview('https://cdn.example/l.png?a=1&b=2'), /src="https:\/\/cdn\.example\/l\.png\?a=1&amp;b=2"/);
  });

  test('a hostile logo URL never reaches the src attribute', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>', '//evil.example/l.png']) {
      assert.match(preview(url), /src="#"/, url);
    }
  });

  test('no fields means falsy, so a caller gating a wrapper on it emits nothing', () => {
    const { inputs, toggles } = renderFields([], {}, {});
    assert.ok(!inputs);
    assert.ok(!toggles);
  });
});
