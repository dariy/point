// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.13.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { captureVideoPoster, isVideoFile } from '../src/utils/videoPoster.js';

/**
 * videoPoster grabs the still that becomes a video's thumbnail. It is the only
 * source of video thumbnails in this build — the server ships no video decoder
 * — so its failure paths matter as much as its success path: every one of them
 * must resolve to null rather than throw, or a codec the browser cannot handle
 * would take the whole upload down with it.
 *
 * There is no DOM here (the suite runs on bare node:test), so the <video> and
 * <canvas> are stood up as fakes that emit the same events.
 */
describe('captureVideoPoster', () => {
  let videos, revoked, drawnSizes;
  /** Mutates the next fake <video> before it is handed to the module. */
  let tweakVideo;
  /** Mutates the next fake <canvas> likewise. */
  let tweakCanvas;

  /** A <video> stand-in that fires events on demand. */
  function fakeVideo() {
    const listeners = {};
    const v = {
      videoWidth: 1920,
      videoHeight: 1080,
      duration: 30,
      _currentTime: 0,
      // What the element does once src is assigned, and once it is seeked.
      // Tests override these to simulate decode errors and stalls.
      onSrc: (self) => queueMicrotask(() => self.emit('loadedmetadata')),
      onSeek: (self) => queueMicrotask(() => self.emit('seeked')),
      addEventListener(type, fn) {
        (listeners[type] ||= []).push(fn);
      },
      removeEventListener(type, fn) {
        listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
      },
      emit(type) {
        (listeners[type] || []).slice().forEach((fn) => fn({ type }));
      },
      removeAttribute() {},
      load() {},
      listenerCount() {
        return Object.values(listeners).reduce((n, l) => n + l.length, 0);
      },
    };
    Object.defineProperty(v, 'src', {
      set(value) {
        v._src = value;
        v.onSrc(v);
      },
      get: () => v._src,
    });
    Object.defineProperty(v, 'currentTime', {
      set(value) {
        v._currentTime = value;
        v.onSeek(v);
      },
      get: () => v._currentTime,
    });
    return v;
  }

  function fakeCanvas() {
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage: (_src, _x, _y, w, h) => drawnSizes.push([w, h]),
      }),
      toBlob: (cb) => cb({ type: 'image/jpeg', size: 1234 }),
    };
  }

  beforeEach(() => {
    videos = [];
    revoked = [];
    drawnSizes = [];
    tweakVideo = () => {};
    tweakCanvas = () => {};

    global.document = {
      createElement(tag) {
        if (tag === 'video') {
          const v = fakeVideo();
          tweakVideo(v);
          videos.push(v);
          return v;
        }
        const c = fakeCanvas();
        tweakCanvas(c);
        return c;
      },
    };
    global.URL = {
      createObjectURL: () => 'blob:fake',
      revokeObjectURL: (u) => revoked.push(u),
    };
  });

  afterEach(() => {
    delete global.document;
    delete global.URL;
  });

  test('captures a frame from a video blob', async () => {
    const blob = await captureVideoPoster({ type: 'video/mp4' });
    assert.ok(blob, 'expected a poster blob');
    assert.strictEqual(blob.type, 'image/jpeg');
  });

  test('seeks past the opening frames, which are often black', async () => {
    await captureVideoPoster({ type: 'video/mp4' });
    assert.strictEqual(videos[0].currentTime, 1);
  });

  test('does not seek past the end of a very short clip', async () => {
    tweakVideo = (v) => {
      v.duration = 0.4;
    };
    await captureVideoPoster({ type: 'video/mp4' });
    assert.strictEqual(videos[0].currentTime, 0.2);
  });

  test('downscales the frame to bound the upload', async () => {
    // 1920x1080 exceeds the 1280 long edge and comes back proportional.
    await captureVideoPoster({ type: 'video/mp4' });
    assert.deepStrictEqual(drawnSizes, [[1280, 720]]);
  });

  test('releases the object URL it created', async () => {
    await captureVideoPoster({ type: 'video/mp4' });
    assert.deepStrictEqual(revoked, ['blob:fake']);
  });

  test('leaves no listeners on the element', async () => {
    await captureVideoPoster({ type: 'video/mp4' });
    assert.strictEqual(videos[0].listenerCount(), 0);
  });

  const nullCases = {
    'a video the browser cannot decode': (v) => {
      v.onSrc = (self) => queueMicrotask(() => self.emit('error'));
    },
    'a stream that reports no dimensions': (v) => {
      v.videoWidth = 0;
      v.videoHeight = 0;
    },
    'a seek that errors out': (v) => {
      v.onSeek = (self) => queueMicrotask(() => self.emit('error'));
    },
  };

  for (const [label, mutate] of Object.entries(nullCases)) {
    test(`resolves to null for ${label}`, async () => {
      tweakVideo = mutate;
      assert.strictEqual(await captureVideoPoster({ type: 'video/mp4' }), null);
      // Even on the failure paths the object URL must not leak.
      assert.deepStrictEqual(revoked, ['blob:fake']);
    });
  }

  test('resolves to null when the canvas is tainted', async () => {
    // A cross-origin frame makes toBlob hand back null.
    tweakCanvas = (c) => {
      c.toBlob = (cb) => cb(null);
    };
    assert.strictEqual(await captureVideoPoster({ type: 'video/mp4' }), null);
  });

  test('resolves to null without a source', async () => {
    assert.strictEqual(await captureVideoPoster(null), null);
  });

  test('takes a URL source without minting an object URL', async () => {
    await captureVideoPoster('/2026/07/clip.mp4');
    assert.strictEqual(videos[0].src, '/2026/07/clip.mp4');
    assert.deepStrictEqual(revoked, [], 'nothing was created, nothing to revoke');
  });
});

describe('isVideoFile', () => {
  test('accepts video MIME types', () => {
    assert.strictEqual(isVideoFile({ type: 'video/mp4' }), true);
    assert.strictEqual(isVideoFile({ type: 'video/quicktime' }), true);
  });

  test('rejects everything else', () => {
    assert.strictEqual(isVideoFile({ type: 'image/jpeg' }), false);
    assert.strictEqual(isVideoFile({}), false);
    assert.strictEqual(isVideoFile(null), false);
  });
});
