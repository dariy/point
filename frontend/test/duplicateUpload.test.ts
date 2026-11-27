import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Media } from '../src/api/media.ts';
import { jsonResponse } from './helpers/fetch.ts';
import { setupDOM, must } from './helpers/dom.ts';

// NF-16: an exact duplicate at upload is a question, not a silent reuse.
describe('duplicate upload', () => {
  let dom: ReturnType<typeof setupDOM> | undefined;
  beforeEach(() => { dom = setupDOM(); });
  afterEach(() => { dom?.cleanup(); });

  const existing = (over: Partial<Media> = {}) => ({ id: 7, path: '/2026/01/a.jpg', deleted_at: null, ...over }) as Media;
  const conflict = (m: Media) => jsonResponse({ ok: false, status: 409, body: { message: 'dup', code: 'duplicate', existing: m } });
  const created = (id: number) => jsonResponse({ ok: true, status: 201, body: { id, path: `/2026/01/${id}.jpg` } });

  /** A fake fetch that answers in order and records the on_duplicate of each upload. */
  function serve(replies: Array<(url: string) => Response>) {
    const seen: string[] = [];
    let i = 0;
    globalThis.fetch = async (input, opts) => {
      const url = String(input);
      const body = opts?.body;
      seen.push(body instanceof FormData ? `${url} ${body.get('on_duplicate')}` : `${url} ${opts?.method ?? 'GET'}`);
      return replies[i++](url);
    };
    return seen;
  }

  const click = (id: string) => must(document.querySelector<HTMLElement>(`#${id}`), id).click();
  const tick = () => new Promise(r => setTimeout(r, 0));
  const file = (name: string) => new File([name], name, { type: 'image/jpeg' });

  test('duplicateOf reads only the duplicate 409', async () => {
    const { duplicateOf } = await import('../src/api/media.ts');
    assert.equal(duplicateOf({ status: 409, body: { code: 'duplicate', existing: existing() } })?.id, 7);
    assert.equal(duplicateOf({ status: 409, body: { code: 'other' } }), null);
    assert.equal(duplicateOf({ status: 500, message: 'x' }), null);
    assert.equal(duplicateOf(null), null);
  });

  test('no match uploads once with ask', async () => {
    const seen = serve([() => created(3)]);
    const { uploadAskingOnDuplicate } = await import('../src/utils/duplicateUpload.ts');
    const m = await uploadAskingOnDuplicate(file('a.jpg'));
    assert.equal(m?.id, 3);
    assert.deepEqual(seen, ['/api/media/upload ask']);
  });

  test('a match asks; Use the existing file returns the existing media', async () => {
    const seen = serve([() => conflict(existing())]);
    const { uploadAskingOnDuplicate } = await import('../src/utils/duplicateUpload.ts');
    const pending = uploadAskingOnDuplicate(file('a.jpg'));
    await tick();
    assert.match(document.body.textContent ?? '', /"a\.jpg" is already in the library\./);
    click('duplicate-existing-btn');
    assert.equal((await pending)?.id, 7);
    assert.deepEqual(seen, ['/api/media/upload ask']);
    assert.equal(document.querySelector('#duplicate-existing-btn'), null);
  });

  test('a trashed match is restored by Use the existing file', async () => {
    const seen = serve([
      () => conflict(existing({ deleted_at: '2026-01-02T00:00:00Z' })),
      () => jsonResponse({ ok: true, status: 200, body: { message: 'ok' } }),
      () => jsonResponse({ ok: true, status: 200, body: existing() }),
    ]);
    const { uploadAskingOnDuplicate } = await import('../src/utils/duplicateUpload.ts');
    const pending = uploadAskingOnDuplicate(file('a.jpg'));
    await tick();
    assert.match(document.body.textContent ?? '', /in the trash/);
    click('duplicate-existing-btn');
    const m = await pending;
    assert.equal(m?.deleted_at, null);
    assert.deepEqual(seen, ['/api/media/upload ask', '/api/media/7/restore POST', '/api/media/7 GET']);
  });

  test('Upload again sends the file with new; a closed question uploads nothing', async () => {
    const seen = serve([() => conflict(existing()), () => created(8), () => conflict(existing())]);
    const { uploadAskingOnDuplicate } = await import('../src/utils/duplicateUpload.ts');
    const again = uploadAskingOnDuplicate(file('a.jpg'));
    await tick();
    click('duplicate-again-btn');
    assert.equal((await again)?.id, 8);

    const closed = uploadAskingOnDuplicate(file('a.jpg'));
    await tick();
    click('modal-close-btn');
    assert.equal(await closed, null);
    assert.deepEqual(seen, ['/api/media/upload ask', '/api/media/upload new', '/api/media/upload ask']);
  });

  test('a batch asks once for all of its matches', async () => {
    const seen = serve([
      () => conflict(existing({ id: 7 })),
      () => created(3),
      () => conflict(existing({ id: 9 })),
    ]);
    const { uploadBatchAskingOnDuplicate } = await import('../src/utils/duplicateUpload.ts');
    const pending = uploadBatchAskingOnDuplicate([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    await tick(); await tick(); await tick();
    assert.equal(document.querySelectorAll('#duplicate-existing-btn').length, 1);
    assert.match(document.body.textContent ?? '', /2 files are already in the library\./);
    click('duplicate-existing-btn');
    const res = await pending;
    assert.deepEqual(res.media.map(m => m.id), [7, 3, 9]);
    assert.equal(res.duplicates, 2);
    assert.equal(res.choice, 'existing');
    assert.equal(seen.length, 3);
  });
  // The callers outside the media library: no trashed match comes back from
  // the trash with no question.
  const trashed = () => existing({ deleted_at: '2026-01-02T00:00:00Z' });

  test('an offline share draft asks on a trashed match; a closed question leaves it out', async () => {
    const seen = serve([
      () => jsonResponse({ ok: true, status: 201, body: { id: 40 } }),
      () => conflict(trashed()),
      () => created(3),
      () => jsonResponse({ ok: true, status: 200, body: { id: 40 } }),
    ]);
    const { saveShareDraft } = await import('../src/utils/shareDrafts.ts');
    const data = (name: string) => ({ name, type: 'image/jpeg', data: new TextEncoder().encode(name).buffer });
    const pending = saveShareDraft({ id: 's', title: 'Trip', timestamp: 1, files: [data('a.jpg'), data('b.jpg')] });
    for (let i = 0; i < 6; i++) await tick();
    assert.match(document.body.textContent ?? '', /in the trash/);
    click('modal-close-btn');
    const res = await pending;
    assert.deepEqual(res, { postId: 40, skipped: 1 });
    assert.deepEqual(seen, [
      '/api/posts POST',
      '/api/media/upload ask',
      '/api/media/upload ask',
      '/api/posts/40 PUT',
    ]);
    assert.ok(!seen.some(s => s.includes('restore')), 'nothing restored with no question');
  });

  test('the first-post page asks on a trashed match and adds the restored file', async () => {
    const seen = serve([
      () => conflict(trashed()),
      () => jsonResponse({ ok: true, status: 200, body: { message: 'ok' } }),
      () => jsonResponse({ ok: true, status: 200, body: existing() }),
    ]);
    const { default: FirstPostPage } = await import('../src/pages/light/FirstPostPage.ts');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const page = new FirstPostPage(root);
    page.mount();
    const pending = page._upload([file('a.jpg')]);
    await tick(); await tick();
    assert.match(document.body.textContent ?? '', /"a\.jpg" is already in the library, in the trash\./);
    click('duplicate-existing-btn');
    await pending;
    assert.deepEqual(page.state.media.map(m => m.id), [7]);
    assert.equal(page.state.step, 'review');
    assert.deepEqual(seen, ['/api/media/upload ask', '/api/media/7/restore POST', '/api/media/7 GET']);
  });
});
