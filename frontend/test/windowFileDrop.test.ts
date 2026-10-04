import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { setupDOM } from './helpers/dom.ts';
import { mock } from './helpers/mock.ts';
import { attachWindowFileDrop } from '../src/utils/windowFileDrop.ts';

/** A drag event carrying a dataTransfer linkedom does not model itself. */
function dragEvent(type: string, { files = [] as File[], types = ['Files'] } = {}): Event {
  const e = new globalThis.Event(type, { bubbles: true, cancelable: true });
  return Object.assign(e, { dataTransfer: mock<DataTransfer>({ types, files: mock<FileList>(files) }) });
}

const file = (name: string, type: string) => mock<File>({ name, type });

describe('attachWindowFileDrop', () => {
  let dom: ReturnType<typeof setupDOM>;
  let detach: (() => void) | null;
  let dropped: string[];

  beforeEach(() => {
    dom = setupDOM();
    dropped = [];
    detach = attachWindowFileDrop({ onFile: (f) => dropped.push(f.name) });
  });
  afterEach(() => {
    detach?.();
    dom.cleanup();
  });

  test('dropped images and videos reach the callback, other files do not', () => {
    document.dispatchEvent(dragEvent('drop', {
      files: [file('a.jpg', 'image/jpeg'), file('b.mp4', 'video/mp4'), file('c.pdf', 'application/pdf')],
    }));
    assert.deepStrictEqual(dropped, ['a.jpg', 'b.mp4']);
  });

  test('a drop is prevented so the browser does not navigate to the file', () => {
    const e = dragEvent('drop', { files: [file('a.jpg', 'image/jpeg')] });
    document.dispatchEvent(e);
    assert.strictEqual(e.defaultPrevented, true);
  });

  test('dragging files over the page marks the body, leaving unmarks it', () => {
    document.dispatchEvent(dragEvent('dragenter'));
    assert.ok(document.body.classList.contains('drag-active'), 'marked on enter');
    document.dispatchEvent(dragEvent('dragleave'));
    assert.ok(!document.body.classList.contains('drag-active'), 'unmarked on leave');
  });

  test('crossing nested elements does not unmark early — enters are counted', () => {
    document.dispatchEvent(dragEvent('dragenter'));
    document.dispatchEvent(dragEvent('dragenter'));
    document.dispatchEvent(dragEvent('dragleave'));
    assert.ok(document.body.classList.contains('drag-active'), 'still over the page');
    document.dispatchEvent(dragEvent('dragleave'));
    assert.ok(!document.body.classList.contains('drag-active'), 'now really gone');
  });

  test('a drag of something that is not a file is ignored', () => {
    document.dispatchEvent(dragEvent('dragenter', { types: ['text/plain'] }));
    assert.ok(!document.body.classList.contains('drag-active'));
  });

  test("the page's own drags are ignored until they end", () => {
    document.dispatchEvent(new globalThis.Event('dragstart', { bubbles: true }));
    document.dispatchEvent(dragEvent('dragenter'));
    assert.ok(!document.body.classList.contains('drag-active'), 'an internal drag is not an upload');

    document.dispatchEvent(dragEvent('drop', { files: [file('a.jpg', 'image/jpeg')] }));
    assert.deepStrictEqual(dropped, [], 'and dropping one uploads nothing');

    document.dispatchEvent(new globalThis.Event('dragend', { bubbles: true }));
    document.dispatchEvent(dragEvent('drop', { files: [file('a.jpg', 'image/jpeg')] }));
    assert.deepStrictEqual(dropped, ['a.jpg'], 'a file drop works again afterwards');
  });

  test('detaching stops the handlers and clears the mark', () => {
    document.dispatchEvent(dragEvent('dragenter'));
    detach?.();
    detach = null;
    assert.ok(!document.body.classList.contains('drag-active'), 'mark cleared on detach');

    document.dispatchEvent(dragEvent('drop', { files: [file('a.jpg', 'image/jpeg')] }));
    assert.deepStrictEqual(dropped, [], 'no uploads after detach');
  });
});
