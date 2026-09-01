import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM, click, fire } from './helpers/dom.js';
import { MediaViewer } from '../src/components/shared/MediaViewer.js';
import { ImmersiveSheetViewer } from '../src/plugins/immersive/ImmersiveSheetViewer.js';
import { setSettings } from '../src/store.js';

describe('MediaViewer', () => {
  let dom;
  let navs = [];

  beforeEach(() => {
    dom = setupDOM();
    navs = [];
    dom.window.addEventListener('app:navigate', (e) => navs.push(e.detail.path));
    setSettings({ immersive_nav_direction: 'chronological' });
  });

  afterEach(() => {
    dom.cleanup();
  });

  test('wraps around if no nav targets (index wrapping on click)', () => {
    const items = [{ type: 'image', url: '/a.jpg' }, { type: 'image', url: '/b.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { items, startIndex: 0 });
    viewer.mount();
    
    click(dom.document.querySelector('.immersive-nav-prev'));
    assert.ok(dom.document.querySelectorAll('.carousel-slide')[1].classList.contains('active'));

    click(dom.document.querySelector('.immersive-nav-next'));
    assert.ok(dom.document.querySelectorAll('.carousel-slide')[0].classList.contains('active'));
    assert.strictEqual(navs.length, 0);
  });

  test('index clamping - _isBlocked returns true at edges with no adjacent posts', () => {
    const items = [{ type: 'image', url: '/a.jpg' }, { type: 'image', url: '/b.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { items, startIndex: 0 });
    viewer.mount();
    
    assert.strictEqual(viewer._isBlocked('back'), true);
    assert.strictEqual(viewer._isBlocked('fwd'), false);
    
    viewer._goTo(1);
    assert.strictEqual(viewer._isBlocked('back'), false);
    assert.strictEqual(viewer._isBlocked('fwd'), true);
  });

  test('index clamping - _isBlocked returns false if adjacent posts exist', () => {
    const items = [{ type: 'image', url: '/a.jpg' }, { type: 'image', url: '/b.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { 
      items, 
      startIndex: 0, 
      navPrev: { slug: 'prev' }, 
      navNext: { slug: 'next' } 
    });
    viewer.mount();
    
    assert.strictEqual(viewer._isBlocked('back'), false);
    
    viewer._goTo(1);
    assert.strictEqual(viewer._isBlocked('fwd'), false);
  });

  test('prev/next across posts - navigates to adjacent posts', async () => {
    const items = [{ type: 'image', url: '/a.jpg' }, { type: 'image', url: '/b.jpg' }];
    const prevPost = { slug: 'prev-post', title: 'Prev' };
    const nextPost = { slug: 'next-post', title: 'Next' };
    
    const viewer = new MediaViewer(dom.document.body, { 
      items, 
      startIndex: 0, 
      navPrev: prevPost, 
      navNext: nextPost 
    });
    viewer.mount();

    click(dom.document.querySelector('.immersive-nav-prev'));
    
    await new Promise(r => setTimeout(r, 350));
    assert.deepStrictEqual(navs, ['/posts/prev-post']);

    click(dom.document.querySelector('.immersive-nav-next'));
    click(dom.document.querySelector('.immersive-nav-next'));

    await new Promise(r => setTimeout(r, 350));
    assert.deepStrictEqual(navs, ['/posts/prev-post', '/posts/next-post']);
  });
  
  test('feed navigation direction reverses navTargets', async () => {
    setSettings({ immersive_nav_direction: 'feed' });
    const items = [{ type: 'image', url: '/a.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { 
      items, 
      startIndex: 0, 
      navPrev: { slug: 'older' }, 
      navNext: { slug: 'newer' } 
    });
    viewer.mount();

    click(dom.document.querySelector('.immersive-nav-next'));
    await new Promise(r => setTimeout(r, 350));
    assert.deepStrictEqual(navs, ['/posts/older']);
  });

  test('renders text, video, and audio items', () => {
    const items = [
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
    const items = [{ type: 'image', url: '/a.jpg' }];
    const viewer = new MediaViewer(dom.document.body, { items, startIndex: 0 });
    viewer.mount();

    const img = dom.document.querySelector('.immersive-bg-image');
    Object.defineProperty(img, 'naturalWidth', { value: 1000, configurable: true });
    img.getBoundingClientRect = () => ({ width: 500, height: 500 });
    dom.window.innerWidth = 500;
    dom.window.innerHeight = 500;

    const wrapper = dom.document.querySelector('.media-viewer-wrapper');
    assert.ok(!wrapper.classList.contains('zoomed'));
    
    viewer._gesture._opts.onDoubleTap(250, 250);
    
    assert.ok(wrapper.classList.contains('zoomed'));
    assert.strictEqual(viewer._zoomState.scale, 2);

    fire(dom.document, 'keydown', { key: 'Escape' });
    assert.ok(!wrapper.classList.contains('zoomed'));
    assert.strictEqual(viewer._zoomState.scale, 1);
  });
});

describe('ImmersiveSheetViewer', () => {
  let dom;

  beforeEach(() => {
    dom = setupDOM();
    setSettings({ immersive_overlay_mode: 'sheet' });
  });

  afterEach(() => {
    dom.cleanup();
  });

  test('renders the swipe-up sheet overlay instead of standard chrome', () => {
    const items = [{ type: 'image', url: '/a.jpg' }];
    const post = { title: 'Sheet Post', excerpt: 'Sheet excerpt' };
    const viewer = new ImmersiveSheetViewer(dom.document.body, { items, post, startIndex: 0 });
    viewer.mount();

    const wrapper = dom.document.querySelector('.media-viewer-wrapper');
    assert.ok(wrapper.classList.contains('immersive-sheet-mode'));

    const sheet = dom.document.querySelector('.immersive-sheet');
    assert.ok(sheet);

    assert.ok(sheet.innerHTML.includes('Sheet Post'));
    assert.ok(sheet.innerHTML.includes('Sheet excerpt'));
  });

  test('swipe up opens the sheet', () => {
    const items = [{ type: 'image', url: '/a.jpg' }];
    const viewer = new ImmersiveSheetViewer(dom.document.body, { items, post: {}, startIndex: 0 });
    viewer.mount();

    assert.strictEqual(viewer._sheetOpen, false);

    viewer._onSwipeCommit('up');
    assert.strictEqual(viewer._sheetOpen, true);
    assert.ok(dom.document.querySelector('.media-viewer-wrapper').classList.contains('sheet-open'));
  });
  
  test('keyboard up/down drives the sheet', () => {
    const items = [{ type: 'image', url: '/a.jpg' }];
    const viewer = new ImmersiveSheetViewer(dom.document.body, { items, post: {}, startIndex: 0 });
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
  let dom;

  beforeEach(() => {
    dom = setupDOM();
    setSettings({ immersive_nav_direction: 'chronological' });
  });

  afterEach(() => {
    dom.cleanup();
  });

  const mountWith = (item) => {
    const viewer = new MediaViewer(dom.document.body, { items: [item], startIndex: 0 });
    viewer.mount();
    return viewer;
  };

  test('a javascript: image url is neutralised to #', () => {
    mountWith({ type: 'image', url: 'javascript:alert(1)' });

    assert.strictEqual(dom.document.querySelector('.immersive-bg-image').getAttribute('src'), '#');
  });

  test('a protocol-relative video url is neutralised to #', () => {
    mountWith({ type: 'video', url: '//evil.example/x.mp4' });

    assert.strictEqual(dom.document.querySelector('video').getAttribute('src'), '#');
  });

  test('an attribute-breakout audio url cannot add an event handler', () => {
    mountWith({ type: 'audio', url: '/a.mp3" onerror="alert(1)' });

    const audio = dom.document.querySelector('audio');
    assert.strictEqual(audio.getAttribute('onerror'), null);
    assert.ok(!dom.document.body.innerHTML.includes('onerror="'));
  });

  test('a script tag in alt text renders as an attribute value, not an element', () => {
    mountWith({ type: 'image', url: '/a.jpg', alt: '<script>alert(1)</script>' });

    const img = dom.document.querySelector('img');
    assert.strictEqual(dom.document.querySelector('script'), null);
    assert.strictEqual(img.getAttribute('alt'), '<script>alert(1)</script>');
    assert.strictEqual(img.getAttribute('src'), '/a.jpg');
  });

  test('an ordinary image slide is unaffected', () => {
    mountWith({ type: 'image', url: '/photo.jpg', alt: 'A photo' });

    const img = dom.document.querySelector('img');
    assert.strictEqual(img.getAttribute('src'), '/photo.jpg');
    assert.strictEqual(img.getAttribute('alt'), 'A photo');
  });
});
