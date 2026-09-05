/**
 * CarouselStudioPage — the carousel plugin's admin shell at /light/carousel.
 *
 * The route is param-less (plugin admin routes are filtered on the /light
 * prefix and titled from their last segment), so the target post rides in
 * `?post=<id>`. These tests pin that contract plus the C7 splitter shell: a
 * valid id loads the post and its carousel document; a missing or junk id
 * renders the empty state; an existing document restores the source, slide
 * count and aspect.
 *
 * Since S2 the page holds ONE `CarouselDoc` as its state — there is no loose
 * `n`/`strategy`/`anchorY` to assert on, so every expectation about what the
 * user changed reads `page.state.doc`. The deck-mode block at the bottom covers
 * the framing half: the split → deck freeze is invisible, a pan moves one
 * slide, and only that slide re-uploads.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, fire } from './helpers/dom.js';
import { setSettings, setUser } from '../src/store.js';
import { backgroundFit, deckSlideFitCSS } from '../src/plugins/carousel/geometry.js';
import {
  specHash,
  splitDocument,
  toDeckDocument,
} from '../src/plugins/carousel/document.js';

/** Route `fetch` by URL; unmatched paths 404. */
function installFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) {
        const res = typeof handler === 'function' ? handler(url, opts) : handler;
        return {
          status: res.status ?? 200,
          ok: (res.status ?? 200) < 400,
          headers: { get: () => 'application/json' },
          json: async () => res.body ?? null,
        };
      }
    }
    return {
      status: 404,
      ok: false,
      headers: { get: () => 'application/json' },
      json: async () => ({ message: 'not found' }),
    };
  };
  return calls;
}

const POST = {
  id: 42,
  title: 'A post',
  slug: 'a-post',
  content: 'Some copy.',
  status: 'draft',
  type: 'post',
  formatter: 'markdown',
  tags: [],
};

describe('CarouselStudioPage', () => {
  let dom, CarouselStudioPage, page, calls;
  const settle = () => new Promise((r) => setImmediate(r));

  async function mount(query, routes, props = {}) {
    calls = installFetch(
      routes || [
        [/\/api\/posts\/42/, { body: POST }],
        [/\/api\/carousel/, { status: 404, body: { message: 'no carousel' } }],
      ],
    );
    dom.location.pathname = '/light/carousel';
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new CarouselStudioPage(el, { params: {}, query, ...props });
    page.mount();
    await settle();
    await settle();
    return el;
  }

  /**
   * A render backend that never touches a real canvas or the network: a
   * fixed-size decoded strip, no-op surface, a labelled blob, and an `upload`
   * the test supplies to control which media rows come back.
   */
  function fakeRenderDeps(upload, deleteMedia) {
    return {
      fetchBlob: async () => new Blob(['src']),
      probeSize: async () => ({ w: 3000, h: 1000 }),
      decode: async (blob, o) => ({ width: o.resizeWidth, height: o.resizeHeight, close() {} }),
      // save/restore/filter cover paintSlide's blur-pad branch (the last slide
      // of a `pad` deck when its tail is narrower than a full column).
      makeSurface: () => ({
        canvas: {},
        ctx: {
          clearRect() {},
          drawImage() {},
          save() {},
          restore() {},
          fillRect() {},
          createLinearGradient: () => ({ addColorStop() {} }),
        },
      }),
      encode: async () => new Blob(['jpg']),
      upload,
      deleteMedia: deleteMedia || (async () => {}),
    };
  }

  beforeEach(async () => {
    dom = setupDOM();
    setUser({ username: 'owner', is_admin: true });
    setSettings({ blog_title: 'Test blog' });
    ({ default: CarouselStudioPage } = await import(
      '../src/plugins/carousel/index.js'
    ));
  });

  afterEach(() => {
    page?.unmount();
    page = null;
    dom.cleanup();
  });

  test('a valid ?post= loads the post and shows the pick prompt', async () => {
    const el = await mount({ post: '42' });
    const studio = el.querySelector('.carousel-studio');
    assert.ok(studio, 'studio section rendered');
    assert.equal(studio.dataset.postId, '42');
    assert.ok(el.querySelector('[data-action="back-to-post"]'), 'back-to-post control shown');
    assert.ok(el.querySelector('[data-action="pick-source"]'), 'pick prompt shown');
    assert.ok(!el.querySelector('.carousel-studio--empty'), 'not the empty state');
  });

  test('the back-to-post control navigates to the post editor', async () => {
    const el = await mount({ post: '42' });
    const seen = [];
    dom.window.addEventListener('app:navigate', (e) => seen.push(e.detail.path));
    click(el.querySelector('[data-action="back-to-post"]'));
    assert.deepStrictEqual(seen, ['/light/posts/42/edit']);
  });

  test('an existing carousel document restores source, slide count and aspect', async () => {
    const doc = {
      version: 1,
      aspect: '1:1',
      mode: 'split',
      slides: [
        { source: '/2026/08/wide.jpg', rendered: { path: '/2026/08/s1.jpg' } },
        { source: '/2026/08/wide.jpg', rendered: { path: '/2026/08/s2.jpg' } },
        { source: '/2026/08/wide.jpg', rendered: { path: '/2026/08/s3.jpg' } },
        { source: '/2026/08/wide.jpg', rendered: { path: '/2026/08/s4.jpg' } },
      ],
    };
    const el = await mount({ post: '42' }, [
      [/\/api\/posts\/42/, { body: POST }],
      [/\/api\/carousel/, { body: { post_id: 42, doc } }],
    ]);

    assert.ok(el.querySelector('.carousel-studio__builder'), 'builder shown');
    assert.equal(page.state.doc.slides[0].source, '/2026/08/wide.jpg');
    assert.equal(page.state.doc.slides.length, 4);
    assert.equal(page.state.doc.aspect, '1:1');
    assert.equal(el.querySelectorAll('.carousel-studio__slide').length, 4, 'rendered slides shown');
    // 4 columns → 3 dividers.
    assert.equal(el.querySelectorAll('.carousel-studio__divider').length, 3);
  });

  test('changing the slide count re-renders the preview', async () => {
    const el = await mount({ post: '42' }, [
      [/\/api\/posts\/42/, { body: POST }],
      [/\/api\/carousel/, { body: { post_id: 42, doc: { slides: [{ source: '/2026/08/w.jpg' }, { source: '/2026/08/w.jpg' }] } } }],
    ]);
    assert.equal(el.querySelectorAll('.carousel-studio__frame').length, 2);

    const range = el.querySelector('#carousel-n');
    range.value = '5';
    range.dispatchEvent(new dom.window.Event('change'));
    await settle();

    assert.equal(page.state.doc.slides.length, 5);
    assert.equal(el.querySelectorAll('.carousel-studio__frame').length, 5);
  });

  test('no ?post= renders the empty state', async () => {
    const el = await mount(undefined);
    assert.ok(el.querySelector('.carousel-studio--empty'), 'empty state rendered');
    assert.ok(!el.querySelector('[data-post-id]'), 'no post-bound stage');
  });

  test('a non-numeric ?post= is rejected, not passed through', async () => {
    const el = await mount({ post: '7; drop table' });
    assert.ok(el.querySelector('.carousel-studio--empty'), 'falls back to empty state');
  });

  test('the page titles itself "Carousel Studio"', async () => {
    const el = await mount({ post: '42' });
    assert.equal(
      el.querySelector('.light-header h1')?.textContent.trim(),
      'Carousel Studio',
    );
  });

  describe('fit panel', () => {
    /** A doc of `n` split slides from one source, plus render deps whose probe
     *  reports a fixed source size. */
    function sized(n, w, h) {
      const doc = {
        version: 1,
        aspect: '4:5',
        mode: 'split',
        slides: Array.from({ length: n }, () => ({ source: '/2026/08/pano.jpg' })),
      };
      const routes = [
        [/\/api\/posts\/42/, { body: POST }],
        [/\/api\/carousel/, { body: { post_id: 42, doc } }],
      ];
      const deps = { ...fakeRenderDeps(async () => ({})), probeSize: async () => ({ w, h }) };
      return { routes, deps };
    }

    test('shows the source size, the fractional slide count and a live readout', async () => {
      const { routes, deps } = sized(4, 4096, 2731);
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });

      const panel = el.querySelector('.carousel-studio__fit');
      assert.ok(panel, 'fit panel rendered');
      assert.equal(page.state.srcW, 4096);

      const dims = panel.querySelector('.carousel-studio__fit-dims').textContent.replace(/\s+/g, ' ');
      assert.match(dims, /4096 × 2731/);
      assert.match(dims, /1080 × 1350/);
      assert.match(dims, /3\.79 slides/);

      // n=4 cover across a 4096-wide source: scale 4320/4096 ≈ 1.055 → upscale.
      const readout = panel.querySelector('.carousel-studio__fit-readout').textContent.trim();
      assert.match(readout, /^4 slides/);
      assert.match(readout, /105\.5% scale/);
      assert.match(readout, /0 px trimmed/);
      assert.match(readout, /full bleed/);
      assert.ok(panel.querySelector('.carousel-studio__fit-warning'), 'upscale warning row');
      assert.ok(panel.querySelector('#carousel-anchor'), 'anchor slider shown (vertical slack)');
    });

    test('no panel until the source size is known', async () => {
      const doc = { version: 1, aspect: '4:5', mode: 'split', slides: [{ source: '/x.jpg' }] };
      const el = await mount({ post: '42' }, [
        [/\/api\/posts\/42/, { body: POST }],
        [/\/api\/carousel/, { body: { post_id: 42, doc } }],
      ], { renderDeps: { ...fakeRenderDeps(async () => ({})), probeSize: async () => { throw new Error('no'); } } });

      assert.ok(el.querySelector('.carousel-studio__builder'), 'builder still renders');
      assert.ok(!el.querySelector('.carousel-studio__fit'), 'fit panel hidden');
    });

    test('a chip click sets the slide count AND the strategy', async () => {
      // 4096×2000, 4:5: exact → floor(4096/1080)=3, pad → ceil=4.
      const { routes, deps } = sized(2, 4096, 2000);
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });

      const chips = [...el.querySelectorAll('.carousel-studio__chip')];
      const exact = chips.find((c) => c.dataset.strategy === 'exact');
      assert.ok(exact, 'an exact chip is offered');
      assert.equal(exact.dataset.n, '3');

      click(exact);
      await settle();

      assert.equal(page.state.doc.strategy, 'exact');
      assert.equal(page.state.doc.slides.length, 3);
      assert.equal(el.querySelectorAll('.carousel-studio__frame').length, 3, 'preview follows');
    });

    test('the Pad radio snaps the count to what pad makes and stores the strategy', async () => {
      const { routes, deps } = sized(2, 4096, 2000);
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });

      const pad = [...el.querySelectorAll('input[name="carousel-fit"]')].find((r) => r.value === 'pad');
      assert.ok(pad);
      fire(pad, 'change');
      await settle();

      assert.equal(page.state.doc.strategy, 'pad');
      assert.equal(page.state.doc.slides.length, 4); // ceil(4096/1080)
    });

    test('dragging the slider drops back to a free cover count', async () => {
      const { routes, deps } = sized(2, 4096, 2000);
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });

      const exact = [...el.querySelectorAll('.carousel-studio__chip')].find((c) => c.dataset.strategy === 'exact');
      click(exact);
      await settle();
      assert.equal(page.state.doc.strategy, 'exact');

      const range = el.querySelector('#carousel-n');
      range.value = '6';
      fire(range, 'change');
      await settle();

      assert.equal(page.state.doc.slides.length, 6);
      assert.equal(page.state.doc.strategy, 'cover');
    });

    test('the chosen strategy and anchorY are written into the saved document', async () => {
      const doc = { version: 1, aspect: '4:5', mode: 'split', slides: [
        { source: '/2026/08/pano.jpg' }, { source: '/2026/08/pano.jpg' }, { source: '/2026/08/pano.jpg' },
      ] };
      const saved = [];
      const routes = [
        [/\/api\/posts\/42$/, (url, opts) => (opts.method === 'PUT' ? { body: {} } : { body: POST })],
        [/\/api\/carousel/, (url, opts) => {
          if (opts.method === 'PUT') {
            saved.push(JSON.parse(opts.body).doc);
            return { body: {} };
          }
          return { body: { post_id: 42, doc } };
        }],
        [/\/api\/media\/\d+$/, { body: {} }],
      ];
      let k = 0;
      const deps = {
        ...fakeRenderDeps(async () => {
          k += 1;
          return { id: 900 + k, path: `/2026/08/s${k}.jpg` };
        }),
        probeSize: async () => ({ w: 4096, h: 2000 }),
      };
      await mount({ post: '42' }, routes, { renderDeps: deps });

      const pad = [...page.container.querySelectorAll('input[name="carousel-fit"]')].find((r) => r.value === 'pad');
      fire(pad, 'change');
      await settle();
      const anchor = page.container.querySelector('#carousel-anchor');
      anchor.value = '0.25';
      fire(anchor, 'change');
      await settle();

      await page._render();
      await settle();

      assert.equal(saved.length, 1, 'carousel document saved once');
      assert.equal(saved[0].strategy, 'pad');
      assert.equal(saved[0].anchorY, 0.25);
    });
  });

  describe('filmstrip/stage background crop', () => {
    /** A doc of `n` split slides from one source, plus render deps whose
     *  probe reports a fixed source size — mirrors `sized()` above. */
    function sized(n, w, h, strategy) {
      const doc = {
        version: 1,
        aspect: '4:5',
        mode: 'split',
        strategy,
        slides: Array.from({ length: n }, () => ({ source: '/2026/08/pano.jpg' })),
      };
      const routes = [
        [/\/api\/posts\/42/, { body: POST }],
        [/\/api\/carousel/, { body: { post_id: 42, doc } }],
      ];
      const deps = { ...fakeRenderDeps(async () => ({})), probeSize: async () => ({ w, h }) };
      return { routes, deps };
    }

    /** Parse `"12.3% 45.6%, 100% 100%"` into `[12.3, 45.6]` — the first
     *  (image) layer only; the second is always the pad hatch. */
    const firstLayer = (css) =>
      css.split(',')[0].trim().split(/\s+/).map((v) => Number(v.replace('%', '')));

    test('cover: the stage and every frame carry the computed crop, not a stretch', async () => {
      const { routes, deps } = sized(3, 4096, 2000, 'cover');
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });

      const stage = el.querySelector('.carousel-studio__stage');
      const expectedStage = backgroundFit(4096, 2000, '4:5', 3, 'cover', 0.5, 3, 0);
      assert.deepEqual(firstLayer(stage.style.backgroundSize), expectedStage.size);
      assert.deepEqual(firstLayer(stage.style.backgroundPosition), expectedStage.position);

      const frames = [...el.querySelectorAll('.carousel-studio__frame')];
      assert.equal(frames.length, 3);
      frames.forEach((frame, i) => {
        const expected = backgroundFit(4096, 2000, '4:5', 3, 'cover', 0.5, 1, i);
        assert.deepEqual(firstLayer(frame.style.backgroundSize), expected.size);
        assert.deepEqual(firstLayer(frame.style.backgroundPosition), expected.position);
      });

      // Every frame carries the pad-hatch layer too (harmless — hidden
      // behind an opaque image whenever there's no gap to show it in).
      frames.forEach((frame) => {
        assert.match(frame.style.backgroundImage, /repeating-linear-gradient/);
      });
    });

    test('exact: the deck sits centred, matching the fit panel readout', async () => {
      const { routes, deps } = sized(3, 4096, 2000, 'exact');
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });

      const stage = el.querySelector('.carousel-studio__stage');
      const [, stagePosY] = firstLayer(stage.style.backgroundPosition);
      assert.equal(firstLayer(stage.style.backgroundPosition)[0], 50);
      assert.equal(stagePosY, 50); // default anchorY

      const frames = [...el.querySelectorAll('.carousel-studio__frame')];
      const first = frames[0];
      const last = frames[frames.length - 1];
      const [firstX] = firstLayer(first.style.backgroundPosition);
      const [lastX] = firstLayer(last.style.backgroundPosition);
      assert.ok(Math.abs(firstX + lastX - 100) < 1e-6, 'first/last frames mirror the centred trim');
    });

    test('pad: the padded last frame exposes the hatch layer, not a stretched image', async () => {
      const { routes, deps } = sized(4, 4096, 2000, 'pad');
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });

      const stage = el.querySelector('.carousel-studio__stage');
      assert.equal(firstLayer(stage.style.backgroundPosition)[0], 0, 'flush-left, not centred');

      const frames = [...el.querySelectorAll('.carousel-studio__frame')];
      const last = frames[frames.length - 1];
      const [sizeX] = firstLayer(last.style.backgroundSize);
      const [posX] = firstLayer(last.style.backgroundPosition);
      // Recover the visible image's right edge inside the 1080-wide frame and
      // confirm the gap beyond it is the padPx the fit panel reports (224).
      const boxW = 1080;
      const bgWpx = (sizeX / 100) * boxW;
      const offsetXpx = (boxW - bgWpx) * (posX / 100);
      const imageRightEdgePx = offsetXpx + bgWpx;
      assert.ok(Math.abs(boxW - imageRightEdgePx - 224) < 1e-6);
      // The hatch layer is present to fill exactly that gap.
      assert.match(last.style.backgroundImage, /repeating-linear-gradient/);
    });

    test('dimensions unknown: falls back to a plain stretch instead of crashing', async () => {
      const doc = { version: 1, aspect: '4:5', mode: 'split', slides: [{ source: '/x.jpg' }, { source: '/x.jpg' }] };
      const el = await mount({ post: '42' }, [
        [/\/api\/posts\/42/, { body: POST }],
        [/\/api\/carousel/, { body: { post_id: 42, doc } }],
      ], { renderDeps: { ...fakeRenderDeps(async () => ({})), probeSize: async () => { throw new Error('no'); } } });

      const stage = el.querySelector('.carousel-studio__stage');
      assert.ok(stage.style.backgroundImage, 'stage still gets an image');
      const frames = [...el.querySelectorAll('.carousel-studio__frame')];
      assert.equal(frames.length, 2);
      assert.equal(firstLayer(frames[0].style.backgroundPosition)[0], 0);
      assert.equal(firstLayer(frames[1].style.backgroundPosition)[0], 100);
    });
  });

  describe('re-render', () => {
    const CAROUSEL_POST = {
      ...POST,
      content:
        ':::{.carousel-block}\n\n/2026/08/old1.jpg\n\n/2026/08/old2.jpg\n\n:::',
    };
    const priorDoc = {
      version: 1,
      aspect: '4:5',
      mode: 'split',
      slides: [
        { source: '/2026/08/w.jpg', rendered: { path: '/2026/08/old1.jpg', media_id: 100 } },
        { source: '/2026/08/w.jpg', rendered: { path: '/2026/08/old2.jpg', media_id: 101 } },
      ],
    };

    /** Routes for a post that already has a rendered carousel. */
    function routes(post = CAROUSEL_POST, doc = priorDoc) {
      return [
        [/\/api\/posts\/42$/, (url, opts) =>
          opts.method === 'PUT' ? { body: {} } : { body: post }],
        [/\/api\/carousel/, (url, opts) =>
          opts.method === 'PUT' ? { body: {} } : { body: { post_id: 42, doc } }],
        [/\/api\/media\/\d+$/, { body: {} }],
      ];
    }

    test('deletes the superseded slide rows on re-render', async () => {
      let n = 0;
      const deps = fakeRenderDeps(async () => {
        n += 1;
        return { id: 200 + n, path: `/2026/08/new${n}.jpg` };
      });
      await mount({ post: '42' }, routes(), { renderDeps: deps });

      await page._render();
      await settle();

      const deletes = calls
        .filter((c) => c.method === 'DELETE' && /\/api\/media\/\d+$/.test(c.url))
        .map((c) => c.url.match(/\/api\/media\/(\d+)$/)[1]);
      assert.deepEqual(deletes.sort(), ['100', '101']);
      assert.deepEqual(
        page._priorRendered.map((r) => r.media_id).sort(),
        [201, 202],
      );
    });

    test('keeps a superseded slide whose path is still used elsewhere', async () => {
      const post = {
        ...CAROUSEL_POST,
        content: `![keep](/2026/08/old1.jpg)\n\n${CAROUSEL_POST.content}`,
      };
      let n = 0;
      const deps = fakeRenderDeps(async () => {
        n += 1;
        return { id: 300 + n, path: `/2026/08/fresh${n}.jpg` };
      });
      await mount({ post: '42' }, routes(post), { renderDeps: deps });

      await page._render();
      await settle();

      const deletes = calls
        .filter((c) => c.method === 'DELETE' && /\/api\/media\/\d+$/.test(c.url))
        .map((c) => c.url.match(/\/api\/media\/(\d+)$/)[1]);
      assert.deepEqual(deletes, ['101'], 'only the unreferenced slide is deleted');
    });

    test('refuses byte-identical slides and saves nothing', async () => {
      const deps = fakeRenderDeps(async () => ({ id: 500, path: '/2026/08/dup.jpg' }));
      await mount({ post: '42' }, routes(), { renderDeps: deps });

      await page._render();
      await settle();

      assert.match(page.state.error, /identical/i);
      assert.ok(
        !calls.some((c) => c.method === 'PUT' && /\/api\/carousel/.test(c.url)),
        'carousel document was not saved',
      );
      assert.ok(
        !calls.some((c) => c.method === 'PUT' && /\/api\/posts\/42$/.test(c.url)),
        'post content was not written',
      );
    });

    test('a mid-loop upload failure deletes what it uploaded, and touches nothing else', async () => {
      let n = 0;
      const deleted = [];
      const deps = fakeRenderDeps(
        async () => {
          n += 1;
          if (n === 2) throw new Error('upload failed');
          return { id: 200 + n, path: `/2026/08/new${n}.jpg` };
        },
        async (id) => { deleted.push(id); },
      );
      await mount({ post: '42' }, routes(), { renderDeps: deps });

      await page._render();
      await settle();

      assert.match(page.state.error, /upload failed/);
      assert.deepEqual(deleted, [201], 'the one slide uploaded before the failure is unwound');
      assert.ok(
        !calls.some((c) => c.method === 'PUT' && /\/api\/carousel/.test(c.url)),
        'nothing was saved after the failed render',
      );
      assert.ok(
        !calls.some((c) => c.method === 'DELETE' && /\/api\/media\/(100|101)$/.test(c.url)),
        'the pre-existing slides were never touched',
      );
    });
  });

  describe('render lifecycle', () => {
    test('progress is exposed on state while busy, and cleared once the render settles', async () => {
      const el = await mount({ post: '42' }, undefined, {
        renderDeps: fakeRenderDeps(async () => ({ id: 1, path: '/2026/08/s1.jpg' })),
      });
      click(el.querySelector('[data-action="pick-source"]'));
      page._picker.props.onConfirm([{ path: '/2026/08/pano.jpg', width: 3000, height: 1000 }]);
      await settle();

      const run = page._render();
      assert.deepEqual(page.state.renderProgress, {
        done: 0,
        total: page.state.doc.slides.length,
      });
      assert.ok(page.state.busy);
      await run;

      assert.equal(page.state.renderProgress, null);
      assert.equal(page.state.busy, false);
    });

    test('changing a control after a render marks the studio dirty; re-rendering clears it', async () => {
      const doc = {
        version: 1,
        aspect: '4:5',
        mode: 'split',
        slides: [
          { source: '/2026/08/w.jpg', rendered: { path: '/2026/08/old1.jpg', media_id: 100 } },
          { source: '/2026/08/w.jpg', rendered: { path: '/2026/08/old2.jpg', media_id: 101 } },
        ],
      };
      const routes = [
        [/\/api\/posts\/42$/, (url, opts) => (opts.method === 'PUT' ? { body: {} } : { body: POST })],
        [/\/api\/carousel/, (url, opts) => (opts.method === 'PUT' ? { body: {} } : { body: { post_id: 42, doc } })],
        [/\/api\/media\/\d+$/, { body: {} }],
      ];
      let k = 0;
      const deps = fakeRenderDeps(async () => {
        k += 1;
        return { id: 900 + k, path: `/2026/08/s${k}.jpg` };
      });
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });

      assert.ok(!el.querySelector('.carousel-studio__dirty-badge'), 'not dirty right after load');

      const range = el.querySelector('#carousel-n');
      range.value = '3';
      fire(range, 'change');
      await settle();

      assert.ok(el.querySelector('.carousel-studio__dirty-badge'), 'dirty after the count changes');

      await page._render();
      await settle();

      assert.ok(!el.querySelector('.carousel-studio__dirty-badge'), 'clean again after render');
    });

    test('a slide whose specHash is unchanged is neither re-uploaded nor deleted', async () => {
      const spec = { source: '/2026/08/w.jpg', n: 3, aspect: '4:5', strategy: 'cover', anchorY: 0.5 };
      const doc = splitDocument(spec);
      doc.slides.forEach((s, i) => {
        s.rendered = {
          path: `/2026/08/old${i + 1}.jpg`,
          media_id: 100 + i,
          specHash: specHash(s, spec.aspect, { strategy: spec.strategy, anchorY: spec.anchorY }),
        };
      });
      const routes = [
        [/\/api\/posts\/42$/, (url, opts) => (opts.method === 'PUT' ? { body: {} } : { body: POST })],
        [/\/api\/carousel/, (url, opts) => (opts.method === 'PUT' ? { body: {} } : { body: { post_id: 42, doc } })],
        [/\/api\/media\/\d+$/, { body: {} }],
      ];
      let uploadCount = 0;
      const deps = fakeRenderDeps(async () => {
        uploadCount += 1;
        throw new Error('should not upload an unchanged slide');
      });
      await mount({ post: '42' }, routes, { renderDeps: deps });

      await page._render();
      await settle();

      assert.equal(page.state.error, null);
      assert.equal(uploadCount, 0, 'no slide was re-encoded/re-uploaded');
      assert.deepEqual(
        page.state.doc.slides.map((s) => s.rendered.path),
        ['/2026/08/old1.jpg', '/2026/08/old2.jpg', '/2026/08/old3.jpg'],
      );
      assert.ok(
        !calls.some((c) => c.method === 'DELETE' && /\/api\/media\/\d+$/.test(c.url)),
        'nothing superseded — every kept slide is still referenced',
      );
    });
  });

  describe('remove carousel', () => {
    const CAROUSEL_POST = {
      ...POST,
      content: ':::{.carousel-block}\n\n/2026/08/old1.jpg\n\n/2026/08/old2.jpg\n\n:::',
    };
    const priorDoc = {
      version: 1,
      aspect: '4:5',
      mode: 'split',
      slides: [
        { source: '/2026/08/w.jpg', rendered: { path: '/2026/08/old1.jpg', media_id: 100 } },
        { source: '/2026/08/w.jpg', rendered: { path: '/2026/08/old2.jpg', media_id: 101 } },
      ],
    };

    function routes() {
      return [
        [/\/api\/posts\/42$/, (url, opts) => (opts.method === 'PUT' ? { body: {} } : { body: CAROUSEL_POST })],
        [/\/api\/carousel/, (url, opts) =>
          opts.method === 'DELETE' || opts.method === 'PUT'
            ? { body: {} }
            : { body: { post_id: 42, doc: priorDoc } }],
        [/\/api\/media\/\d+$/, { body: {} }],
      ];
    }

    test('shows a Remove carousel action once a carousel exists', async () => {
      const el = await mount({ post: '42' }, routes(), { renderDeps: fakeRenderDeps(async () => ({})) });
      assert.ok(el.querySelector('[data-action="remove-carousel"]'), 'remove action shown');
    });

    test('no Remove action before anything has ever been rendered', async () => {
      const el = await mount({ post: '42' });
      assert.ok(!el.querySelector('[data-action="remove-carousel"]'));
    });

    test('confirming Remove deletes the document, clears the fence, and deletes the slide media', async () => {
      const el = await mount({ post: '42' }, routes(), { renderDeps: fakeRenderDeps(async () => ({})) });
      let confirmed = null;
      page._showConfirm = (title, message, confirmText, variant, onConfirm) => {
        confirmed = { title, variant };
        onConfirm();
      };

      click(el.querySelector('[data-action="remove-carousel"]'));
      await settle();
      await settle();

      assert.ok(confirmed, 'a confirmation was shown');
      assert.equal(confirmed.variant, 'danger');
      assert.ok(calls.some((c) => c.method === 'DELETE' && /\/api\/carousel/.test(c.url)), 'the document was deleted');
      const mediaDeletes = calls
        .filter((c) => c.method === 'DELETE' && /\/api\/media\/\d+$/.test(c.url))
        .map((c) => c.url.match(/\/api\/media\/(\d+)$/)[1]);
      assert.deepEqual(mediaDeletes.sort(), ['100', '101']);

      const postPut = calls.find((c) => c.method === 'PUT' && /\/api\/posts\/42$/.test(c.url));
      assert.ok(postPut, 'post content was rewritten');
      assert.ok(!JSON.parse(postPut.body).content.includes('carousel-block'), 'the fence is gone');

      assert.deepEqual(page.state.doc.slides, [], 'the document is empty again');
      assert.equal(page.state.hasCarousel, false);
      assert.ok(!el.querySelector('[data-action="remove-carousel"]'), 'action hidden after removal');
    });
  });

  describe('deck mode', () => {
    const SRC = '/2026/08/pano.jpg';
    const SRC_W = 4096;
    const SRC_H = 2000;

    /** A split doc of `n` slides from one source, and deps that probe it. */
    function split(n, extra = {}) {
      const doc = {
        version: 1,
        aspect: '4:5',
        mode: 'split',
        strategy: 'cover',
        slides: Array.from({ length: n }, () => ({ source: SRC })),
        ...extra,
      };
      const routes = [
        [/\/api\/posts\/42$/, (url, opts) => (opts.method === 'PUT' ? { body: {} } : { body: POST })],
        [/\/api\/carousel/, (url, opts) =>
          opts.method === 'PUT' ? { body: {} } : { body: { post_id: 42, doc } }],
        [/\/api\/media\/\d+$/, { body: {} }],
      ];
      const deps = {
        ...fakeRenderDeps(async () => ({})),
        probeSize: async () => ({ w: SRC_W, h: SRC_H }),
      };
      return { routes, deps };
    }

    /** `"300% 117.2%"` → `[300, 117.2]`. Deck frames carry one layer only — the
     *  hatch is the parent frame's, so the letterbox shows through it. */
    const pair = (css) => css.trim().split(/\s+/).map((v) => Number(v.replace('%', '')));

    const deckImg = (el, i) =>
      el.querySelector(`.carousel-studio__frame--deck[data-slice="${i}"] .carousel-studio__frame-img`);

    /** linkedom has no layout, and the pan converts pixels to crop units — give
     *  the image element the box a browser would have measured. */
    function withBox(img, width = 216, height = 270) {
      img.getBoundingClientRect = () => ({
        width, height, left: 0, top: 0, right: width, bottom: height,
      });
      return img;
    }

    function drag(frame, img, dx, dy) {
      withBox(img);
      fire(frame, 'pointerdown', { pointerId: 1, button: 0, clientX: 200, clientY: 200 });
      fire(frame, 'pointermove', { pointerId: 1, clientX: 200 + dx, clientY: 200 + dy });
      return () => fire(frame, 'pointerup', { pointerId: 1, clientX: 200 + dx, clientY: 200 + dy });
    }

    async function toDeck(query = { post: '42' }, n = 3) {
      const { routes, deps } = split(n);
      const el = await mount(query, routes, { renderDeps: deps });
      click(el.querySelector('[data-action="mode"][data-mode="deck"]'));
      await settle();
      return el;
    }

    test('the Deck toggle is unavailable until the source size is known', async () => {
      const doc = { version: 1, aspect: '4:5', mode: 'split', slides: [{ source: SRC }, { source: SRC }] };
      const el = await mount({ post: '42' }, [
        [/\/api\/posts\/42/, { body: POST }],
        [/\/api\/carousel/, { body: { post_id: 42, doc } }],
      ], {
        renderDeps: {
          ...fakeRenderDeps(async () => ({})),
          probeSize: async () => { throw new Error('no dimensions'); },
        },
      });

      const deck = el.querySelector('[data-action="mode"][data-mode="deck"]');
      assert.ok(deck, 'the toggle is still shown');
      assert.ok(deck.hasAttribute('disabled'), 'but cannot be used without source pixels');
      click(deck);
      await settle();
      assert.equal(page.state.doc.mode, 'split');
    });

    test('switching to deck freezes the split projection — the preview does not move', async () => {
      const el = await toDeck();
      assert.equal(page.state.doc.mode, 'deck');

      // Each deck slide must land where `backgroundFit` was putting the split
      // column. Not bit-identical: `deckSlideRects` re-derives the frame aspect
      // from the rounded crop, which can shift the source rect by a pixel (see
      // toDeckDocument) — hence a tolerance rather than deepEqual.
      for (let i = 0; i < 3; i++) {
        const img = deckImg(el, i);
        assert.ok(img, `slide ${i} has an image layer`);
        const wanted = backgroundFit(SRC_W, SRC_H, '4:5', 3, 'cover', 0.5, 1, i);
        const size = pair(img.style.backgroundSize);
        const position = pair(img.style.backgroundPosition);
        assert.ok(Math.abs(size[0] - wanted.size[0]) < 0.5, `slide ${i} width: ${size[0]}`);
        assert.ok(Math.abs(size[1] - wanted.size[1]) < 0.5, `slide ${i} height: ${size[1]}`);
        assert.ok(Math.abs(position[0] - wanted.position[0]) < 1, `slide ${i} x: ${position[0]}`);
        assert.ok(Math.abs(position[1] - wanted.position[1]) < 1, `slide ${i} y: ${position[1]}`);
        // `cover` fills the frame, so the image element is the whole frame.
        assert.equal(img.style.width, '100%');
      }
    });

    test('deck mode replaces the split-only controls with per-slide framing', async () => {
      const el = await toDeck();

      assert.ok(!el.querySelector('#carousel-n'), 'the slide-count slider is gone');
      assert.ok(!el.querySelector('input[name="carousel-fit"]'), 'the strategy radios are gone');
      assert.ok(!el.querySelector('#carousel-anchor'), 'the anchor slider is gone');
      assert.ok(el.querySelector('.carousel-studio__deck'), 'the deck panel is shown');
      assert.ok(el.querySelector('#carousel-aspect'), 'aspect still applies to a deck');
      assert.equal(el.querySelectorAll('.carousel-studio__frame--deck').length, 3);
      // The stage stays a continuity check — one framed slide per column.
      assert.equal(el.querySelectorAll('.carousel-studio__stage-slide').length, 3);
    });

    test('dragging a frame pans that slide only, and commits on release', async () => {
      const el = await toDeck();
      const before = page.state.doc.slides.map((s) => ({ ...s.crop }));

      const frame = el.querySelector('.carousel-studio__frame--deck[data-slice="1"]');
      const img = deckImg(el, 1);
      const release = drag(frame, img, -50, 0);

      // Mid-gesture: the DOM has moved, the document has not.
      assert.ok(
        pair(img.style.backgroundPosition)[0] !== pair(deckImg(el, 0).style.backgroundPosition)[0],
        'the dragged frame repainted',
      );
      assert.deepEqual(page.state.doc.slides.map((s) => ({ ...s.crop })), before,
        'nothing committed while the pointer is still down');

      release();
      await settle();

      const after = page.state.doc.slides.map((s) => s.crop);
      assert.ok(after[1].x > before[1].x + 0.05, `slide 1 panned right: ${after[1].x}`);
      assert.deepEqual({ ...after[0] }, before[0], 'slide 0 untouched');
      assert.deepEqual({ ...after[2] }, before[2], 'slide 2 untouched');
      assert.equal(page.state.selected, 1, 'the dragged slide is selected');
    });

    test('a pan is clamped at the source edge instead of running off it', async () => {
      const { routes, deps } = split(3);
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });
      click(el.querySelector('[data-action="mode"][data-mode="deck"]'));
      await settle();
      const clean = JSON.stringify(page.state.doc);

      const frame = el.querySelector('.carousel-studio__frame--deck[data-slice="0"]');
      // Slide 0 already starts at x=0; dragging its image right would pan past
      // the left edge of the source.
      drag(frame, deckImg(el, 0), 400, 0)();
      await settle();

      assert.equal(page.state.doc.slides[0].crop.x, 0, 'pinned, not negative');
      // And the drag that went nowhere is not a change: a clamp that lands back
      // on the same source pixels must not dirty the document, or the next
      // render would re-encode a slide whose pixels are identical.
      assert.equal(JSON.stringify(page.state.doc), clean, 'the document is untouched');
    });

    test('arrow keys nudge the focused slide and keep it focused', async () => {
      const el = await toDeck();
      const before = page.state.doc.slides[2].crop.x;

      const frame = el.querySelector('.carousel-studio__frame--deck[data-slice="2"]');
      assert.equal(frame.getAttribute('tabindex'), '0', 'a frame is focusable');
      fire(frame, 'keydown', { key: 'ArrowLeft' });
      await settle();

      assert.ok(page.state.doc.slides[2].crop.x < before, 'the crop moved left');
      assert.ok(el.querySelector('.carousel-studio__dirty-badge') === null,
        'nothing rendered yet, so nothing to be dirty against');

      // `-` zooms out: the crop widens.
      const w = page.state.doc.slides[2].crop.w;
      fire(el.querySelector('.carousel-studio__frame--deck[data-slice="2"]'), 'keydown', { key: '-' });
      await settle();
      assert.ok(page.state.doc.slides[2].crop.w > w, 'the crop widened');
    });

    /** Reset slide 0 to the whole source (4096×2000, far wider than 4:5) and
     *  contain it, so it has a real letterbox rather than a one-pixel sliver. */
    async function containSlide0(el) {
      click(el.querySelector('.carousel-studio__deck [data-action="reset-slide"]'));
      await settle();
      const contain = page.container.querySelector(
        '.carousel-studio__deck [data-action="slide-fit"][data-fit="contain"]',
      );
      assert.ok(contain, 'a contain control is offered');
      click(contain);
      await settle();
      return contain;
    }

    test('a per-slide contain letterboxes that slide in the preview', async () => {
      const el = await toDeck();
      await containSlide0(el);
      assert.deepEqual(page.state.doc.slides[0].crop, { x: 0, y: 0, w: 1, h: 1 });

      assert.equal(page.state.doc.slides[0].fit, 'contain');
      const img = deckImg(el, 0);
      const wanted = deckSlideFitCSS(SRC_W, SRC_H, '4:5', page.state.doc.slides[0].crop, 'contain');
      assert.ok(wanted.box.h < 50, `the content rect is letterboxed: ${wanted.box.h}%`);
      assert.equal(img.style.height, `${wanted.box.h}%`);
      assert.ok(parseFloat(img.style.top) > 0, 'and centred, leaving the letterbox to the fill');
      // The letterbox belongs to the fill layer, not to the frame itself: the
      // frame only carries the hatch, and a blur() on it would blur the image.
      const frame = el.querySelector('.carousel-studio__frame--deck[data-slice="0"]');
      assert.ok(!frame.style.backgroundImage, 'the frame carries no image of its own');
    });

    /** The letterbox `.6` made real: the render fills it from `slide.bg`, and
     *  the filmstrip has to show the same fill or the WYSIWYG promise breaks. */
    describe('background fill', () => {
      const deckBg = (el, i) =>
        el.querySelector(
          `.carousel-studio__frame--deck[data-slice="${i}"] .carousel-studio__frame-bg`,
        );
      const bgChip = (type) =>
        page.container.querySelector(`[data-action="slide-bg"][data-bg="${type}"]`);

      test('offered only for a slide that has a letterbox to fill', async () => {
        const el = await toDeck();
        // Slide 0 covers its frame straight out of the freeze — a fill would
        // paint nothing, so there is no control to mislead with.
        assert.equal(page.state.doc.slides[0].fit, 'cover');
        assert.ok(!page.container.querySelector('.carousel-studio__bg'), 'no fill control');

        await containSlide0(el);
        assert.ok(page.container.querySelector('.carousel-studio__bg'), 'now there is one');
        assert.equal(bgChip('blur').getAttribute('aria-pressed'), 'true', 'blur is the default');
      });

      test('blur (the default) bleeds the slide across the frame, as the canvas does', async () => {
        const el = await toDeck();
        await containSlide0(el);

        const bg = deckBg(el, 0);
        const img = deckImg(el, 0);
        assert.match(bg.style.backgroundImage, /pano\.jpg/, "the slide's own pixels");
        // paintSlide stretches the content rect over the whole frame; in
        // percentages that is the same pair on a full-frame element.
        assert.equal(bg.style.backgroundSize, img.style.backgroundSize);
        assert.equal(bg.style.backgroundPosition, img.style.backgroundPosition);
        // 5% of the canvas width, expressed against the frame's inline size.
        assert.equal(bg.style.filter, 'blur(5.00cqw)');
        assert.equal(page.state.doc.slides[0].bg, null, 'the default is stored as no bg at all');
      });

      test('solid writes the colour and paints it behind the slide', async () => {
        const el = await toDeck();
        await containSlide0(el);
        click(bgChip('solid'));
        await settle();

        assert.deepEqual(page.state.doc.slides[0].bg, { type: 'solid', color: '#000000' });
        const bg = deckBg(el, 0);
        assert.equal(bg.style.backgroundColor, '#000000');
        assert.equal(bg.style.backgroundImage, 'none', 'no bleed under a solid fill');
        assert.equal(bg.style.filter, 'none', 'and nothing to blur');

        // The colour input repaints live and commits on change — the same split
        // the pan gestures use, so dragging a hue ramp costs no rebuild.
        const input = page.container.querySelector('#carousel-bg-color');
        assert.ok(input, 'a colour input is offered');
        input.value = '#ff0088';
        fire(input, 'input');
        assert.equal(deckBg(el, 0).style.backgroundColor, '#ff0088', 'painted');
        assert.equal(page.state.doc.slides[0].bg.color, '#000000', 'not committed yet');

        fire(input, 'change');
        await settle();
        assert.equal(page.state.doc.slides[0].bg.color, '#ff0088');
        // Only that slide moved.
        assert.equal(page.state.doc.slides[1].bg, null);
      });

      test('gradient stores angle + stops, and the preview is the CSS twin', async () => {
        const el = await toDeck();
        await containSlide0(el);
        click(bgChip('gradient'));
        await settle();

        assert.equal(page.state.doc.slides[0].bg.type, 'gradient');
        assert.equal(page.state.doc.slides[0].bg.angle, 180);
        assert.equal(deckBg(el, 0).style.backgroundImage, 'linear-gradient(180deg, #000000 0%, #2b2b2b 100%)');

        const angle = page.container.querySelector('#carousel-bg-angle');
        angle.value = '90';
        fire(angle, 'input');
        assert.equal(
          page.container.querySelector('#carousel-bg-angle-out').textContent,
          '90°',
          'the readout follows the slider',
        );
        fire(angle, 'change');
        await settle();

        assert.equal(page.state.doc.slides[0].bg.angle, 90);
        assert.match(deckBg(el, 0).style.backgroundImage, /^linear-gradient\(90deg,/);

        // Both ends are editable, and land on the stops the render reads.
        const to = page.container.querySelector('#carousel-bg-to');
        to.value = '#ffffff';
        fire(to, 'change');
        await settle();
        assert.deepEqual(page.state.doc.slides[0].bg.stops, [
          { at: 0, color: '#000000' },
          { at: 1, color: '#ffffff' },
        ]);
      });

      test('a fill change re-renders exactly the slide it touched', async () => {
        const el = await toDeck();
        await containSlide0(el);
        const before = page.state.doc.slides.map((s) => specHash(s, '4:5'));
        click(bgChip('solid'));
        await settle();

        const after = page.state.doc.slides.map((s) => specHash(s, '4:5'));
        assert.notEqual(after[0], before[0], 'the filled slide must be re-encoded');
        assert.deepEqual(after.slice(1), before.slice(1), 'the others are reused');
      });

      test('switching a slide back to cover retires its fill control', async () => {
        const el = await toDeck();
        await containSlide0(el);
        click(bgChip('solid'));
        await settle();

        click(
          page.container.querySelector(
            '.carousel-studio__deck [data-action="slide-fit"][data-fit="cover"]',
          ),
        );
        await settle();

        assert.ok(!page.container.querySelector('.carousel-studio__bg'), 'nothing left to fill');
        // The bg stays on the document — going back to contain finds it again —
        // but the covered frame paints none of it.
        assert.deepEqual(page.state.doc.slides[0].bg, { type: 'solid', color: '#000000' });
        assert.equal(deckBg(el, 0).style.backgroundImage, 'none');
        assert.equal(deckBg(el, 0).style.backgroundColor, 'transparent');
      });
    });

    test('going back to split confirms first, then discards the per-slide framing', async () => {
      const el = await toDeck();
      const frame = el.querySelector('.carousel-studio__frame--deck[data-slice="1"]');
      drag(frame, deckImg(el, 1), -60, 0)();
      await settle();
      const panned = page.state.doc.slides[1].crop.x;

      let confirmed = null;
      page._showConfirm = (title, message, confirmText, variant, onConfirm) => {
        confirmed = { title, variant, onConfirm };
      };
      click(el.querySelector('[data-action="mode"][data-mode="split"]'));
      await settle();

      assert.ok(confirmed, 'a confirmation was shown');
      assert.equal(confirmed.variant, 'danger');
      assert.equal(page.state.doc.mode, 'deck', 'still deck until confirmed');

      confirmed.onConfirm();
      await settle();

      assert.equal(page.state.doc.mode, 'split');
      assert.notEqual(page.state.doc.slides[1].crop.x, panned, 'the pan is gone');
      assert.ok(el.querySelector('#carousel-n'), 'the split controls are back');
    });

    test('nudging one slide re-uploads exactly that slide', async () => {
      // A deck that has already been rendered: every slide carries the specHash
      // its render was made from, so an untouched slide is reused verbatim.
      const base = splitDocument({ source: SRC, n: 3, aspect: '4:5', strategy: 'cover', anchorY: 0.5 });
      const doc = toDeckDocument(base, SRC_W, SRC_H);
      doc.slides.forEach((s, i) => {
        s.rendered = {
          path: `/2026/08/old${i + 1}.jpg`,
          media_id: 100 + i,
          specHash: specHash(s, doc.aspect, { strategy: doc.strategy, anchorY: doc.anchorY }),
        };
      });
      const post = {
        ...POST,
        content: ':::{.carousel-block}\n\n/2026/08/old1.jpg\n\n/2026/08/old2.jpg\n\n/2026/08/old3.jpg\n\n:::',
      };
      const routes = [
        [/\/api\/posts\/42$/, (url, opts) => (opts.method === 'PUT' ? { body: {} } : { body: post })],
        [/\/api\/carousel/, (url, opts) =>
          opts.method === 'PUT' ? { body: {} } : { body: { post_id: 42, doc } }],
        [/\/api\/media\/\d+$/, { body: {} }],
      ];
      const uploads = [];
      const deps = {
        ...fakeRenderDeps(async (file) => {
          uploads.push(file.name);
          return { id: 500 + uploads.length, path: `/2026/08/new${uploads.length}.jpg` };
        }),
        probeSize: async () => ({ w: SRC_W, h: SRC_H }),
      };
      const el = await mount({ post: '42' }, routes, { renderDeps: deps });
      assert.equal(page.state.doc.mode, 'deck', 'loaded as a deck');
      assert.ok(!el.querySelector('.carousel-studio__dirty-badge'), 'clean on load');

      // Re-rendering an untouched deck uploads nothing at all.
      await page._render();
      await settle();
      assert.equal(page.state.error, null);
      assert.deepEqual(uploads, [], 'every slide was reused');

      fire(el.querySelector('.carousel-studio__frame--deck[data-slice="1"]'), 'keydown', { key: 'ArrowRight' });
      await settle();
      assert.ok(page.state.doc.slides[1].crop.x > doc.slides[1].crop.x, 'slide 1 moved');
      assert.ok(page.container.querySelector('.carousel-studio__dirty-badge'), 'and the studio is dirty');

      await page._render();
      await settle();

      assert.equal(page.state.error, null);
      assert.deepEqual(uploads, ['carousel-42-2.jpg'], 'only slide 2 of 3 was re-encoded');
      assert.deepEqual(
        page.state.doc.slides.map((s) => s.rendered.path),
        ['/2026/08/old1.jpg', '/2026/08/new1.jpg', '/2026/08/old3.jpg'],
      );
      assert.ok(!page.container.querySelector('.carousel-studio__dirty-badge'), 'clean again');
    });
  });
});
