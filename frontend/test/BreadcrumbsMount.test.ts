/**
 * Breadcrumbs, mounted for real.
 *
 * PublicHeaderBreadcrumb.test.js asserts on `render()` output against a
 * hand-stubbed document. These mount the trail into a linkedom document so
 * afterRender runs: the child dropdown on a crumb with children, and the
 * path-only trail toggle on a childless leaf.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, must } from './helpers/dom.ts';
import { mock } from './helpers/mock.ts';
import type { NavTagNode } from '../src/api/nav.ts';
import type { HeaderCrumb } from '../src/plugins/public-header/PublicHeader.ts';

const navTag = (t: Partial<NavTagNode>) => mock<NavTagNode>(t);

const NAV_TAGS = [
  navTag({
    slug: 'travel', name: 'Travel', post_count: 4,
    children: [
      navTag({ slug: 'japan', name: 'Japan', post_count: 2, children: [] }),
      navTag({ slug: 'norway', name: 'Norway', post_count: 2, children: [] }),
    ],
  }),
];

describe('Breadcrumbs (mounted)', () => {
  let dom: ReturnType<typeof setupDOM>;
  let Breadcrumbs: typeof import('../src/plugins/breadcrumbs/Breadcrumbs.ts').Breadcrumbs;
  let trail: InstanceType<typeof Breadcrumbs> | undefined;

  beforeEach(async () => {
    dom = setupDOM();
    ({ Breadcrumbs } = await import('../src/plugins/breadcrumbs/Breadcrumbs.ts'));
  });

  afterEach(() => {
    try { trail?.unmount(); } catch { /* torn down mid-flight */ }
    dom.cleanup();
  });

  function mountTrail(breadcrumb: HeaderCrumb[]) {
    const group = dom.document.createElement('div');
    const el = dom.document.createElement('div');
    group.appendChild(el);
    dom.document.body.appendChild(group);
    const mounted = new Breadcrumbs(el, { settings: { blog_title: 'Test blog' }, navTags: NAV_TAGS, breadcrumb, group });
    mounted.mount();
    trail = mounted;
    return mounted;
  }

  test('a crumb with children gets the dropdown affordance', () => {
    const trail = mountTrail([{ slug: 'travel', name: 'Travel' }]);
    const crumb = must(trail.container.querySelector('.breadcrumb-current[data-crumb-slug="travel"]'));
    assert.ok(crumb.classList.contains('has-dropdown'));
    assert.deepStrictEqual(trail._getTagChildren('travel', NAV_TAGS).map(c => c.slug), ['japan', 'norway']);
    assert.ok(!crumb.classList.contains('crumb-trail-toggle'));
  });

  test('a childless leaf gets the path-only trail toggle', () => {
    const trail = mountTrail([{ slug: 'travel', name: 'Travel' }, { slug: 'japan', name: 'Japan' }]);
    const leaf = must(trail.container.querySelector('.breadcrumb-current[data-crumb-slug="japan"]'));
    assert.ok(!leaf.classList.contains('has-dropdown'));
    assert.ok(leaf.classList.contains('crumb-trail-toggle'));
  });

  test('an unknown slug has no children', () => {
    const trail = mountTrail([{ slug: 'travel', name: 'Travel' }]);
    assert.deepStrictEqual(trail._getTagChildren('nowhere', NAV_TAGS), []);
  });
});
