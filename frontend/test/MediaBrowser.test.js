/**
 * MediaBrowser — the media library, in both of the shapes it is used in.
 *
 * One component serves two hosts: the standalone /light/media page, and the
 * picker dialog the post editor opens. `pickerMode` is what separates them, and
 * nearly every behaviour here forks on it — the picker has no delete, no EXIF
 * panel, no lightbox and no gesture pager, but it does have a selection that
 * has to survive paging and folder changes. That fork is what most of these
 * tests are about; the rest cover the destructive actions (delete, bulk delete,
 * rename, EXIF overwrite), each of which must ask before it acts.
 *
 * The whole component talks to the backend through `fetch`, so one routing stub
 * covers it and the request log says what was actually asked for.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, fire, type, check } from './helpers/dom.js';
import { getToast, setToast } from '../src/store.js';

const settle = () => new Promise(r => setImmediate(r));

const IMAGE = { id: 1, filename: 'harbour.jpg', path: '/2024/08/harbour.jpg', file_type: 'image', file_size: 1024, uploaded_at: '2024-08-01T10:00:00Z', is_public: true, thumbnail_path: '/2024/08/harbour.jpg?s=512', width: 1600, height: 1200, metadata: { Make: 'Canon' } };
const VIDEO = { id: 2, filename: 'clip.mp4', path: '/2024/08/clip.mp4', file_type: 'video', file_size: 4096, uploaded_at: '2024-08-02T10:00:00Z', is_public: false, thumbnail_path: null };
const AUDIO = { id: 3, filename: 'note.mp3', path: '/2024/08/note.mp3', file_type: 'audio', file_size: 512, uploaded_at: '2024-08-03T10:00:00Z', is_public: true, thumbnail_path: null };

describe('MediaBrowser', () => {
  let dom, MediaBrowser, browser, requests, routes, navigations;

  function fakeFetch() {
    requests = [];
    globalThis.fetch = async (url, opts = {}) => {
      const method = opts.method || 'GET';
      const [path, query = ''] = String(url).split('?');
      let body;
      if (typeof opts.body === 'string') { try { body = JSON.parse(opts.body); } catch { body = opts.body; } }
      else body = opts.body;
      requests.push({ url: String(url), path, query, method, body, params: new URLSearchParams(query) });

      const key = Object.keys(routes)
        .filter(k => { const [m, p] = k.split(' '); return m === method && path.startsWith(p); })
        .sort((a, b) => b.length - a.length)[0];
      const result = key ? await routes[key]({ path, method, body }) : {};
      const { status = 200, payload = result } = result?.__response ? result : {};
      return {
        ok: status < 400,
        status,
        headers: { get: () => 'application/json' },
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    };
  }

  const fail = (status, message) => ({ __response: true, status, payload: { message } });

  async function mountBrowser(props = {}) {
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    browser = new MediaBrowser(el, props);
    browser.mount();
    await settle();
    await settle();
    return browser;
  }

  const q = sel => browser.container.querySelector(sel);
  const qa = sel => [...browser.container.querySelectorAll(sel)];
  const sent = (method, path) => requests.filter(r => r.method === method && r.path === path);
  const lastList = () => sent('GET', '/api/media').at(-1);
  const dialog = () => dom.document.querySelector('.confirm-dialog, .prompt-dialog, .modal-overlay');

  function acceptDialog() {
    const el = dialog();
    assert.ok(el, 'expected a dialog');
    click(el.querySelector('.btn-danger, .btn-warning, .btn-primary, .confirm-dialog__confirm'));
  }

  beforeEach(async () => {
    dom = setupDOM();
    navigations = [];
    dom.window.addEventListener('app:navigate', e => navigations.push(e.detail.path));
    routes = {
      'GET /api/media/folders': () => ({ folders: [{ year: '2024', month: '08', path: '2024/08' }, { year: '2024', month: '07', path: '2024/07' }] }),
      'GET /api/media': () => ({ media: [IMAGE, VIDEO, AUDIO], page: 1, pages: 2, total: 30 }),
      'GET /api/posts': () => ({ posts: [{ id: 5, title: 'Harbour lights', status: 'published' }] }),
      'POST /api/media/upload': () => ({ id: 9, filename: 'new.jpg', path: '/2024/08/new.jpg', file_type: 'image' }),
      'DELETE /api/media': () => ({}),
      'POST /api/media': () => ({}),
      'PUT /api/media': () => ({}),
    };
    fakeFetch();
    setToast(null);
    ({ MediaBrowser } = await import('../src/components/light/MediaBrowser.js'));
  });

  afterEach(() => {
    try { browser?.unmount(); } catch { /* torn down mid-flight */ }
    browser = null;
    dom.cleanup();
    delete globalThis.fetch;
  });

  // ── Loading and rendering ─────────────────────────────────────────────────

  describe('loading', () => {
    test('lists the folders and the first page of media', async () => {
      await mountBrowser();

      assert.equal(sent('GET', '/api/media/folders').length, 1);
      assert.equal(browser.state.media.length, 3);
      assert.equal(qa('.media-item').length, 3);
    });

    test('an image gets a thumbnail, a poster-less video gets the play glyph', async () => {
      await mountBrowser();

      assert.ok(q('.media-item[data-id="1"] img'), 'the image has a preview');
      assert.equal(q('.media-item[data-id="2"] img'), null);
      assert.match(q('.media-item[data-id="2"] .file-icon').textContent, /▶/);
    });

    test('a private file is flagged as such', async () => {
      await mountBrowser();

      assert.ok(q('.media-item[data-id="2"] .media-item-status'));
      assert.equal(q('.media-item[data-id="1"] .media-item-status'), null);
    });

    test('a failed load shows the reason instead of an empty grid', async () => {
      routes['GET /api/media'] = () => fail(500, 'storage offline');

      await mountBrowser();

      assert.equal(browser.state.error, 'storage offline');
      assert.match(q('.error-state').textContent, /storage offline/);
    });

    test('an empty library says so', async () => {
      routes['GET /api/media'] = () => ({ media: [], page: 1, pages: 1, total: 0 });

      await mountBrowser();

      assert.ok(q('.empty-state'));
    });

    test('a failed folder listing is survivable — the grid still loads', async () => {
      routes['GET /api/media/folders'] = () => fail(500, 'nope');

      await mountBrowser();

      assert.deepEqual(browser.state.folders, []);
      assert.equal(browser.state.media.length, 3);
    });
  });

  // ── Filtering and navigation ──────────────────────────────────────────────

  describe('filtering', () => {
    test('the type filter narrows both the listing and the folder tree', async () => {
      await mountBrowser();

      const select = q('.mb-type-filter');
      select.value = 'video';
      fire(select, 'change');
      await settle();

      assert.equal(lastList().params.get('file_type'), 'video');
      assert.equal(sent('GET', '/api/media/folders').at(-1).params.get('file_type'), 'video');
    });

    test('picking a folder chip scopes the listing to it', async () => {
      await mountBrowser();

      const chip = qa('.mb-folder-chip').find(c => c.dataset.folder === '2024');
      assert.ok(chip, 'the year chip is offered');
      click(chip);
      await settle();

      assert.equal(browser.state.selectedFolder, '2024');
      assert.equal(lastList().params.get('folder'), '2024');
    });

    test('a breadcrumb walks back out of a folder', async () => {
      await mountBrowser({ pickerMode: true });
      browser.setState({ selectedFolder: '2024/08' });

      click(qa('.mb-breadcrumb-item')[0]);
      await settle();

      assert.equal(browser.state.selectedFolder, null);
    });

    test('paging asks for the next page of the same listing', async () => {
      await mountBrowser();

      await browser._load({ page: 2 });

      assert.equal(lastList().params.get('page'), '2');
    });
  });

  // ── Referring posts ───────────────────────────────────────────────────────

  describe('referring posts', () => {
    test('every image asks which posts use it, and the answer is shown', async () => {
      await mountBrowser();

      assert.equal(sent('GET', '/api/posts').at(-1).params.get('q'), '/2024/08/harbour.jpg');
      assert.deepEqual(browser.state.referringPostsState[1].posts.map(p => p.id), [5]);
      assert.match(q('#ref-panel-1').textContent, /Harbour lights/);
    });

    test('a video is not searched for — only images can be used in a post body', async () => {
      await mountBrowser();

      assert.equal(requests.filter(r => r.path === '/api/posts' && r.params.get('q') === '/2024/08/clip.mp4').length, 0);
    });

    test('a search failure is recorded against that image alone', async () => {
      routes['GET /api/posts'] = () => fail(500, 'search is down');
      await mountBrowser();

      assert.equal(browser.state.referringPostsState[1].error, 'search is down');
      assert.match(q('#ref-panel-1 .referring-posts-error').textContent, /search is down/);
    });

    test('an image used nowhere gets no panel at all', async () => {
      routes['GET /api/posts'] = () => ({ posts: [] });
      await mountBrowser();

      assert.equal(q('#ref-panel-1'), null);
    });

    test('the picker does not ask at all — it is not an editing surface', async () => {
      await mountBrowser({ pickerMode: true });

      assert.equal(sent('GET', '/api/posts').length, 0);
    });
  });

  // ── Selection ─────────────────────────────────────────────────────────────

  describe('selection', () => {
    test('the picker selects by clicking an item, and remembers the object', async () => {
      await mountBrowser({ pickerMode: true });

      click(q('.media-item[data-id="1"]'));

      assert.deepEqual([...browser.state.selectedIds], [1]);
      assert.deepEqual(browser.getSelectedItems().map(m => m.id), [1]);
    });

    test('clicking again deselects and forgets it', async () => {
      await mountBrowser({ pickerMode: true });

      browser._toggleSelection(1);
      browser._toggleSelection(1);

      assert.equal(browser.state.selectedIds.size, 0);
      assert.deepEqual(browser.getSelectedItems(), []);
    });

    test('the checkbox is a second way in to the same selection', async () => {
      await mountBrowser({ pickerMode: true });

      fire(q('.media-item-check[data-id="3"]'), 'change');

      assert.deepEqual([...browser.state.selectedIds], [3]);
    });

    test('a selection survives a folder change, which is the point of keeping the objects', async () => {
      await mountBrowser({ pickerMode: true });
      browser._toggleSelection(1);

      routes['GET /api/media'] = () => ({ media: [AUDIO], page: 1, pages: 1, total: 1 });
      await browser._load({ page: 1 });

      assert.deepEqual(browser.getSelectedItems().map(m => m.id), [1]);
    });

    test('standalone: the selection bar reports the count and offers the actions', async () => {
      await mountBrowser();
      browser.setState({ selectMode: true, selectedIds: new Set([1, 2]) });

      assert.match(q('.mb-selection-count').textContent, /2 selected/);
      assert.equal(q('#mb-sel-delete').disabled, false);

      click(q('#mb-sel-cancel'));
      assert.equal(browser.state.selectMode, false);
    });
  });

  // ── Creating posts from media ─────────────────────────────────────────────

  describe('creating a post from media', () => {
    test('a single image is handed to the new-post editor', async () => {
      await mountBrowser();

      click(q('.create-post-btn[data-id="1"]'));

      assert.equal(globalThis.sessionStorage.getItem('newPostInitialContent'), '/2024/08/harbour.jpg');
      assert.equal(navigations.at(-1), '/light/posts/new');
    });

    test('a whole selection becomes one post, one path per line', async () => {
      await mountBrowser();
      browser.setState({ selectMode: true });
      browser._toggleSelection(1);
      browser._toggleSelection(3);

      await browser._createPostFromSelected();

      assert.equal(globalThis.sessionStorage.getItem('newPostInitialContent'), '/2024/08/harbour.jpg\n/2024/08/note.mp3');
      assert.equal(browser.state.selectMode, false);
    });

    test('an empty selection says so rather than opening a blank post', async () => {
      await mountBrowser();

      await browser._createPostFromSelected();

      assert.equal(getToast().type, 'error');
      assert.equal(navigations.length, 0);
    });
  });

  // ── Destructive actions ───────────────────────────────────────────────────

  describe('deleting', () => {
    test('a single file is confirmed first, then deleted and the list refreshed', async () => {
      await mountBrowser();

      click(q('.delete-media-btn[data-id="1"]'));
      assert.match(dialog().textContent, /harbour\.jpg/);
      assert.equal(sent('DELETE', '/api/media/1').length, 0);

      acceptDialog();
      await settle();

      assert.equal(sent('DELETE', '/api/media/1').length, 1);
      assert.match(getToast().message, /deleted/i);
    });

    test('cancelling deletes nothing', async () => {
      await mountBrowser();

      click(q('.delete-media-btn[data-id="1"]'));
      click(dialog().querySelector('.btn-secondary, .confirm-dialog__cancel'));
      await settle();

      assert.equal(sent('DELETE', '/api/media/1').length, 0);
    });

    test('a failed delete reports the reason', async () => {
      routes['DELETE /api/media/1'] = () => fail(409, 'still in use');
      await mountBrowser();

      await browser._deleteMedia(1);

      assert.equal(getToast().type, 'error');
    });

    test('a bulk delete names the count and tallies the failures', async () => {
      routes['DELETE /api/media/3'] = () => fail(500, 'nope');
      await mountBrowser();
      browser.setState({ selectMode: true, selectedIds: new Set([1, 3]) });

      browser._deleteSelected();
      await settle();
      assert.match(dialog().textContent, /Delete 2 files/);
      acceptDialog();
      await settle();

      assert.match(getToast().message, /Deleted 1, 1 failed/);
      assert.equal(browser.state.selectMode, false);
      assert.deepEqual(browser.getSelectedItems(), []);
    });

    test('a bulk delete with nothing selected asks nothing', async () => {
      await mountBrowser();

      browser._deleteSelected();
      await settle();

      assert.equal(dialog(), null);
    });
  });

  describe('renaming', () => {
    test('a new name is sanitised and sent', async () => {
      await mountBrowser();
      browser._renameMedia = async (id, name) => { browser._renamed = [id, name]; };

      click(q('.rename-media-btn[data-id="1"]'));
      const input = dialog().querySelector('input');
      type(input, 'sea front!!.jpg');
      acceptDialog();

      assert.deepEqual(browser._renamed, [1, 'sea frontjpg']);
    });

    test('the prompt is prefilled with the real filename, not an escaped copy', async () => {
      // data-name carries the name from the markup back into the prompt. It was
      // escaped twice — escapeHtml() inside a template the codemod had already
      // turned into html`` — so a name with an ampersand came back as
      // "a &amp; b.png", and confirming the prompt renamed the file to that.
      routes['GET /api/media'] = () => ({
        media: [{ ...IMAGE, id: 1, filename: 'a & b.png', path: '/2024/08/a & b.png' }],
        page: 1, pages: 1, total: 1,
      });
      await mountBrowser();
      const btn = q('.rename-media-btn[data-id="1"]');
      assert.equal(btn.getAttribute('data-name'), 'a & b.png');

      click(btn);
      assert.equal(dialog().querySelector('input').value, 'a & b.png');
    });

    test('a name with nothing usable left in it is refused', async () => {
      await mountBrowser();

      click(q('.rename-media-btn[data-id="1"]'));
      type(dialog().querySelector('input'), '!!!');
      acceptDialog();
      await settle();

      assert.equal(getToast().type, 'error');
      assert.equal(sent('POST', '/api/media/1/rename').length, 0);
    });

    test('confirming a name that comes back unchanged spends no request', async () => {
      await mountBrowser();

      // Sanitiser-clean to begin with, so accepting the prefilled value is
      // genuinely a no-op rather than a rename to a slightly different string.
      browser._showRenamePrompt(1, 'harbour jpg');
      acceptDialog();
      await settle();

      assert.equal(sent('POST', '/api/media/1/rename').length, 0);
    });

    test('the rename reaches the API and refreshes the listing', async () => {
      await mountBrowser();

      await browser._renameMedia(1, 'sea front');
      await settle();

      assert.equal(sent('POST', '/api/media/1/rename').at(-1).body.new_filename, 'sea front');
      assert.match(getToast().message, /renamed/i);
    });

    test('a failed rename reports the reason', async () => {
      routes['POST /api/media/1/rename'] = () => fail(409, 'name taken');
      await mountBrowser();

      await browser._renameMedia(1, 'sea front');

      assert.equal(getToast().type, 'error');
    });
  });

  // ── Uploading ─────────────────────────────────────────────────────────────

  describe('uploading', () => {
    const file = name => new File([''], name, { type: 'image/jpeg' });

    test('files go up one at a time and the list is refreshed', async () => {
      await mountBrowser();

      await browser._uploadFiles([file('a.jpg'), file('b.jpg')]);
      await settle();

      assert.equal(sent('POST', '/api/media/upload').length, 2);
      assert.match(getToast().message, /Uploaded 2/);
      assert.equal(browser.state.uploading, false);
    });

    test('a failure is counted, not fatal', async () => {
      let n = 0;
      routes['POST /api/media/upload'] = () => (++n === 1 ? fail(413, 'too large') : { id: 9, path: '/2024/08/b.jpg' });
      await mountBrowser();

      await browser._uploadFiles([file('a.jpg'), file('b.jpg')]);
      await settle();

      assert.match(getToast().message, /Uploaded 1, 1 failed/);
      assert.equal(getToast().type, 'warning');
    });

    test('uploading nothing is a no-op', async () => {
      await mountBrowser();

      await browser._uploadFiles([]);

      assert.equal(sent('POST', '/api/media/upload').length, 0);
    });

    test('the picker pre-selects what was just uploaded', async () => {
      await mountBrowser({ pickerMode: true });

      await browser._uploadFiles([file('new.jpg')]);
      await settle();

      assert.deepEqual(browser.getSelectedItems().map(m => m.id), [9]);
      assert.ok(browser.state.selectedIds.has(9));
    });

    test('the hidden file input is what the host page\'s Upload button reaches', async () => {
      await mountBrowser();
      let clicked = false;
      q('#mb-file-input').addEventListener('click', () => { clicked = true; });

      browser.openFilePicker();

      assert.equal(clicked, true);
    });
  });

  // ── EXIF editing ──────────────────────────────────────────────────────────

  describe('EXIF editing', () => {
    test('the panel starts hidden and the info button opens it', async () => {
      await mountBrowser();

      assert.equal(q('#exif-panel-1').hidden, true);
      click(q('.exif-toggle-btn[data-id="1"]'));
      assert.equal(q('#exif-panel-1').hidden, false);
    });

    test('the stored fields are shown as editable rows', async () => {
      await mountBrowser();

      assert.equal(q('#exif-panel-1 .exif-key').value, 'Make');
      assert.equal(q('#exif-panel-1 .exif-val').value, 'Canon');
    });

    test('a row can be added and removed', async () => {
      await mountBrowser();
      const rows = () => browser.container.querySelectorAll('#exif-panel-1 .exif-rows tr').length;
      const before = rows();

      click(q('#exif-panel-1 .exif-add-btn'));
      assert.equal(rows(), before + 1);

      click([...browser.container.querySelectorAll('#exif-panel-1 .exif-delete-btn')].at(-1));
      assert.equal(rows(), before);
    });

    test('saving sends the non-empty fields', async () => {
      await mountBrowser();

      click(q('#exif-panel-1 .exif-save-btn'));
      await settle();

      assert.deepEqual(sent('PUT', '/api/media/1/exif').at(-1).body, { Make: 'Canon' });
      assert.match(getToast().message, /EXIF saved/);
    });

    test('a value with punctuation in it is refused before anything is sent', async () => {
      await mountBrowser();
      type(q('#exif-panel-1 .exif-val'), 'Canon <script>');

      click(q('#exif-panel-1 .exif-save-btn'));
      await settle();

      assert.match(getToast().message, /Invalid characters in: Make/);
      assert.equal(sent('PUT', '/api/media/1/exif').length, 0);
    });

    test('a failed save reports the reason', async () => {
      routes['PUT /api/media/1/exif'] = () => fail(500, 'file is read-only');
      await mountBrowser();

      click(q('#exif-panel-1 .exif-save-btn'));
      await settle();

      assert.equal(getToast().type, 'error');
    });

    test('reverting warns first, then rebuilds the rows from what came back', async () => {
      routes['POST /api/media/1/revert-exif'] = () => ({ metadata: { Make: 'Nikon', Lens: '50mm' } });
      await mountBrowser();

      click(q('#exif-panel-1 .exif-revert-btn'));
      assert.match(dialog().textContent, /overwrite your edits/);
      acceptDialog();
      await settle();

      assert.deepEqual(qa('#exif-panel-1 .exif-key').map(i => i.value), ['Make', 'Lens']);
      assert.match(getToast().message, /reverted/i);
    });

    test('a failed revert reports the reason', async () => {
      routes['POST /api/media/1/revert-exif'] = () => fail(500, 'no original kept');
      await mountBrowser();

      click(q('#exif-panel-1 .exif-revert-btn'));
      acceptDialog();
      await settle();

      assert.equal(getToast().type, 'error');
    });

    test('re-extracting warns first, then rebuilds the rows from the file', async () => {
      routes['POST /api/media/1/reextract'] = () => ({ metadata: { Make: 'Leica' } });
      await mountBrowser();

      click(q('#exif-panel-1 .exif-reextract-btn'));
      assert.match(dialog().textContent, /overwrite manual EXIF edits/);
      acceptDialog();
      await settle();

      assert.deepEqual(qa('#exif-panel-1 .exif-key').map(i => i.value), ['Make']);
      assert.match(getToast().message, /re-extracted/i);
    });

    test('a file with no EXIF in it says so rather than claiming success', async () => {
      routes['POST /api/media/1/reextract'] = () => ({ metadata: {} });
      await mountBrowser();

      click(q('#exif-panel-1 .exif-reextract-btn'));
      acceptDialog();
      await settle();

      assert.match(getToast().message, /No EXIF data found/);
    });

    test('a failed re-extract reports the reason', async () => {
      routes['POST /api/media/1/reextract'] = () => fail(500, 'file missing');
      await mountBrowser();

      click(q('#exif-panel-1 .exif-reextract-btn'));
      acceptDialog();
      await settle();

      assert.equal(getToast().type, 'error');
    });

    test('the picker has no EXIF panels — it is a chooser, not an editor', async () => {
      await mountBrowser({ pickerMode: true });

      assert.equal(q('.exif-panel'), null);
      assert.equal(q('.delete-media-btn'), null);
    });
  });

  // ── Poster backfill ───────────────────────────────────────────────────────

  describe('video poster backfill', () => {
    test('the offer appears only when a video on the page lacks a poster', async () => {
      await mountBrowser();

      assert.match(q('.mb-posters-btn').textContent, /Poster 1 video/);
    });

    test('nothing to backfill, nothing offered', async () => {
      routes['GET /api/media'] = () => ({ media: [IMAGE], page: 1, pages: 1, total: 1 });
      await mountBrowser();

      assert.equal(q('.mb-posters-btn'), null);
    });

    test('the picker never offers it', async () => {
      await mountBrowser({ pickerMode: true });

      assert.equal(q('.mb-posters-btn'), null);
    });

    test('a run that decodes nothing says so instead of claiming success', async () => {
      await mountBrowser();

      await browser._backfillPosters();
      await settle();

      // No decoder in this environment, so every capture fails — which is the
      // branch that has to report rather than silently do nothing.
      assert.match(getToast().message, /could not be decoded/);
      assert.equal(browser.state.capturingPosters, false);
    });

    test('a run already in flight is not started twice', async () => {
      await mountBrowser();
      browser.state.capturingPosters = true;

      await browser._backfillPosters();

      assert.equal(getToast(), null);
    });
  });

  // ── Copying paths ─────────────────────────────────────────────────────────

  describe('copying a path', () => {
    test('the path goes to the clipboard', async () => {
      let copied = null;
      globalThis.navigator.clipboard = { writeText: async t => { copied = t; } };
      await mountBrowser();

      click(q('.copy-path-btn[data-path="/2024/08/harbour.jpg"]'));
      await settle();

      assert.equal(copied, '/2024/08/harbour.jpg');
      assert.match(getToast().message, /Copied/);
    });

    test('a rejected clipboard write is reported', async () => {
      globalThis.navigator.clipboard = { writeText: async () => { throw new Error('denied'); } };
      await mountBrowser();

      click(q('.copy-path-btn[data-path="/2024/08/harbour.jpg"]'));
      await settle();

      assert.equal(getToast().message, 'Copy failed');
    });

    test('no clipboard at all — over plain HTTP — says why', async () => {
      globalThis.navigator.clipboard = undefined;
      await mountBrowser();

      click(q('.copy-path-btn[data-path="/2024/08/harbour.jpg"]'));
      await settle();

      assert.match(getToast().message, /requires HTTPS/);
    });
  });

  // ── Teardown ──────────────────────────────────────────────────────────────

  describe('teardown', () => {
    /** Drop `files` on the document, the way a drag from the desktop ends. */
    const dropFiles = (files) => {
      const evt = new globalThis.Event('drop', { bubbles: true, cancelable: true });
      evt.dataTransfer = { types: ['Files'], files };
      dom.document.dispatchEvent(evt);
    };

    test('unmounting drops the drag listeners it registered', async () => {
      await mountBrowser();
      const uploaded = [];
      browser._uploadFiles = (files) => uploaded.push(files);

      dropFiles([{ name: 'a.jpg' }]);
      assert.equal(uploaded.length, 1, 'the browser answers a desktop drop while mounted');

      browser.unmount();
      dropFiles([{ name: 'b.jpg' }]);
      browser = null;

      assert.equal(uploaded.length, 1, 'and nothing after it is gone');
    });

    test('re-rendering does not accumulate a second set of drop handlers', async () => {
      await mountBrowser();
      const uploaded = [];
      browser._uploadFiles = (files) => uploaded.push(files);

      browser.setState({ view: 'list' });
      browser.setState({ view: 'grid' });
      dropFiles([{ name: 'a.jpg' }]);

      assert.equal(uploaded.length, 1, 'one upload, not one per render');
    });
  });
});
