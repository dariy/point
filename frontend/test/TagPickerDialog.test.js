import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, type, check } from './helpers/dom.js';

/** Let the confirm handler's async body settle. */
const flush = () => new Promise(r => setTimeout(r, 0));

let dom;
let TagPickerDialog;

beforeEach(async () => {
  dom = setupDOM();
  TagPickerDialog ??= await import('../src/components/light/tags/TagPickerDialog.js');
});
afterEach(() => dom.cleanup());

const tags = [
  { id: 1, name: 'Travel' },
  { id: 2, name: 'France' },
  { id: 3, name: 'Japan' },
];

/** Minimal valid picker config; each test overrides what it cares about. */
const open = (over = {}) => TagPickerDialog.openTagPickerDialog({
  title: 'Pick one',
  modalClass: 'tm-move-modal',
  tags,
  radioName: 'pick',
  renderItem: t => `<label class="item"><input type="radio" name="pick" value="${t.id}"><span class="nm">${t.name}</span></label>`,
  itemClass: 'item',
  nameClass: 'nm',
  listClass: 'list',
  searchClass: 'search',
  cancelId: 'cancel-btn',
  confirmId: 'confirm-btn',
  confirmLabel: 'Go',
  onConfirm: () => {},
  onEmpty: () => {},
  ...over,
});

describe('openOverlay', () => {
  test('appends an active overlay to the body', () => {
    const { overlay } = TagPickerDialog.openOverlay('<div class="modal">hi</div>');
    assert.equal(document.body.children.length, 1);
    assert.equal(overlay.className, 'modal-overlay active');
    assert.match(overlay.innerHTML, /hi/);
  });

  test('close() removes it', () => {
    const { close } = TagPickerDialog.openOverlay('<div class="modal">hi</div>');
    close();
    assert.equal(document.body.children.length, 0);
  });

  test('clicking the backdrop closes; clicking inside does not', () => {
    const { overlay } = TagPickerDialog.openOverlay('<div class="modal">hi</div>');
    click(overlay.querySelector('.modal'));
    assert.equal(document.body.children.length, 1, 'a click inside the modal is not a dismissal');
    click(overlay);
    assert.equal(document.body.children.length, 0);
  });

  test('the × button closes when the markup has one', () => {
    TagPickerDialog.openOverlay('<div class="modal"><button class="modal-close">x</button></div>');
    click(document.querySelector('.modal-close'));
    assert.equal(document.body.children.length, 0);
  });

  test('markup without a × button still opens', () => {
    // The drop-confirm dialog has no close button — this must not throw.
    assert.doesNotThrow(() => TagPickerDialog.openOverlay('<div class="modal">no close</div>'));
    assert.equal(document.body.children.length, 1);
  });
});

describe('openTagPickerDialog', () => {
  test('renders one item per tag, plus title and confirm label', () => {
    const { overlay } = open();
    assert.equal(overlay.querySelectorAll('.item').length, 3);
    assert.match(overlay.querySelector('h3').textContent, /Pick one/);
    assert.match(overlay.querySelector('#confirm-btn').textContent, /Go/);
  });

  test('renders an empty list without throwing', () => {
    const { overlay } = open({ tags: [] });
    assert.equal(overlay.querySelectorAll('.item').length, 0);
  });

  test('places beforeList and afterList around the list', () => {
    const { overlay } = open({ beforeList: '<p id="pre">before</p>', afterList: '<p id="post">after</p>' });
    const body = overlay.querySelector('.modal-body').innerHTML;
    assert.ok(body.indexOf('id="pre"') < body.indexOf('class="list"'));
    assert.ok(body.indexOf('class="list"') < body.indexOf('id="post"'));
  });

  describe('search', () => {
    test('hides items whose name does not match', () => {
      const { overlay } = open();
      type(overlay.querySelector('.search'), 'jap');
      const hidden = [...overlay.querySelectorAll('.item')].map(i => i.classList.contains('hidden'));
      assert.deepEqual(hidden, [true, true, false]);
    });

    test('is case-insensitive and trims', () => {
      const { overlay } = open();
      type(overlay.querySelector('.search'), '  TRAVEL  ');
      assert.equal(overlay.querySelector('.item').classList.contains('hidden'), false);
    });

    test('an emptied search box reveals everything again', () => {
      const { overlay } = open();
      type(overlay.querySelector('.search'), 'zzz');
      assert.ok([...overlay.querySelectorAll('.item')].every(i => i.classList.contains('hidden')));
      type(overlay.querySelector('.search'), '');
      assert.ok([...overlay.querySelectorAll('.item')].every(i => !i.classList.contains('hidden')));
    });
  });

  describe('confirm', () => {
    test('calls onEmpty and stays open when nothing is selected', () => {
      let empties = 0, confirms = 0;
      const { overlay } = open({ onEmpty: () => empties++, onConfirm: () => confirms++ });
      click(overlay.querySelector('#confirm-btn'));
      assert.deepEqual([empties, confirms], [1, 0]);
      assert.equal(document.body.children.length, 1, 'the dialog stays up so the user can choose');
    });

    test('passes the selected id as a number and closes', async () => {
      let got = 'unset';
      const { overlay } = open({ onConfirm: id => { got = id; } });
      check(overlay.querySelectorAll('input[name="pick"]')[2]);
      click(overlay.querySelector('#confirm-btn'));
      await flush();
      assert.strictEqual(got, 3);
      assert.equal(document.body.children.length, 0);
    });

    test('collect runs before the close, onConfirm after', async () => {
      const order = [];
      const { overlay } = open({
        afterList: '<input type="checkbox" id="extra" checked>',
        collect: ov => {
          order.push('collect');
          // Still attached: reading the extra control here is the whole point.
          assert.ok(ov.querySelector('#extra'), 'overlay is still live during collect');
          return ov.querySelector('#extra').checked;
        },
        onConfirm: (id, extras) => {
          order.push('confirm');
          assert.equal(document.body.children.length, 0, 'dialog is gone by the time work starts');
          assert.equal(extras, true, 'the collected value survives the close');
        },
      });
      check(overlay.querySelector('input[name="pick"]'));
      click(overlay.querySelector('#confirm-btn'));
      await flush();
      assert.deepEqual(order, ['collect', 'confirm']);
    });

    test('works without a collect callback', async () => {
      let extras = 'unset';
      const { overlay } = open({ onConfirm: (id, e) => { extras = e; } });
      check(overlay.querySelector('input[name="pick"]'));
      click(overlay.querySelector('#confirm-btn'));
      await flush();
      assert.equal(extras, undefined);
    });

    test('only the checked radio wins after the choice changes', async () => {
      let got = null;
      const { overlay } = open({ onConfirm: id => { got = id; } });
      const radios = overlay.querySelectorAll('input[name="pick"]');
      check(radios[0]);
      check(radios[1]);
      click(overlay.querySelector('#confirm-btn'));
      await flush();
      assert.strictEqual(got, 2);
    });
  });

  describe('dismissal', () => {
    test('cancel closes without confirming', () => {
      let confirms = 0;
      const { overlay } = open({ onConfirm: () => confirms++ });
      check(overlay.querySelector('input[name="pick"]'));
      click(overlay.querySelector('#cancel-btn'));
      assert.equal(document.body.children.length, 0);
      assert.equal(confirms, 0, 'a selection is discarded on cancel');
    });

    test('the × and the backdrop also close', () => {
      const a = open();
      click(a.overlay.querySelector('.modal-close'));
      assert.equal(document.body.children.length, 0);

      const b = open();
      click(b.overlay);
      assert.equal(document.body.children.length, 0);
    });
  });

  test('onMount receives the live overlay and the close function', () => {
    let seen = null;
    const { overlay, close } = open({
      afterList: '<select id="pos"><option value="">x</option></select>',
      onMount: (ov, cl) => { seen = { hasSelect: !!ov.querySelector('#pos'), closes: typeof cl }; },
    });
    assert.deepEqual(seen, { hasSelect: true, closes: 'function' });
    assert.ok(overlay && close);
  });

  test('two dialogs can be open at once and close independently', () => {
    const a = open();
    const b = open({ cancelId: 'cancel-2', confirmId: 'confirm-2' });
    assert.equal(document.body.children.length, 2);
    a.close();
    assert.equal(document.body.children.length, 1);
    assert.ok(document.body.contains(b.overlay));
  });
});
