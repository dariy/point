// The sheet viewer in touch landscape (p-atlas-ocean-o6wyh.18,
// p-landscape-sheet-cd9f2). Shut, the photo fills the screen and a "Details"
// tab shows at the right edge. Open, the panel slides in from the right over
// the photo, and the photo stage shrinks to the area left of the panel. There
// is no panel drag. A swipe left or right on the photo still changes the post.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { type Browser, type BrowserContext, type Page } from 'playwright';
import { launchFor } from './devices.ts';
import crypto from 'node:crypto';

const BASE = process.env.E2E_BASE_URL || 'http://127.0.0.1:8001';
const PW = crypto.createHash('sha256').update('devpassword').digest('hex');

/** The column width at a viewport width: clamp(18rem, 38vw, 26rem). */
const columnW = (vw: number) => Math.min(416, Math.max(288, vw * 0.38));

describe('Immersive sheet in touch landscape', () => {
  let browser: Browser | undefined;
  let ctx: BrowserContext;
  let page: Page;
  let cookie = '';

  const api = (path: string, body: unknown, method = 'POST') =>
    fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: 'session=' + cookie } : {}) },
      body: JSON.stringify(body),
    });

  before(async () => {
    const touch = { hasTouch: true, isMobile: true, viewport: { width: 844, height: 390 } };
    ({ browser, context: ctx } = await launchFor(undefined, touch, { hasTouch: true }));
    page = await ctx.newPage();
    await page.addInitScript(() => { localStorage.removeItem('atlasLayerState'); localStorage.removeItem('pointerFine'); });
    await page.route(/arcgisonline\.com/, (route) => route.abort());

    const setup = await api('/api/setup', { name: PW, blog_title: 'E2E Blog', author_name: 'E2E User', email: 'e2e@example.com' });
    if (!setup.ok) throw new Error('Setup failed: ' + setup.status);
    const login = await api('/api/auth/login', { username: 'the_owner', name: PW });
    if (!login.ok) throw new Error('Login failed: ' + login.status);
    cookie = ((login.headers.get('set-cookie') || '').match(/session=([^;]+)/) || [])[1] || '';
    const vis = await api('/api/settings', { tags_visibility: 'all' }, 'PUT');
    if (!vis.ok) throw new Error('Settings failed: ' + vis.status);
    const on = await api('/api/plugins/immersive-sheet', { enabled: true }, 'PATCH');
    if (!on.ok) throw new Error('immersive-sheet on: ' + on.status);

    const tag = await api('/api/tags', { name: 'Sideton', slug: 'sideton', kind: 'place', latitude: 40.7, longitude: -74 });
    if (!tag.ok) throw new Error('Tag creation failed: ' + (await tag.text()));
    for (const title of ['Side probe one', 'Side probe two', 'Side probe three']) {
      const res = await api('/api/posts', {
        title, slug: title.toLowerCase().replace(/ /g, '-'), content: 'Body of the post.', excerpt: 'A short excerpt.',
        status: 'published', tags: ['sideton'], immersive_mode: 'immersive',
      });
      if (!res.ok) throw new Error('Post creation failed: ' + (await res.text()));
    }
  });

  after(async () => {
    await browser?.close();
  });

  /** Open a post in the sheet viewer (#1 forces the immersive view). */
  const openPost = async (slug: string, size: { width: number; height: number }) => {
    await page.setViewportSize(size);
    // A new history entry: WebKit keeps the state of a goto to the same URL with a hash.
    await page.goto('about:blank');
    await page.goto(`${BASE}/posts/${slug}#1`);
    await page.locator('.immersive-sheet-mode').waitFor({ state: 'attached' });
  };

  const layout = () => page.evaluate(() => {
    const r = (sel: string) => {
      const b = document.querySelector(sel)?.getBoundingClientRect();
      return b ? { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom } : null;
    };
    const wrapper = document.querySelector('.immersive-sheet-mode')!;
    const sheet = document.querySelector<HTMLElement>('.immersive-sheet')!;
    return {
      side: wrapper.classList.contains('immersive-sheet-side'),
      open: wrapper.classList.contains('sheet-open'),
      sheetTransform: sheet.style.transform,
      sheet: r('.immersive-sheet'),
      visuals: r('.immersive-visuals'),
      slot: r('.immersive-sheet-map'),
      scroller: r('.immersive-sheet-scroll'),
      close: r('.lightbox-close'),
      hint: (() => {
        const el = document.querySelector('.immersive-sheet-hint')!;
        const b = el.getBoundingClientRect();
        return { opacity: getComputedStyle(el).opacity, right: b.right, y: b.y + b.height / 2 };
      })(),
      grip: r('.immersive-sheet-grip'),
      sheetVisibility: getComputedStyle(sheet).visibility,
      uiHidden: document.body.classList.contains('ui-hidden'),
      ocean: document.querySelector<HTMLElement>('body > .atlas-layer-map')?.dataset.atlasOcean ?? null,
      clip: document.querySelector<HTMLElement>('body > .atlas-layer-map')?.style.clipPath ?? '',
      box: r('body > .atlas-layer-map'),
      path: location.pathname,
    };
  });
  type Layout = Awaited<ReturnType<typeof layout>>;

  /** The open panel at the right, full height; the photo stage on its left. */
  const assertSide = (l: Layout, size: { width: number; height: number }) => {
    const text = `${size.width}x${size.height}: ${JSON.stringify(l)}`;
    const w = columnW(size.width);
    assert.equal(l.side, true, 'the side layout: ' + text);
    assert.equal(l.open, true, 'the panel is open: ' + text);
    assert.equal(l.sheetTransform, '', 'no inline slide: ' + text);
    assert.equal(l.hint.opacity, '0', 'no "Details" tab: ' + text);
    assert.ok(Math.abs(l.grip!.x - l.sheet!.x) <= 1, 'the grip is on the left edge of the panel: ' + text);
    assert.ok(Math.abs(l.sheet!.w - w) <= 1, `the panel is ${w} px wide: ` + text);
    assert.ok(Math.abs(l.sheet!.right - size.width) <= 1 && Math.abs(l.sheet!.y) <= 1, 'the column is at the right: ' + text);
    assert.ok(Math.abs(l.sheet!.h - size.height) <= 1, 'the column is full height: ' + text);
    assert.ok(Math.abs(l.visuals!.x) <= 1 && Math.abs(l.visuals!.right - l.sheet!.x) <= 1, 'the photo is left of the column: ' + text);
    assert.ok(l.close!.right <= l.sheet!.x + 1, 'the close cross is on the photo: ' + text);
  };

  /** The shut panel: the photo fills the screen, the tab is at the right edge. */
  const assertShut = (l: Layout, size: { width: number; height: number }) => {
    const text = `${size.width}x${size.height}: ${JSON.stringify(l)}`;
    assert.equal(l.side, true, 'the side layout: ' + text);
    assert.equal(l.open, false, 'the panel is shut: ' + text);
    assert.equal(l.sheetTransform, '', 'no inline slide: ' + text);
    assert.ok(l.sheet!.x >= size.width - 1, 'the panel is off the screen on the right: ' + text);
    assert.equal(l.sheetVisibility, 'hidden', 'the shut panel is hidden: ' + text);
    assert.ok(Math.abs(l.visuals!.x) <= 1 && Math.abs(l.visuals!.w - size.width) <= 1, 'the photo fills the screen: ' + text);
    // The UI hides after a time with no input; the tab then hides too.
    if (!l.uiHidden) {
      assert.equal(l.hint.opacity, '1', 'the "Details" tab shows: ' + text);
      assert.ok(Math.abs(l.hint.right - size.width) <= 1, 'the tab is at the right edge: ' + text);
    }
    assert.ok(l.ocean === null || l.ocean === 'hidden', 'no window with a shut panel: ' + text);
  };

  /**
   * The portrait layout after a rotation: no side class, and no landscape
   * geometry left. The stage and the sheet are full width; the sheet is at the
   * bottom (open) or below the screen (shut).
   */
  const assertPortrait = (l: Layout, open: boolean, size = { width: 390, height: 844 }) => {
    const text = `${size.width}x${size.height}: ${JSON.stringify(l)}`;
    assert.equal(l.side, false, 'portrait: no side layout: ' + text);
    assert.equal(l.open, open, 'portrait: the sheet state stays: ' + text);
    assert.ok(Math.abs(l.visuals!.x) <= 1 && Math.abs(l.visuals!.w - size.width) <= 1, 'portrait: the stage is full width: ' + text);
    assert.ok(Math.abs(l.sheet!.x) <= 1 && Math.abs(l.sheet!.w - size.width) <= 1, 'portrait: a full width sheet: ' + text);
    assert.equal(l.sheetVisibility, 'visible', 'portrait: the sheet is not hidden: ' + text);
    if (open) assert.ok(l.sheet!.bottom <= size.height + 1 && l.sheet!.y < size.height, 'portrait: the open sheet is on the screen: ' + text);
    else assert.ok(l.sheet!.y >= size.height - 1, 'portrait: the shut sheet is below the screen: ' + text);
    assert.ok(Math.abs(l.close!.right - (size.width - 24)) <= 16, 'portrait: the close cross is at the right edge: ' + text);
  };

  /** The ocean slides away after the panel slide: wait for its end, so a touch reaches the photo. */
  const oceanGone = () => page.waitForFunction(() => {
    const map = document.querySelector('body > .atlas-layer-map');
    return !map || getComputedStyle(map).visibility === 'hidden';
  });

  /** Wait for the slide to end (SHEET_ANIM_MS and a margin). */
  const settle = () => page.waitForTimeout(500);

  /** Open a post in touch landscape and open the panel with the tab. */
  const openPanel = async (slug: string, size: { width: number; height: number }) => {
    await openPost(slug, size);
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side'));
    await settle();
    await page.locator('.immersive-sheet-hint').tap();
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
  };

  /** The ocean shows through the slot: a window clipped to the slot inside the column. */
  const windowOnSlot = async (label: string) => {
    const end = Date.now() + 3000;
    for (;;) {
      const l = await layout();
      try {
        assert.equal(l.ocean, 'window', `${label}: ${JSON.stringify(l)}`);
        const v = (l.clip.match(/inset\(([^)]*)\)/)?.[1] ?? '').split(/\s+/).map(parseFloat);
        const [t, r = t, b = t, lft = r] = v;
        const top = Math.max(l.slot!.y, l.scroller!.y);
        const bottom = Math.min(l.slot!.bottom, l.scroller!.bottom);
        const want = { t: top - l.box!.y, r: l.box!.right - l.slot!.right, b: l.box!.bottom - bottom, l: l.slot!.x - l.box!.x };
        const got = { t, r, b, l: lft };
        for (const k of ['t', 'r', 'b', 'l'] as const) {
          assert.ok(Math.abs(got[k]! - want[k]) <= 1, `${label}: the clip is the slot (${k}): ${JSON.stringify({ got, want })}`);
        }
        return l;
      } catch (e) {
        if (Date.now() > end) throw e;
        await page.waitForTimeout(100);
      }
    }
  };

  /**
   * A one-finger swipe made of touch events, from (fx, fy) to (tx, ty).
   * WebKit has no Touch constructor: there the events are plain Events with
   * touch lists (GestureController reads only the lists and the target).
   */
  const swipe = (fx: number, fy: number, tx: number, ty: number) => page.evaluate(([fx, fy, tx, ty]) => {
    const target = document.elementFromPoint(fx!, fy!)!;
    type T = { identifier: number; target: Element; clientX: number; clientY: number };
    const touch = (x: number, y: number): T => ({ identifier: 1, target, clientX: x, clientY: y });
    let native = true;
    try { new Touch({ identifier: 1, target, clientX: 0, clientY: 0 }); } catch { native = false; }
    const fire = (type: string, touches: T[], changed: T[]) => {
      if (native) {
        const list = (ts: T[]) => ts.map((t) => new Touch(t));
        return target.dispatchEvent(new TouchEvent(type, {
          bubbles: true, cancelable: true, touches: list(touches), targetTouches: list(touches), changedTouches: list(changed),
        }));
      }
      const e = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(e, { touches: { value: touches }, targetTouches: { value: touches }, changedTouches: { value: changed } });
      return target.dispatchEvent(e);
    };
    fire('touchstart', [touch(fx!, fy!)], [touch(fx!, fy!)]);
    for (let i = 1; i <= 8; i++) {
      const x = fx! + ((tx! - fx!) * i) / 8;
      const y = fy! + ((ty! - fy!) * i) / 8;
      fire('touchmove', [touch(x, y)], [touch(x, y)]);
    }
    fire('touchend', [], [touch(tx!, ty!)]);
  }, [fx, fy, tx, ty]);

  for (const size of [{ width: 844, height: 390 }, { width: 1180, height: 820 }]) {
    it(`opens full screen and the tab slides the panel in at ${size.width}x${size.height}`, async () => {
      await openPost('side-probe-two', size);
      await page.waitForFunction(() => document.querySelector('.immersive-sheet-side'));
      await settle();
      assertShut(await layout(), size);
      await page.locator('.immersive-sheet-hint').tap();
      await page.waitForFunction(() => document.querySelector('.immersive-sheet-side.sheet-open'));
      // The panel slides in and the stage shrinks in the same time (SHEET_ANIM_MS).
      const slides = await page.evaluate(() => {
        const of = (sel: string) => document.querySelector(sel)!.getAnimations().map((a) => ({
          prop: (a as CSSTransition).transitionProperty,
          ms: Number(a.effect?.getTiming().duration),
        }));
        return { stage: of('.immersive-visuals'), panel: of('.immersive-sheet') };
      });
      assert.deepEqual(slides.stage.filter((a) => a.prop === 'right'), [{ prop: 'right', ms: 340 }], 'the stage shrinks: ' + JSON.stringify(slides));
      assert.deepEqual(slides.panel.filter((a) => a.prop === 'transform'), [{ prop: 'transform', ms: 340 }], 'the panel slides: ' + JSON.stringify(slides));
      await settle();
      assertSide(await layout(), size);
      await windowOnSlot(`${size.width}x${size.height}`);
    });
  }

  it('a swipe up opens the panel, a swipe down shuts it, and a second swipe down closes the viewer', async () => {
    const size = { width: 844, height: 390 };
    await openPost('side-probe-two', size);
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side'));
    await settle();
    await swipe(400, 300, 400, 120);
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    assertSide(await layout(), size);
    await windowOnSlot('swiped open');
    const stage = (await layout()).visuals!;
    await swipe(stage.x + stage.w / 2, 100, stage.x + stage.w / 2, 300);
    await page.waitForFunction(() => !document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    assertShut(await layout(), size);
    assert.equal((await layout()).path, '/posts/side-probe-two', 'the first swipe down keeps the viewer');
    await oceanGone();
    await swipe(400, 100, 400, 300);
    await page.waitForURL((u) => !u.pathname.startsWith('/posts/'), { timeout: 5000 });
  });

  it('Escape, a tap on the photo, the grip and ArrowDown at the end shut the panel', async () => {
    const size = { width: 844, height: 390 };
    await openPanel('side-probe-two', size);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    assertShut(await layout(), size);
    assert.equal((await layout()).path, '/posts/side-probe-two', 'Escape only shuts the panel');

    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    const stage = (await layout()).visuals!;
    await page.touchscreen.tap(stage.x + stage.w / 2, stage.y + stage.h / 2);
    await page.waitForFunction(() => !document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    assertShut(await layout(), size);

    // The tap also hides the UI (as in portrait), so the key opens the panel again.
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    // A touch tap in WebKit can send a mouse echo that turns on the fine pointer.
    await page.locator('.immersive-sheet-grip').dispatchEvent('click');
    await page.waitForFunction(() => !document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    assertShut(await layout(), size);

    // ArrowDown at the end of the scroll shuts the panel, as in portrait.
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    await page.evaluate(() => { const el = document.querySelector('.immersive-sheet-scroll')!; el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(200);
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => !document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    assertShut(await layout(), size);
  });

  it('does not drag the panel; the panel scrolls and the window follows the slot', async () => {
    await openPanel('side-probe-two', { width: 844, height: 390 });
    await windowOnSlot('before');
    let l = await layout();
    // A touch in the panel starts no swipe: a horizontal drag there keeps the post.
    await swipe(l.sheet!.x + 40, 100, l.sheet!.x + 240, 100);
    await page.waitForTimeout(600);
    l = await layout();
    assert.equal(l.path, '/posts/side-probe-two', 'a drag in the panel changes no post');
    assert.equal(l.open, true, 'a drag in the panel keeps it open');
    // Scroll the panel: the window stays on the slot.
    const before = l.slot!.y;
    await page.evaluate(() => { document.querySelector('.immersive-sheet-scroll')!.scrollTop = 120; });
    await page.waitForTimeout(200);
    const after = await windowOnSlot('scrolled');
    assert.ok(after.slot!.y < before, `the panel scrolls: ${before} → ${after.slot!.y}`);
  });

  it('a swipe left or right on the photo changes the post and keeps the open panel', async () => {
    const size = { width: 844, height: 390 };
    await openPanel('side-probe-two', size);
    const stage = (await layout()).visuals!;
    const y = stage.y + stage.h / 2;
    await swipe(stage.x + stage.w * 0.75, y, stage.x + stage.w * 0.15, y);
    await page.waitForURL((u) => !u.pathname.endsWith('/side-probe-two'), { timeout: 5000 });
    const first = new URL(page.url()).pathname;
    await page.locator('.immersive-sheet-side.sheet-open').waitFor({ state: 'attached' });
    await settle();
    assertSide(await layout(), size);
    // Shut, a swipe steps too, and the next post opens shut.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.immersive-sheet-side.sheet-open'));
    await settle();
    await oceanGone();
    await swipe(size.width * 0.15, y, size.width * 0.75, y);
    await page.waitForURL((u) => u.pathname !== first, { timeout: 5000 });
    await page.locator('.immersive-sheet-side').waitFor({ state: 'attached' });
    await settle();
    assertShut(await layout(), size);
  });

  it('a rotation keeps a shut sheet shut, both ways, with no reload', async () => {
    await openPost('side-probe-two', { width: 844, height: 390 });
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side'));
    await settle();
    assertShut(await layout(), { width: 844, height: 390 });
    await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true; });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.querySelector('.immersive-sheet-side'));
    await page.waitForTimeout(500);
    const l = await layout();
    assertPortrait(l, false);
    assert.ok(l.ocean === null || l.ocean === 'hidden', 'portrait: no window with a shut sheet');

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side'));
    await settle();
    assertShut(await layout(), { width: 844, height: 390 });
    assert.equal(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload), true, 'no reload');
  });

  it('a rotation keeps an open sheet open, both ways', async () => {
    // Open in portrait, turn to landscape: the panel is open.
    await openPost('side-probe-two', { width: 390, height: 844 });
    await page.locator('.immersive-sheet-hint').tap();
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-mode.sheet-open'));
    await settle();
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => document.querySelector('.immersive-sheet-side'));
    await settle();
    assertSide(await layout(), { width: 844, height: 390 });
    await windowOnSlot('landscape open');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.querySelector('.immersive-sheet-side'));
    await settle();
    let l = await layout();
    assertPortrait(l, true);
    await windowOnSlot('portrait open');

    // Open in landscape, turn to portrait: the bottom sheet is open.
    await openPanel('side-probe-two', { width: 844, height: 390 });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.querySelector('.immersive-sheet-side'));
    await settle();
    assertPortrait(await layout(), true);
    await windowOnSlot('portrait open after landscape');
  });

  it('goes to the full map and back into the panel slot', async () => {
    const size = { width: 844, height: 390 };
    await openPanel('side-probe-two', size);
    const l = await windowOnSlot('before the tap');
    const top = Math.max(l.slot!.y, l.scroller!.y);
    const bottom = Math.min(l.slot!.bottom, l.scroller!.bottom);
    await page.touchscreen.tap(l.slot!.x + l.slot!.w / 2 + 30, (top + bottom) / 2 + 10);
    await page.waitForURL(/\/tags\/sideton\?/);
    await page.waitForFunction(() => document.querySelector<HTMLElement>('body > .atlas-layer-map')?.dataset.atlasOcean === 'full');
    await page.goBack();
    await page.waitForURL(/\/posts\/side-probe-two/);
    await page.locator('.immersive-sheet-side').waitFor({ state: 'attached' });
    await page.waitForTimeout(800);
    const back = await windowOnSlot('after the return');
    assertSide(back, size);
  });

  it('keeps the bottom sheet in portrait, and on a desktop in landscape', async () => {
    await openPost('side-probe-two', { width: 390, height: 844 });
    await page.waitForTimeout(300);
    assert.equal((await layout()).side, false, 'touch portrait');
    const desk = await browser!.newContext({ viewport: { width: 1180, height: 820 } });
    try {
      const p = await desk.newPage();
      await p.goto(`${BASE}/posts/side-probe-two#1`);
      await p.locator('.immersive-sheet-mode').waitFor({ state: 'attached' });
      await p.waitForTimeout(300);
      assert.equal(await p.locator('.immersive-sheet-side').count(), 0, 'desktop landscape');
    } finally {
      await desk.close();
    }
  });
});
