import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, fire, click, must } from './helpers/dom.ts';
import { mock } from './helpers/mock.ts';
import type { Post } from '../src/api/posts.ts';
import { setNavTags, setRoute, setSettings } from '../src/store.ts';
import { PostCard } from '../src/components/public/PostCard.ts';

/** PostCard.onOpen — a host opens the post its own way; ViewContext stays out. */

const POST: Post = mock<Post>({
  id: 1,
  slug: 'a-post',
  title: 'A Post',
  tags: [],
  published_at: '2026-03-01T00:00:00Z',
});

describe('PostCard onOpen', () => {
  let dom: ReturnType<typeof setupDOM>;
  let navigations: string[];

  beforeEach(() => {
    dom = setupDOM();
    navigations = [];
    dom.window.addEventListener('app:navigate', (e) => navigations.push((e as CustomEvent<{ path: string }>).detail.path));
    setRoute({ pathname: '/', query: {} });
    setNavTags([]);
    setSettings(mock<Parameters<typeof setSettings>[0]>({}));
  });

  afterEach(() => dom.cleanup());

  function mount(onOpen?: (post: Post) => void) {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    new PostCard(el, { post: POST, onOpen }).mount();
    return must(el.querySelector<HTMLElement>('.post-card'));
  }

  test('a click calls onOpen and does not navigate', () => {
    const opened: Post[] = [];
    click(mount((p) => opened.push(p)));
    assert.deepEqual(opened.map((p) => p.slug), ['a-post']);
    assert.deepEqual(navigations, []);
  });

  test('Enter and Space call onOpen and do not navigate', () => {
    const opened: Post[] = [];
    const card = mount((p) => opened.push(p));
    fire(card, 'keydown', { key: 'Enter' });
    fire(card, 'keydown', { key: ' ' });
    assert.equal(opened.length, 2);
    assert.deepEqual(navigations, []);
  });

  test('without onOpen a click still navigates', () => {
    click(mount());
    assert.equal(navigations.length, 1);
  });
});
