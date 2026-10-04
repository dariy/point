import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { captureVideoPoster, isVideoFile } from '../src/utils/videoPoster.ts';
import { mock } from './helpers/mock.ts';

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
  const RealURL = URL;
  let videos: FakeVideo[], revoked: string[], drawnSizes: [number, number][];
  /** Mutates the next fake <video> before it is handed to the module. */
  let tweakVideo: (v: FakeVideo) => void;
  /** Mutates the next fake <canvas> likewise. */
  let tweakCanvas: (c: HTMLCanvasElement) => void;

  type Listener = (event: { type: string }) => void;

  /** A <video> stand-in that fires events on demand. */
  class FakeVideo {
    videoWidth = 1920;
    videoHeight = 1080;
    duration = 30;
    _currentTime = 0;
    _src: string | undefined;
    listeners: Record<string, Listener[]> = {};
    // What the element does once src is assigned, and once it is seeked.
    // Tests override these to simulate decode errors and stalls.
    onSrc = (self: FakeVideo) => queueMicrotask(() => self.emit('loadedmetadata'));
    onSeek = (self: FakeVideo) => queueMicrotask(() => self.emit('seeked'));
    addEventListener(type: string, fn: Listener) {
      (this.listeners[type] ||= []).push(fn);
    }
    removeEventListener(type: string, fn: Listener) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    }
    emit(type: string) {
      (this.listeners[type] || []).slice().forEach((fn) => fn({ type }));
    }
    removeAttribute() {}
    load() {}
    listenerCount() {
      return Object.values(this.listeners).reduce((n, l) => n + l.length, 0);
    }
    set src(value: string | undefined) {
      this._src = value;
      this.onSrc(this);
    }
    get src() { return this._src; }
    set currentTime(value: number) {
      this._currentTime = value;
      this.onSeek(this);
    }
    get currentTime() { return this._currentTime; }
  }

  function fakeCanvas() {
    return mock<HTMLCanvasElement>({
      width: 0,
      height: 0,
      // The one boundary cast: getContext is overloaded per context id, and the stub serves only '2d'.
      getContext: (() => mock<CanvasRenderingContext2D>({
        drawImage: (_src: CanvasImageSource, _x: number, _y: number, w?: number, h?: number) => {
          drawnSizes.push([Number(w), Number(h)]);
        },
      })) as unknown as HTMLCanvasElement['getContext'],
      toBlob: (cb: BlobCallback) => cb(mock<Blob>({ type: 'image/jpeg', size: 1234 })),
    });
  }

  const MP4 = mock<Blob>({ type: 'video/mp4' });

  beforeEach(() => {
    videos = [];
    revoked = [];
    drawnSizes = [];
    tweakVideo = () => {};
    tweakCanvas = () => {};

    globalThis.document = mock<Document>({
      createElement(tag: string) {
        if (tag === 'video') {
          const v = new FakeVideo();
          tweakVideo(v);
          videos.push(v);
          return mock<HTMLVideoElement>(v);
        }
        const c = fakeCanvas();
        tweakCanvas(c);
        return c;
      },
    });
    globalThis.URL = class extends RealURL {
      static createObjectURL = () => 'blob:fake';
      static revokeObjectURL = (u: string) => { revoked.push(u); };
    };
    globalThis.location = mock<Location>({ href: 'https://photos.example/admin/media', origin: 'https://photos.example' });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'document');
    globalThis.URL = RealURL;
    Reflect.deleteProperty(globalThis, 'location');
  });

  test('captures a frame from a video blob', async () => {
    const blob = await captureVideoPoster(MP4);
    assert.ok(blob, 'expected a poster blob');
    assert.strictEqual(blob?.type, 'image/jpeg');
  });

  test('seeks past the opening frames, which are often black', async () => {
    await captureVideoPoster(MP4);
    assert.strictEqual(videos[0].currentTime, 1);
  });

  test('does not seek past the end of a very short clip', async () => {
    tweakVideo = (v: FakeVideo) => {
      v.duration = 0.4;
    };
    await captureVideoPoster(MP4);
    assert.strictEqual(videos[0].currentTime, 0.2);
  });

  test('downscales the frame to bound the upload', async () => {
    // 1920x1080 exceeds the 1280 long edge and comes back proportional.
    await captureVideoPoster(MP4);
    assert.deepStrictEqual(drawnSizes, [[1280, 720]]);
  });

  test('releases the object URL it created', async () => {
    await captureVideoPoster(MP4);
    assert.deepStrictEqual(revoked, ['blob:fake']);
  });

  test('leaves no listeners on the element', async () => {
    await captureVideoPoster(MP4);
    assert.strictEqual(videos[0].listenerCount(), 0);
  });

  const nullCases: Record<string, (v: FakeVideo) => void> = {
    'a video the browser cannot decode': (v) => {
      v.onSrc = (self: FakeVideo) => queueMicrotask(() => self.emit('error'));
    },
    'a stream that reports no dimensions': (v) => {
      v.videoWidth = 0;
      v.videoHeight = 0;
    },
    'a seek that errors out': (v) => {
      v.onSeek = (self: FakeVideo) => queueMicrotask(() => self.emit('error'));
    },
  };

  for (const [label, mutate] of Object.entries(nullCases)) {
    test(`resolves to null for ${label}`, async () => {
      tweakVideo = mutate;
      assert.strictEqual(await captureVideoPoster(MP4), null);
      // Even on the failure paths the object URL must not leak.
      assert.deepStrictEqual(revoked, ['blob:fake']);
    });
  }

  test('resolves to null when the canvas is tainted', async () => {
    // A cross-origin frame makes toBlob hand back null.
    tweakCanvas = (c: HTMLCanvasElement) => {
      c.toBlob = (cb: BlobCallback) => cb(null);
    };
    assert.strictEqual(await captureVideoPoster(MP4), null);
  });

  test('resolves to null without a source', async () => {
    // @ts-expect-error a missing source
    assert.strictEqual(await captureVideoPoster(null), null);
  });

  test('takes a URL source without minting an object URL', async () => {
    await captureVideoPoster('/2026/07/clip.mp4');
    assert.strictEqual(videos[0].src, 'https://photos.example/2026/07/clip.mp4');
    assert.deepStrictEqual(revoked, [], 'nothing was created, nothing to revoke');
  });

  for (const bad of ['javascript:alert(1)', 'https://evil.example/a.mp4', '//evil.example/a.mp4', 'data:video/mp4,x']) {
    test(`refuses a URL source that is not same-origin http(s): ${bad}`, async () => {
      assert.strictEqual(await captureVideoPoster(bad), null);
      assert.strictEqual(videos[0].src, undefined, 'the decoder never saw it');
    });
  }
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
