// The shut of the details sheet does not blink (p-sheet-close-blink-dnq6l).
// A post with a photo and a geo-tag: the open sheet shows the map through a
// window on its map slot (atlasOcean.ts). A shut must move the sheet only. The
// photo element stays the same element with the same src, and it does not
// hide. The map does not show outside the slot, and it starts no slide of its
// own (the old full-map slide of `.atlas-layer-map` came after each shut: the
// shut left the window, the clip went, and the unclipped map slid away over
// the photo).
//
// Two layouts: the portrait sheet (a phone, or the iPad in portrait) and the
// side panel of touch landscape. E2E_DEVICE=ipad runs both on the WebKit iPad.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { launchFor, touchOnly, onIpad } from './devices.ts';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');
const ROOT = path.resolve(import.meta.dirname, '../..');
const SLUG = 'shut-probe';

/** Chromium: a phone. The iPad uses its own size (devices.ts). */
const PORTRAIT = onIpad ? { width: 834, height: 1194 } : { width: 390, height: 844 };
const LANDSCAPE = onIpad ? { width: 1194, height: 834 } : { width: 844, height: 390 };

/** What the recorder saw in the frames after one shut. */
type Trace = {
  replaced: number;
  srcs: string[];
  hidden: string[];
  sizes: string[];
  unclipped: string[];
  oceanRuns: string[];
  frames: number;
};

describe('Immersive sheet: the shut does not blink', () => {
  let browser: Browser | undefined;
  let ctx: BrowserContext;
  let page: Page;
  let cookie = '';

  const api = (p: string, body: unknown, method = 'POST') =>
    fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
      body: JSON.stringify(body),
    });

  before(async () => {
    const touch = { hasTouch: true, isMobile: true, viewport: PORTRAIT };
    ({ browser, context: ctx } = await launchFor(undefined, touch, { hasTouch: true }));
    page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.removeItem('atlasLayerState'); localStorage.removeItem('pointerFine'); });
    // A touch-only device: see devices.ts::touchOnly (p-yao5z).
    await touchOnly(page);
    await page.route(/arcgisonline\.com/, (route) => route.abort());

    const setup = await api('/api/setup', { name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' });
    if (!setup.ok) throw new Error('Setup failed: ' + setup.status);
    const login = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!login.ok) throw new Error('Login failed: ' + login.status);
    cookie = ((login.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';
    const on = await api('/api/plugins/immersive-sheet', { enabled: true }, 'PATCH');
    if (!on.ok) throw new Error('immersive-sheet on: ' + on.status);
    const tag = await api('/api/tags', { name: 'Shutton', slug: 'shutton', kind: 'place', latitude: 40.7, longitude: -74 });
    if (!tag.ok) throw new Error('Tag creation failed: ' + (await tag.text()));

    const form = new FormData();
    const jpeg = readFileSync(path.join(ROOT, 'frontend/images/placeholder.jpg'));
    form.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'shut.jpg');
    const up = await fetch(BASE + '/api/media/upload', { method: 'POST', headers: { Cookie: 'session=' + cookie }, body: form });
    if (!up.ok) throw new Error('Upload failed: ' + (await up.text()));
    const media = await up.json() as { path: string };
    const post = await api('/api/posts', {
      title: 'Shut probe', slug: SLUG, content: media.path, excerpt: 'A short excerpt.',
      status: 'published', tags: ['shutton'], immersive_mode: 'immersive',
    });
    if (!post.ok) throw new Error('Post creation failed: ' + (await post.text()));
  });

  after(async () => {
    await browser?.close();
  });

  /** Wait for the slide to end (SHEET_ANIM_MS and a margin). */
  const settle = () => page.waitForTimeout(500);

  const openPost = async (size: { width: number; height: number }, side: boolean) => {
    await page.setViewportSize(size);
    await page.goto('about:blank');
    await page.goto(`${BASE}/posts/${SLUG}#1`);
    await page.locator('.immersive-sheet-mode .immersive-bg-image').first().waitFor({ state: 'attached' });
    await page.waitForFunction((s) => !!document.querySelector('.immersive-sheet-side') === s, side, { timeout: 10000 });
    await page.waitForFunction(() => {
      const img = document.querySelector<HTMLImageElement>('.immersive-visuals .immersive-bg-image');
      return !!img && img.complete && img.naturalWidth > 0;
    });
    await settle();
  };

  const openSheet = async () => {
    await page.locator('.immersive-sheet-hint').tap();
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-mode.sheet-open'));
    // The ocean shows through the slot.
    await page.waitForFunction(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')?.dataset.atlasOcean === 'window');
    await settle();
  };

  /**
   * Shut the sheet with the grip and record each frame for 600 ms: the photo
   * element, its src, its visibility, its size, and the map box. The map must
   * be hidden, or clipped to the window (a clip-path), in each frame.
   */
  const shutAndTrace = async (): Promise<Trace> => {
    await page.evaluate(() => {
      const w = window as unknown as { __shutTrace: Promise<unknown> };
      const img0 = document.querySelector<HTMLImageElement>('.immersive-visuals .immersive-bg-image')!;
      const src0 = img0.currentSrc || img0.src;
      const map = document.querySelector<HTMLElement>('body > .atlas-layer-map')!;
      const t: Trace = { replaced: 0, srcs: [], hidden: [], sizes: [], unclipped: [], oceanRuns: [], frames: 0 };
      const onRun = (e: Event) => {
        if (e.target === map) t.oceanRuns.push(`${(e as TransitionEvent).propertyName} from ${map.dataset.atlasOcean}`);
      };
      map.addEventListener('transitionrun', onRun);
      let last: DOMRect | null = null;
      const start = performance.now();
      w.__shutTrace = new Promise((resolve) => {
        const step = () => {
          const ms = Math.round(performance.now() - start);
          t.frames++;
          const img = document.querySelector<HTMLImageElement>('.immersive-visuals .immersive-bg-image');
          if (img !== img0) t.replaced++;
          if (img) {
            const src = img.currentSrc || img.src;
            if (src !== src0) t.srcs.push(`${ms}ms ${src}`);
            for (let el: HTMLElement | null = img; el && !el.classList.contains('media-viewer-wrapper'); el = el.parentElement) {
              const cs = getComputedStyle(el);
              if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
                t.hidden.push(`${ms}ms ${el.className} display=${cs.display} visibility=${cs.visibility} opacity=${cs.opacity}`);
              }
            }
            // A change of more than 1 px: the slide moves the photo by
            // fractions of a px, and the rounded size can step by 1.
            const r = img.getBoundingClientRect();
            if (!last || Math.abs(r.width - last.width) > 1 || Math.abs(r.height - last.height) > 1) {
              t.sizes.push(`${ms}ms ${Math.round(r.width)}x${Math.round(r.height)}`);
              last = r;
            }
          }
          const ms2 = getComputedStyle(map);
          if (ms2.visibility !== 'hidden' && !map.style.clipPath) {
            const b = map.getBoundingClientRect();
            t.unclipped.push(`${ms}ms ocean=${map.dataset.atlasOcean} transform=${ms2.transform} top=${Math.round(b.top)} h=${Math.round(b.height)}`);
          }
          if (ms < 600) requestAnimationFrame(step);
          else {
            map.removeEventListener('transitionrun', onRun);
            resolve(t);
          }
        };
        requestAnimationFrame(step);
      });
    });
    await page.locator('.immersive-sheet-grip').dispatchEvent('click');
    return page.evaluate(() => (window as unknown as { __shutTrace: Promise<Trace> }).__shutTrace);
  };

  const assertNoBlink = (t: Trace, label: string) => {
    const text = `${label}: ${JSON.stringify(t)}`;
    assert.ok(t.frames >= 2, 'the recorder ran: ' + text);
    assert.equal(t.replaced, 0, 'the photo element stays: ' + text);
    assert.deepEqual(t.srcs, [], 'the photo src stays: ' + text);
    assert.deepEqual(t.hidden, [], 'the photo does not hide: ' + text);
    assert.deepEqual(t.unclipped, [], 'the map shows only through the window: ' + text);
    assert.deepEqual(t.oceanRuns, [], 'the map starts no slide of its own: ' + text);
  };

  for (const [name, size, side] of [['portrait sheet', PORTRAIT, false], ['landscape side panel', LANDSCAPE, true]] as const) {
    it(`the ${name} shuts with no blink, each time (${size.width}x${size.height})`, async () => {
      await openPost(size, side);
      for (let i = 1; i <= 3; i++) {
        await openSheet();
        const t = await shutAndTrace();
        assertNoBlink(t, `${name}, shut ${i}`);
        // The size of the photo changes in one direction only (the stage
        // grows to the full screen): no change to a size and back.
        const seen = t.sizes.map((s) => s.split(' ')[1]);
        assert.equal(new Set(seen).size, seen.length, `${name}, shut ${i}: no size comes back: ${JSON.stringify(t.sizes)}`);
        await page.waitForFunction(() => !document.querySelector('.immersive-sheet-mode.sheet-open'));
        await settle();
      }
    });
  }
});
