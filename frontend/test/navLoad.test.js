// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, before } from 'node:test';
import assert from 'node:assert';

// The nav payload feeds two independent surfaces: the menu (nav-menu plugin)
// and the site-title root-tag dropdown (breadcrumbs plugin). loadNav is what
// keeps that one fetch, and keeps the two halves distinguishable when the menu
// is authored links rather than the tag tree.
describe('loadNav', () => {
  let loadNav;
  let getNavTags, getRootTags, setNavTags, setRootTags;
  let calls;
  let respond;

  before(async () => {
    global.fetch = async () => {
      calls += 1;
      return {
        status: 200,
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => respond(),
      };
    };
    ({ loadNav } = await import('../src/api/nav.js'));
    ({ getNavTags, getRootTags, setNavTags, setRootTags } = await import('../src/store.js'));
  });

  test('custom mode: menu keeps the links, rootTags carries the tag tree', async () => {
    calls = 0;
    respond = () => ({
      menu: [{ name: 'About', url: '/about' }],
      tags: [{ name: 'Travel', slug: 'travel', post_count: 3 }],
    });

    await loadNav();

    assert.deepStrictEqual(getNavTags().map((i) => i.name), ['About']);
    assert.deepStrictEqual(getRootTags().map((i) => i.name), ['Travel']);
    assert.strictEqual(calls, 1);
  });

  test('a loaded menu is not refetched unless forced', async () => {
    calls = 0;
    respond = () => ({ menu: [{ name: 'Travel', slug: 'travel' }] });

    await loadNav();
    assert.strictEqual(calls, 0, 'second plugin mounting must not cost a fetch');

    // tags mode sends no `tags` — the menu already is the tree.
    await loadNav({ force: true });
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(getRootTags().map((i) => i.name), ['Travel']);
  });

  test('concurrent callers share one request', async () => {
    calls = 0;
    respond = () => ({ menu: [] });

    await Promise.all([loadNav({ force: true }), loadNav(), loadNav()]);

    assert.strictEqual(calls, 1);
  });

  test('a failed fetch resolves and leaves the last good data in place', async () => {
    setNavTags([{ name: 'Travel', slug: 'travel' }]);
    setRootTags([{ name: 'Travel', slug: 'travel' }]);
    const ok = global.fetch;
    global.fetch = async () => { throw new Error('offline'); };

    await loadNav({ force: true });

    assert.deepStrictEqual(getRootTags().map((i) => i.name), ['Travel']);
    global.fetch = ok;
  });
});
