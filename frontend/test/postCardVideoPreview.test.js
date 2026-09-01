// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { setupDOM, fire, click } from './helpers/dom.js';
import { store } from '../src/store.js';
import { PostCard } from '../src/components/public/PostCard.js';

/**
 * PostCard video preview — the clip a card plays before the reader opens it.
 *
 * Sibling of postCardMedia.test.js, which covers what a card costs on load.
 * This file covers the other half of that bargain: nothing streams until the
 * reader points at one specific card, and everything is torn down again the
 * moment they point away. Those are afterRender behaviours, so unlike the
 * render-only suite these mount the component against a real-enough DOM.
 *
 * Touch is the interesting half. There is no hover on a finger, so the preview
 * rides the card's existing two-tap pattern — the tap that reveals the overlay
 * also starts the clip, the tap after it opens the post. Two things make that
 * easy to get wrong, and both are asserted below:
 *
 *   • A browser fires pointerenter on touchdown and pointerleave on touchup,
 *     so a tap contains a complete enter/leave pair. If those listeners are not
 *     mouse-gated, a tap starts a clip and immediately stops it.
 *   • Cards are independent component instances, but only one overlay is open
 *     at a time — revealing one card closes every other. The card that loses
 *     its overlay has to lose its clip with it, which no single instance can
 *     arrange on its own.
 *
 * What these cannot see is where any of it lands: linkedom has no layout, so a
 * preview that plays perfectly outside the card's box passes every assertion
 * above — which is exactly how it once shipped. The stylesheet rules that put
 * the clip over the poster instead of under the card are therefore read out of
 * post-grid.css and asserted directly, at the end of this file.
 */

const POST = {
  id: 1,
  slug: 'a-post',
  title: 'A Post',
  tags: [],
  published_at: '2026-03-01T00:00:00Z',
  media_url: '/2026/03/clip.mp4',
};

describe('PostCard video preview', () => {
  let dom, videos, navigations;

  /**
   * Give every <video> the media API linkedom omits.
   *
   * play/pause/load are simply absent there, and the teardown calls two of
   * them. Recording the calls also makes teardown assertable: a preview that
   * stopped must have paused and dropped its stream, not merely left the
   * element out of the DOM with a download still running behind it.
   */
  function instrumentVideos(document) {
    const made = [];
    const create = document.createElement.bind(document);
    document.createElement = (tag, ...rest) => {
      const el = create(tag, ...rest);
      if (String(tag).toLowerCase() !== 'video') return el;
      el.playCalls = el.pauseCalls = el.loadCalls = 0;
      el.play = () => { el.playCalls++; return Promise.resolve(); };
      el.pause = () => { el.pauseCalls++; };
      el.load = () => { el.loadCalls++; };
      made.push(el);
      return el;
    };
    return made;
  }

  beforeEach(() => {
    dom = setupDOM();
    videos = instrumentVideos(dom.document);
    navigations = [];
    dom.window.addEventListener('app:navigate', (e) => navigations.push(e.detail.path));
    store.set('route', { pathname: '/', query: {} });
    store.set('navTags', []);
  });

  afterEach(() => {
    dom.cleanup();
  });

  /** Mount one card, hover-autoplay on unless the test says otherwise. */
  function mount(post = POST, settings = { enable_video_hover_autoplay: true }) {
    store.set('settings', settings);
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    const component = new PostCard(el, { post });
    component.mount();
    return { component, card: el.querySelector('.post-card') };
  }

  const videoIn = (card) => card.querySelector('video');

  const hoverIn = (card) => fire(card, 'pointerenter', { pointerType: 'mouse' });
  const hoverOut = (card) => fire(card, 'pointerleave', { pointerType: 'mouse' });

  /**
   * One finger tap, in the order a browser emits it.
   *
   * The pointerleave before the click is not decoration — it is the event that
   * would cancel the preview the click is about to start, if enter/leave were
   * not mouse-gated. Every touch assertion here runs through this sequence so
   * that regression cannot pass.
   */
  function tap(card) {
    fire(card, 'pointerdown', { pointerType: 'touch' });
    fire(card, 'pointerleave', { pointerType: 'touch' });
    click(card);
  }

  /** A tap anywhere else on the page — what dismisses a revealed card. */
  const tapAway = () => click(dom.document.body);

  describe('mouse', () => {
    test('hovering in starts a preview from the original, not the poster', () => {
      const { card } = mount();
      hoverIn(card);

      const v = videoIn(card);
      assert.ok(v, 'hover should build a <video>');
      assert.equal(v.src, '/2026/03/clip.mp4');
      assert.equal(v.playCalls, 1);
      assert.equal(v.muted, true, 'an unmuted card would be blocked by autoplay policy');
      assert.equal(v.loop, true);
      assert.equal(v.playsInline, true, 'without this iOS takes the clip fullscreen');
    });

    test('hovering out pauses, drops the stream and removes the element', () => {
      const { card } = mount();
      hoverIn(card);
      const v = videoIn(card);
      hoverOut(card);

      assert.equal(videoIn(card), null, 'element should leave the DOM');
      assert.equal(v.pauseCalls, 1);
      assert.equal(v.loadCalls, 1, 'load() after clearing src is what frees the buffer');
      assert.equal(v.hasAttribute('src'), false);
    });

    test('a second hover does not stack a second element', () => {
      const { card } = mount();
      hoverIn(card);
      hoverIn(card);
      assert.equal(card.querySelectorAll('video').length, 1);
      assert.equal(videos.length, 1, 'no second element should even be built');
    });

    test('the poster stays painted underneath, so a blocked clip shows something', () => {
      const { card } = mount();
      const bg = card.querySelector('.post-card-background');
      hoverIn(card);
      // The poster is an <img> beside the clip now, not a background-image on
      // the box the clip is appended to — so it is the element that has to
      // survive the hover, not a style attribute.
      const poster = bg.querySelector('img');
      assert.ok(poster, 'the poster image should still be in the card');
      assert.match(poster.getAttribute('src'), /clip\.mp4\?s=\d+/);
      assert.equal(bg.getAttribute('style'), null, 'nothing paints via inline style');
      assert.equal(bg.lastElementChild, videoIn(card),
        'the clip is stacked on the poster by document order, so it goes last');
    });

    test('a video with no stored poster leaves the card blank, not broken', () => {
      const { card } = mount();
      const poster = card.querySelector('.post-card-background img');
      // Every rung 404s for a video that never got a poster frame; an <img>
      // that fails paints the browser's broken-image glyph unless it goes.
      poster.dispatchEvent(new dom.window.Event('error'));

      assert.equal(card.querySelector('.post-card-background img'), null);
      assert.ok(card.querySelector('.video-play-indicator'), 'still marked playable');
    });
  });

  describe('touch', () => {
    test('the reveal tap starts the preview and does not open the post', () => {
      const { card } = mount();
      tap(card);

      assert.ok(videoIn(card), 'the tap that reveals the overlay should play the clip');
      assert.equal(videoIn(card).playCalls, 1);
      assert.ok(card.classList.contains('is-touched'), 'overlay should be revealed');
      assert.deepEqual(navigations, [], 'first tap must not navigate');
    });

    test('the tap that opens the post stops the preview', () => {
      const { card } = mount();
      tap(card);
      const v = videoIn(card);
      tap(card);

      assert.deepEqual(navigations, ['/posts/a-post'], 'second tap opens the post');
      assert.equal(videoIn(card), null);
      assert.equal(v.pauseCalls, 1);
    });

    test('tapping away stops the preview along with the overlay', () => {
      const { card } = mount();
      tap(card);
      const v = videoIn(card);
      tapAway();

      assert.equal(card.classList.contains('is-touched'), false);
      assert.equal(videoIn(card), null);
      assert.equal(v.pauseCalls, 1);
      assert.deepEqual(navigations, [], 'dismissing is not opening');
    });

    test('revealing another card stops the first one — one clip at a time', () => {
      const first = mount();
      const second = mount({ ...POST, id: 2, slug: 'other-post' });

      tap(first.card);
      const v = videoIn(first.card);
      tap(second.card);

      assert.equal(first.card.classList.contains('is-touched'), false);
      assert.equal(videoIn(first.card), null, 'the closed card must not keep playing');
      assert.equal(v.pauseCalls, 1);
      assert.ok(videoIn(second.card), 'the newly revealed card plays instead');
      assert.equal(videos.length, 2, 'one element per card, not per tap');
    });

    test('scrolling off a revealed card leaves it playing', () => {
      // The clip belongs to the revealed state, not to the finger: a scroll
      // that happens to start on the card emits a pointerleave, and treating
      // that as a mouse leaving would kill a preview whose overlay is still
      // open. This is what the mouse gate on pointerleave is for.
      const { card } = mount();
      tap(card);
      const v = videoIn(card);

      fire(card, 'pointerdown', { pointerType: 'touch' });
      fire(card, 'pointerleave', { pointerType: 'touch' }); // finger drags away; no click follows

      assert.ok(videoIn(card), 'the preview should survive a scroll gesture');
      assert.equal(v.pauseCalls, 0);
      assert.ok(card.classList.contains('is-touched'), 'and the overlay with it');
    });

    test('a stylus is treated as touch, not as a mouse', () => {
      // The two-tap reveal keys off "not a mouse", so the preview must too.
      const { card } = mount();
      fire(card, 'pointerdown', { pointerType: 'pen' });
      click(card);

      assert.ok(card.classList.contains('is-touched'));
      assert.ok(videoIn(card), 'a pen reveal should play like a finger reveal');
      assert.deepEqual(navigations, []);
    });
  });

  describe('the play glyph', () => {
    // The glyph marks a card as playable. Once the clip is genuinely running it
    // is a label over moving footage, so the card is marked `is-playing` and the
    // stylesheet fades it out — but only on the element's own `playing` event,
    // since a call to play() is a request the browser is free to refuse.
    const startedPlaying = (card) => fire(videoIn(card), 'playing');

    test('a running preview marks the card, hiding the glyph', () => {
      const { card } = mount();
      hoverIn(card);
      assert.equal(card.classList.contains('is-playing'), false,
        'not until frames are actually running');

      startedPlaying(card);
      assert.ok(card.classList.contains('is-playing'));
    });

    test('a clip the browser refused to play keeps its glyph', () => {
      const { card } = mount();
      hoverIn(card);
      // No `playing` event: autoplay policy blocked it, or the decode failed.
      assert.equal(card.classList.contains('is-playing'), false,
        'the card is still a poster frame and needs its marker');
    });

    test('hovering out brings the glyph back', () => {
      const { card } = mount();
      hoverIn(card);
      startedPlaying(card);
      hoverOut(card);

      assert.equal(card.classList.contains('is-playing'), false);
    });

    test('the tap that opens the post brings the glyph back', () => {
      const { card } = mount();
      tap(card);
      startedPlaying(card);
      tap(card);

      assert.equal(card.classList.contains('is-playing'), false);
    });

    test('a card closed by another card revealing brings its glyph back', () => {
      const first = mount();
      const second = mount({ ...POST, id: 2, slug: 'other-post' });

      tap(first.card);
      startedPlaying(first.card);
      tap(second.card);

      assert.equal(first.card.classList.contains('is-playing'), false);
    });
  });

  describe('a video missing its poster frame', () => {
    test('falls back to a paused video element if the poster 404s', () => {
      const { card } = mount();
      
      const poster = card.querySelector('.post-card-background img');
      assert.ok(poster, 'the poster image is initially rendered');
      assert.equal(videoIn(card), null, 'no video element yet');

      fire(poster, 'error');

      assert.equal(card.querySelector('.post-card-background img'), null,
        'the broken image is removed');
      
      const v = videoIn(card);
      assert.ok(v, 'a paused video fallback is appended');
      assert.equal(v.muted, true);
      assert.equal(v.playsInline, true);
      assert.equal(v.preload, 'metadata');
      assert.ok(v.src.endsWith('#t=0.001'), '#t=0.001 is appended to seek to the first frame');
      assert.equal(v.pauseCalls || 0, 0, 'it does not call play or pause directly');
    });

    test('a regular image missing its poster frame stays unpainted', () => {
      const { card } = mount({ ...POST, media_url: '/2026/03/photo.jpg' });
      
      const poster = card.querySelector('.post-card-background img');
      fire(poster, 'error');

      assert.equal(card.querySelector('.post-card-background img'), null);
      assert.equal(videoIn(card), null, 'no video fallback for a regular image');
    });
  });

  describe('when the card should stay a still', () => {
    test('the setting off means no clip on hover or on tap', () => {
      const { card } = mount(POST, {});

      hoverIn(card);
      assert.equal(videoIn(card), null, 'hover must not play with the setting off');

      tap(card);
      assert.ok(card.classList.contains('is-touched'), 'tapping still reveals the overlay');
      assert.equal(videoIn(card), null, 'tap must not play with the setting off');
      assert.equal(videos.length, 0, 'nothing should be built at all');
    });

    test('an image card is left alone by both gestures', () => {
      const { card } = mount({ ...POST, media_url: '/2026/03/photo.jpg' });

      hoverIn(card);
      tap(card);

      assert.ok(card.classList.contains('is-touched'), 'the two-tap reveal is unaffected');
      assert.equal(videos.length, 0);
    });

    test('a text-only card has no background to play into', () => {
      const { card } = mount({ ...POST, media_url: null });

      hoverIn(card);
      click(card);

      assert.equal(videos.length, 0);
      assert.deepEqual(navigations, ['/posts/a-post'], 'no overlay, so one click opens it');
    });
  });

  describe('teardown', () => {
    test('unmounting stops a preview that is still running', () => {
      const { component, card } = mount();
      hoverIn(card);
      const v = videoIn(card);

      component.unmount();

      assert.equal(v.pauseCalls, 1);
      assert.equal(v.loadCalls, 1);
    });

    test('a card unmounted mid-preview does not stop the next card that plays', () => {
      // The cross-card handoff is module state; an instance that leaves while
      // holding it must release it, or the next card to be tapped is stopped
      // by a component that no longer exists.
      const first = mount();
      const second = mount({ ...POST, id: 2, slug: 'other-post' });

      tap(first.card);
      first.component.unmount();
      tap(second.card);

      assert.ok(videoIn(second.card), 'second card should still be playing');
      assert.equal(videoIn(second.card).pauseCalls, 0);
    });

    test('re-rendering does not leave a preview from the previous render playing', () => {
      const { component, card } = mount();
      hoverIn(card);
      const v = videoIn(card);

      component.setProps({ showViewCount: true });

      assert.equal(v.pauseCalls, 1, 'the old element belongs to a DOM that is gone');
    });
  });
});

/**
 * The stylesheet half of the preview.
 *
 * The clip is appended into `.post-card-background` next to a poster `<img>`
 * that is already there, so where it ends up is decided entirely in CSS. Left
 * in normal flow the two boxes stack vertically and the video is laid out below
 * the card, which `.post-card { overflow: hidden }` then clips away — a preview
 * that plays, streams and tears down exactly as every test above asserts, and
 * is never once visible. Nothing in a DOM without layout can catch that, so the
 * rules it depends on are read out of the stylesheet and checked by name.
 *
 * Source CSS only: light.css/main.css are built from these by build-css.sh.
 */
describe('PostCard video preview — layout rules', () => {
  const CSS = readFileSync(
    fileURLToPath(new URL('../css/public/post-grid.css', import.meta.url)),
    'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '');

  /**
   * Every declaration that reaches `selector`, as a Map.
   *
   * A rule counts when the selector appears in its comma-separated list, so a
   * pair written as one rule and as two read the same. At-rule wrappers are not
   * modelled — the inner rules simply read as top-level, which is accurate
   * enough here because none of the selectors below are nested in one.
   */
  function declsFor(selector) {
    const decls = new Map();
    for (const [, sel, body] of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!sel.split(',').some((s) => s.trim() === selector)) continue;
      for (const d of body.split(';')) {
        const i = d.indexOf(':');
        if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
      }
    }
    return decls;
  }

  for (const selector of ['.post-card-background img', '.post-card-background video']) {
    test(`${selector} is taken out of flow, so both fill the same box`, () => {
      const d = declsFor(selector);
      assert.equal(d.get('position'), 'absolute',
        'in flow the two children stack vertically instead of overlapping');
      assert.equal(d.get('inset'), '0', 'and the box they share is the card');
      assert.equal(d.get('object-fit'), 'cover');
    });
  }

  test('the poster is hidden while the clip is running', () => {
    assert.equal(
      declsFor('.post-card.is-playing .post-card-background img').get('opacity'), '0',
      'otherwise a still is painted over the first frames of its own footage');
    assert.equal(
      declsFor('.post-card.is-playing .post-card-background img').get('transition'), undefined,
      'fading it back would leave the card blank — the video element is already gone');
  });

  test('the hover scale still reaches whichever of the two is showing', () => {
    for (const el of ['img', 'video']) {
      assert.equal(
        declsFor(`:where(html.pointer-fine) .post-card:hover .post-card-background ${el}`)
          .get('transform'),
        'scale(1.05)');
    }
  });

  test('nothing paints through the container itself any more', () => {
    // The poster was a background-image on this box before it needed a srcset.
    const d = declsFor('.post-card-background');
    for (const prop of ['background', 'background-image', 'background-size',
      'background-position', 'background-repeat']) {
      assert.equal(d.get(prop), undefined, `${prop} is a leftover of that arrangement`);
    }
  });
});
