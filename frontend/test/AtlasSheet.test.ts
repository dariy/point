/**
 * AtlasSheet — the bottom sheet with one row of the posts of a place.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM, must } from './helpers/dom.ts';
import { jsonResponse } from './helpers/fetch.ts';
import { AtlasSheet, fitColumns, SHEET_GAP_PX, CARD_ASPECT } from '../src/plugins/tags-atlas/AtlasSheet.ts';
import { clearPageCache } from '../src/api/pages.ts';
import type { Post } from '../src/api/posts.ts';

const BERLIN = { id: 1, slug: 'berlin', name: 'Berlin' };
const PARIS = { id: 2, slug: 'paris', name: 'Paris' };

/** A page payload for `slug`, with posts `<slug>-1` … */
const pageOf = (slug: string, n: number, total = n) => ({
  tag: { id: 1, name: slug, slug },
  breadcrumbs: [],
  posts: Array.from({ length: n }, (_, i) => ({ id: i + 1, slug: `${slug}-${i + 1}`, title: `${slug} ${i + 1}` })),
  pagination: { page: 1, pages: Math.ceil(total / Math.max(1, n)), total },
  menu: [],
  nav_children: [],
});

/** An Escape keydown. linkedom has no KeyboardEvent. */
const escape = () => Object.assign(new Event('keydown', { bubbles: true }), { key: 'Escape' });

/** The wait for the crossfade and the async grid mount. */
const settle = () => new Promise((r) => setTimeout(r, 260));

describe('fitColumns', () => {
  test('a wide row holds many squares', () => {
    assert.strictEqual(fitColumns(1000, 150, SHEET_GAP_PX, CARD_ASPECT), 6);
  });
  test('a narrow row holds one square', () => {
    assert.strictEqual(fitColumns(200, 150, SHEET_GAP_PX, CARD_ASPECT), 1);
  });
  test('a row with no height gives 4', () => {
    assert.strictEqual(fitColumns(1000, 0, SHEET_GAP_PX, CARD_ASPECT), 4);
  });
});

describe('AtlasSheet', () => {
  let dom: ReturnType<typeof setupDOM>;
  let calls: string[];
  /** Per-slug responses. A function value is called and may return a promise. */
  let replies: Record<string, unknown>;
  let toggles: boolean[];
  let skip: (p: Post) => boolean;
  let sheet: AtlasSheet;

  beforeEach(() => {
    dom = setupDOM();
    clearPageCache();
    calls = [];
    toggles = [];
    skip = () => false;
    replies = { berlin: pageOf('berlin', 4, 10), paris: pageOf('paris', 2) };
    globalThis.fetch = async (url) => {
      const u = String(url);
      calls.push(u);
      const slug = decodeURIComponent(u.split('/api/pages/tags/')[1].split('?')[0]);
      const r = replies[slug];
      const body = typeof r === 'function' ? await r() : r;
      return jsonResponse({ ok: true, status: 200, body });
    };
    const el = dom.document.createElement('div');
    dom.body.appendChild(el);
    sheet = new AtlasSheet(el, {
      skip: (p) => skip(p),
      scope: () => ({ year_from: 2010, year_to: 2020 }),
      onToggle: (open) => toggles.push(open),
    });
    sheet.mount();
  });
  afterEach(() => {
    sheet.unmount();
    dom.cleanup();
  });

  const $ = (sel: string) => must(sheet.$(sel), sel) as HTMLElement;
  const slugs = () => [...sheet.container.querySelectorAll('[data-post-slug]')].map((c) => (c as HTMLElement).dataset.postSlug);

  test('show fetches page 1 at the column count and with the year scope', async () => {
    await sheet.show(BERLIN);
    // calls[1] is the pager's preload of page 2.
    const q = new URL(calls[0], 'http://x').searchParams;
    assert.strictEqual(q.get('page'), '1');
    assert.strictEqual(q.get('per_page'), '4'); // the row has no height here
    assert.strictEqual(q.get('year_from'), '2010');
    assert.strictEqual(q.get('year_to'), '2020');
    assert.ok($('.atlas-sheet').classList.contains('is-open'));
    assert.deepStrictEqual(toggles, [true]);
    assert.deepStrictEqual(slugs(), ['berlin-1', 'berlin-2', 'berlin-3', 'berlin-4']);
    assert.match($('.atlas-sheet__label').textContent!, /Berlin · 10 posts/);
    assert.strictEqual($('.atlas-sheet').style.getPropertyValue('--atlas-cols'), '4');
  });

  test('per_page follows the measured row', async () => {
    const row = $('.atlas-sheet__row');
    Object.assign(row, { clientWidth: 1000, clientHeight: 150 });
    await sheet.show(BERLIN);
    assert.strictEqual(new URL(calls[0], 'http://x').searchParams.get('per_page'), '6');
  });

  test('a page from another page size goes through refitPage', async () => {
    await sheet.show(BERLIN, { page: 3, perPage: 2 });
    // Page 3 at 2 per page starts at post 5, which is on page 2 at 4 per page.
    assert.strictEqual(new URL(calls[0], 'http://x').searchParams.get('page'), '2');
  });

  test('show on an open sheet keeps it open and drops a late response', async () => {
    await sheet.show(BERLIN);
    let release!: () => void;
    replies.berlin = () => new Promise((r) => { release = () => r(pageOf('berlin', 4, 10)); });
    clearPageCache();
    const late = sheet.show({ ...BERLIN });
    const now = sheet.show(PARIS);
    assert.ok($('.atlas-sheet').classList.contains('is-open'));
    await now;
    release();
    await late;
    await settle();
    assert.strictEqual(sheet.place?.slug, 'paris');
    assert.deepStrictEqual(slugs(), ['paris-1', 'paris-2']);
    assert.deepStrictEqual(toggles, [true]);
  });

  test('a place change drops the old paginator until the new page loads', async () => {
    await sheet.show(BERLIN);
    let release!: () => void;
    replies.paris = () => new Promise((r) => { release = () => r(pageOf('paris', 2)); });
    const next = sheet.show(PARIS);
    const before = calls.length;
    sheet._goto(2); // the old "→" click
    assert.strictEqual(sheet.page, 1);
    assert.strictEqual(calls.length, before);
    release();
    await next;
    await settle();
    assert.strictEqual(sheet.place?.slug, 'paris');
    assert.deepStrictEqual(slugs(), ['paris-1', 'paris-2']);
    assert.ok(calls.every((u) => !u.includes('paris') || !u.includes('page=2')));
  });

  test('collapse, expand and hide', async () => {
    await sheet.show(BERLIN);
    const pill = $('.atlas-sheet-pill');
    assert.strictEqual(pill.hidden, true);

    sheet.collapse();
    assert.strictEqual(sheet.isOpen, false);
    assert.ok(!$('.atlas-sheet').classList.contains('is-open'));
    assert.strictEqual($('.atlas-sheet').inert, true);
    assert.strictEqual(pill.hidden, false);
    assert.match(pill.textContent!, /▲ Berlin · 10/);

    pill.click();
    assert.strictEqual(sheet.isOpen, true);
    assert.strictEqual($('.atlas-sheet').inert, false);
    assert.strictEqual(pill.hidden, true);
    assert.strictEqual(sheet.page, 1);
    assert.strictEqual(calls.filter((u) => u.includes('page=1')).length, 1, 'expand does not reload');

    sheet.hide();
    assert.strictEqual(sheet.place, null);
    assert.strictEqual(sheet.isOpen, false);
    assert.strictEqual(pill.hidden, true);
    assert.deepStrictEqual(toggles, [true, false, true, false]);
  });

  test('hide drops a request in flight', async () => {
    const p = sheet.show(BERLIN);
    sheet.hide();
    await p;
    assert.deepStrictEqual(slugs(), []);
  });

  test('skip filters a page', async () => {
    skip = (p) => p.slug === 'berlin-2';
    await sheet.show(BERLIN);
    assert.deepStrictEqual(slugs(), ['berlin-1', 'berlin-3', 'berlin-4']);
  });

  test('a card opens through onOpenPost with the page and the page size', async () => {
    const opened: [string, number, number][] = [];
    sheet.setProps({ onOpenPost: (post, page, perPage) => opened.push([post.slug, page, perPage]) });
    await sheet.show(BERLIN);
    (must(sheet.$('[data-post-slug="berlin-3"]'), 'card') as HTMLElement).click();
    assert.deepStrictEqual(opened, [['berlin-3', 1, 4]]);
  });

  test('Esc collapses, except in a text field', async () => {
    await sheet.show(BERLIN);
    const input = dom.document.createElement('input');
    dom.body.appendChild(input);
    input.dispatchEvent(escape());
    assert.strictEqual(sheet.isOpen, true);
    dom.document.dispatchEvent(escape());
    assert.strictEqual(sheet.isOpen, false);
  });

  test('a grip click collapses', async () => {
    await sheet.show(BERLIN);
    $('.atlas-sheet__grip').click();
    assert.strictEqual(sheet.isOpen, false);
  });
});
