import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM, click, fire, must } from './helpers/dom.ts';
import { mock } from './helpers/mock.ts';
import type { MediaItem } from '../src/utils/postMedia.ts';
import type { Post, PostStub } from '../src/api/posts.ts';
import { MediaViewer } from '../src/components/shared/MediaViewer.ts';
import { ImmersiveSheetViewer } from '../src/plugins/immersive/ImmersiveSheetViewer.ts';
import { setSettings } from '../src/store.ts';

describe('MediaViewer', () => {
  let dom: ReturnType<typeof setupDOM>;
  let navs: string[] = [];

  beforeEach(() => {
    dom = setupDOM();
    navs = [];
    dom.window.addEventListener('app:navigate', (e) => { if (e instanceof CustomEvent) navs.push(e.detail.path); });
    setSettings({ immersive_nav_direction: 'chronological' });
  });

  afterEach(() => {
    dom.cleanup();
  });

  test('wraps around if no nav targets (index wrapping on click)', () => {
    const items: MediaItem[] = [{ type: 'image', url: '/a.jpg' }, { type: 'image', url: '/b.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { items, startIndex: 0 });
    viewer.mount();
    
    click(must(dom.document.querySelector('.immersive-nav-prev'), '.immersive-nav-prev'));
    assert.ok(dom.document.querySelectorAll('.carousel-slide')[1].classList.contains('active'));

    click(must(dom.document.querySelector('.immersive-nav-next'), '.immersive-nav-next'));
    assert.ok(dom.document.querySelectorAll('.carousel-slide')[0].classList.contains('active'));
    assert.strictEqual(navs.length, 0);
  });

  test('index clamping - _isBlocked returns true at edges with no adjacent posts', () => {
    const items: MediaItem[] = [{ type: 'image', url: '/a.jpg' }, { type: 'image', url: '/b.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { items, startIndex: 0 });
    viewer.mount();
    
    assert.strictEqual(viewer._isBlocked('back'), true);
    assert.strictEqual(viewer._isBlocked('fwd'), false);
    
    viewer._goTo(1);
    assert.strictEqual(viewer._isBlocked('back'), false);
    assert.strictEqual(viewer._isBlocked('fwd'), true);
  });

  test('index clamping - _isBlocked returns false if adjacent posts exist', () => {
    const items: MediaItem[] = [{ type: 'image', url: '/a.jpg' }, { type: 'image', url: '/b.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { 
      items, 
      startIndex: 0, 
      navPrev: mock<PostStub>({ slug: 'prev' }), 
      navNext: mock<PostStub>({ slug: 'next' }) 
    });
    viewer.mount();
    
    assert.strictEqual(viewer._isBlocked('back'), false);
    
    viewer._goTo(1);
    assert.strictEqual(viewer._isBlocked('fwd'), false);
  });

  test('prev/next across posts - navigates to adjacent posts', async () => {
    const items: MediaItem[] = [{ type: 'image', url: '/a.jpg' }, { type: 'image', url: '/b.jpg' }];
    const prevPost = mock<PostStub>({ slug: 'prev-post', title: 'Prev' });
    const nextPost = mock<PostStub>({ slug: 'next-post', title: 'Next' });
    
    const viewer = new MediaViewer(dom.document.body, { 
      items, 
      startIndex: 0, 
      navPrev: prevPost, 
      navNext: nextPost 
    });
    viewer.mount();

    click(must(dom.document.querySelector('.immersive-nav-prev'), '.immersive-nav-prev'));
    
    await new Promise(r => setTimeout(r, 350));
    assert.deepStrictEqual(navs, ['/posts/prev-post']);

    click(must(dom.document.querySelector('.immersive-nav-next'), '.immersive-nav-next'));
    click(must(dom.document.querySelector('.immersive-nav-next'), '.immersive-nav-next'));

    await new Promise(r => setTimeout(r, 350));
    assert.deepStrictEqual(navs, ['/posts/prev-post', '/posts/next-post']);
  });
  
  test('feed navigation direction reverses navTargets', async () => {
    setSettings({ immersive_nav_direction: 'feed' });
    const items: MediaItem[] = [{ type: 'image', url: '/a.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { 
      items, 
      startIndex: 0, 
      navPrev: mock<PostStub>({ slug: 'older' }), 
      navNext: mock<PostStub>({ slug: 'newer' }) 
    });
    viewer.mount();

    click(must(dom.document.querySelector('.immersive-nav-next'), '.immersive-nav-next'));
    await new Promise(r => setTimeout(r, 350));
    assert.deepStrictEqual(navs, ['/posts/older']);
  });

  test('renders text, video, and audio items', () => {
    const items: MediaItem[] = [
      { type: 'html', html: '<p>Text slide</p>' },
      { type: 'video', url: '/v.mp4' },
      { type: 'audio', url: '/a.mp3' }
    ];
    const viewer = new MediaViewer(dom.document.body, { items, startIndex: 0 });
    viewer.mount();
    
    const slides = dom.document.querySelectorAll('.carousel-slide');
    assert.strictEqual(slides.length, 3);
    assert.ok(slides[0].innerHTML.includes('<p>Text slide</p>'));
    assert.ok(slides[1].innerHTML.includes('<video src="/v.mp4"'));
    assert.ok(slides[2].innerHTML.includes('<audio src="/a.mp3"'));
  });

  test('double tap to zoom', () => {
    const items: MediaItem[] = [{ type: 'image', url: '/a.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { items, startIndex: 0 });
    viewer.mount();

    const img = must(dom.document.querySelector('.immersive-bg-image'), '.immersive-bg-image');
    Object.defineProperty(img, 'naturalWidth', { value: 1000, configurable: true });
    img.getBoundingClientRect = () => mock<DOMRect>({ width: 500, height: 500 });
    dom.window.innerWidth = 500;
    dom.window.innerHeight = 500;

    const wrapper = must(dom.document.querySelector('.media-viewer-wrapper'), '.media-viewer-wrapper');
    assert.ok(!wrapper.classList.contains('zoomed'));
    
    must(must(viewer._gesture, 'a gesture controller')._opts.onDoubleTap)(250, 250);
    
    assert.ok(wrapper.classList.contains('zoomed'));
    assert.strictEqual(viewer._zoomState.scale, 2);

    fire(dom.document, 'keydown', { key: 'Escape' });
    assert.ok(!wrapper.classList.contains('zoomed'));
    assert.strictEqual(viewer._zoomState.scale, 1);
  });
});

describe('ImmersiveSheetViewer', () => {
  let dom: ReturnType<typeof setupDOM>;

  beforeEach(() => {
    dom = setupDOM();
    setSettings({ immersive_overlay_mode: 'sheet' });
  });

  afterEach(() => {
    dom.cleanup();
  });

  test('renders the swipe-up sheet overlay instead of standard chrome', () => {
    const items: MediaItem[] = [{ type: 'image', url: '/a.jpg' }];
    const post = mock<Post>({ title: 'Sheet Post', excerpt: 'Sheet excerpt' });
    const viewer = new ImmersiveSheetViewer(dom.document.body, { items, post, startIndex: 0 });
    viewer.mount();

    const wrapper = must(dom.document.querySelector('.media-viewer-wrapper'), '.media-viewer-wrapper');
    assert.ok(wrapper.classList.contains('immersive-sheet-mode'));

    const sheet = must(dom.document.querySelector('.immersive-sheet'), '.immersive-sheet');
    assert.ok(sheet);

    assert.ok(sheet.innerHTML.includes('Sheet Post'));
    assert.ok(sheet.innerHTML.includes('Sheet excerpt'));
  });

  test('swipe up opens the sheet', () => {
    const items: MediaItem[] = [{ type: 'image', url: '/a.jpg' }];
    const viewer = new ImmersiveSheetViewer(dom.document.body, { items, post: mock<Post>({}), startIndex: 0 });
    viewer.mount();

    assert.strictEqual(viewer._sheetOpen, false);

    viewer._onSwipeCommit('up');
    assert.strictEqual(viewer._sheetOpen, true);
    assert.ok(must(dom.document.querySelector('.media-viewer-wrapper'), '.media-viewer-wrapper').classList.contains('sheet-open'));
  });
  
  test('keyboard up/down drives the sheet', () => {
    const items: MediaItem[] = [{ type: 'image', url: '/a.jpg' }];
    const viewer = new ImmersiveSheetViewer(dom.document.body, { items, post: mock<Post>({}), startIndex: 0 });
    viewer.mount();

    assert.strictEqual(viewer._sheetOpen, false);

    fire(dom.document, 'keydown', { key: 'ArrowUp' });
    assert.strictEqual(viewer._sheetOpen, true);
  });
});

// Slide markup is written straight to innerHTML. Every media URL reaching it
// must go through the URL policy, not the text policy — escapeHtml leaves
// `javascript:` intact, so an attribute-safe value can still be scheme-unsafe.
describe('MediaViewer slide escaping', () => {
  let dom: ReturnType<typeof setupDOM>;

  beforeEach(() => {
    dom = setupDOM();
    setSettings({ immersive_nav_direction: 'chronological' });
  });

  afterEach(() => {
    dom.cleanup();
  });

  const mountWith = (item: MediaItem) => {
    const viewer = new MediaViewer(dom.document.body, { items: [item], startIndex: 0 });
    viewer.mount();
    return viewer;
  };

  test('a javascript: image url is neutralised to #', () => {
    mountWith({ type: 'image', url: 'javascript:alert(1)' });

    assert.strictEqual(must(dom.document.querySelector('.immersive-bg-image'), '.immersive-bg-image').getAttribute('src'), '#');
  });

  test('a protocol-relative video url is neutralised to #', () => {
    mountWith({ type: 'video', url: '//evil.example/x.mp4' });

    assert.strictEqual(must(dom.document.querySelector('video'), 'video').getAttribute('src'), '#');
  });

  test('an attribute-breakout audio url cannot add an event handler', () => {
    mountWith({ type: 'audio', url: '/a.mp3" onerror="alert(1)' });

    const audio = must(dom.document.querySelector('audio'), 'audio');
    assert.strictEqual(audio.getAttribute('onerror'), null);
    assert.ok(!dom.document.body.innerHTML.includes('onerror="'));
  });

  test('a script tag in alt text renders as an attribute value, not an element', () => {
    mountWith({ type: 'image', url: '/a.jpg', alt: '<script>alert(1)</script>' });

    const img = must(dom.document.querySelector('img'), 'img');
    assert.strictEqual(dom.document.querySelector('script'), null);
    assert.strictEqual(img.getAttribute('alt'), '<script>alert(1)</script>');
    assert.strictEqual(img.getAttribute('src'), '/a.jpg');
  });

  test('an ordinary image slide is unaffected', () => {
    mountWith({ type: 'image', url: '/photo.jpg', alt: 'A photo' });

    const img = must(dom.document.querySelector('img'), 'img');
    assert.strictEqual(img.getAttribute('src'), '/photo.jpg');
    assert.strictEqual(img.getAttribute('alt'), 'A photo');
  });
});
