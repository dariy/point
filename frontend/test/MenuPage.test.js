/**
 * MenuPage — the custom-menu editor at /light/menu, in both of its formats.
 *
 * The page keeps the authored menu in the DOM rather than in state while the
 * owner is editing: re-rendering on every keystroke would take the focus out of
 * the field being typed in, so `_collectVisualItems()` reads the rows back only
 * when something structural happens (add, delete, indent, reorder, format
 * switch, save). That choice is what these tests are mostly about, because it
 * puts two representations of the same list side by side and every bug worth
 * having a test for is the two of them disagreeing:
 *
 *   • Row handlers close over the row's own `data-index`, so anything that
 *     drops a row while collecting shifts every index after it. A row whose
 *     label is momentarily empty — which is simply what a field looks like
 *     halfway through being retyped — must therefore still occupy its slot.
 *     Filtering happens at the three places where an unnamed row genuinely has
 *     no meaning: the preview, the markdown text, and the save payload.
 *
 *   • Rows carry no `draggable` attribute until the pointer goes down on the
 *     handle. A permanently-draggable row swallows mousedown on the inputs
 *     inside it, and the fields cannot be edited with a mouse at all — the
 *     gesture starts a row drag instead of selecting the text it is dragged
 *     across. Verified in Chromium; asserted here as the arming protocol,
 *     which is the part a DOM without a drag implementation can still see.
 *
 * The markdown format is the same list spelled out as text, so it gets the
 * mirror-image treatment: parse, serialise, and the round trip between the two
 * editors, which is the only place the two parsers meet.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM, click, fire, type } from './helpers/dom.js';
import { store } from '../src/store.js';

/** Home, About > Team, Blog — one nested branch, roots either side of it. */
const MARKDOWN = [
  '- [Home](/)',
  '- [About](/about)',
  '  - [Team](/about/team)',
  '- [Blog](/blog)',
].join('\n');

describe('MenuPage', () => {
  let dom, MenuPage, page, requests, config;

  const settle = () => new Promise(r => setImmediate(r));

  function fakeFetch() {
    requests = [];
    globalThis.fetch = async (url, opts = {}) => {
      requests.push({
        url,
        method: opts.method || 'GET',
        body: opts.body ? JSON.parse(opts.body) : undefined,
      });
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => config,
      };
    };
  }

  /** Mount the page as the router would, and wait for the first load. */
  async function mountPage() {
    dom.location.pathname = '/light/menu';
    const el = dom.document.createElement('div');
    dom.document.body.appendChild(el);
    page = new MenuPage(el, {});
    page.mount();
    await settle();
    return page;
  }

  const rows = () => [...page.container.querySelectorAll('.menu-row')];
  const q = sel => page.container.querySelector(sel);

  /** [label, url, depth] per visual row, in document order. */
  const visual = () => rows().map(r => [
    r.querySelector('.item-label').value,
    r.querySelector('.item-url').value,
    Number(r.dataset.depth),
  ]);

  const markdown = () => q('#menu-markdown-input').value;
  const savedBody = () => requests.filter(r => r.method === 'PUT').at(-1)?.body;

  /** A dataTransfer stand-in — linkedom builds no drag events of its own. */
  const transfer = () => ({ data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k]; } });

  /** Drag `from` onto `to` the way a user gripping the handle would. */
  function dragRow(from, to) {
    const src = rows()[from], dst = rows()[to];
    fire(src.querySelector('.drag-handle'), 'mousedown');
    fire(src, 'dragstart', { dataTransfer: transfer() });
    fire(dst, 'dragenter', { dataTransfer: transfer() });
    fire(dst, 'drop', { dataTransfer: transfer() });
    fire(src, 'dragend', { dataTransfer: transfer() });
  }

  beforeEach(async () => {
    dom = setupDOM();
    config = {
      mode: 'custom',
      custom_markdown: MARKDOWN,
      tag_items: [{ name: 'Travel' }, { name: 'Food' }],
      inline_max: 4,
      more_title: 'More',
    };
    fakeFetch();
    store.set('user', { username: 'owner', is_admin: true });
    store.set('settings', { blog_title: 'Test blog' });
    store.set('toast', null);
    ({ default: MenuPage } = await import('../src/plugins/nav-menu/MenuPage.js'));
  });

  afterEach(() => {
    page?.unmount();
    page = null;
    dom.cleanup();
    delete globalThis.fetch;
  });

  // ── Loading ───────────────────────────────────────────────────────────────

  describe('loading', () => {
    test('renders the stored menu as visual rows, nesting and all', async () => {
      await mountPage();
      assert.deepEqual(visual(), [
        ['Home', '/', 0],
        ['About', '/about', 0],
        ['Team', '/about/team', 1],
        ['Blog', '/blog', 0],
      ]);
    });

    test('depth is mirrored into the indent style as well as data-depth', async () => {
      await mountPage();
      assert.equal(rows()[2].style.marginLeft, '24px');
      assert.equal(rows()[0].style.marginLeft, '0px');
    });

    test('the visual editor is the default format, and only custom mode has one', async () => {
      await mountPage();
      assert.ok(q('#menu-items-list'), 'visual editor missing');
      assert.equal(q('#menu-markdown-input'), null);

      config.mode = 'tags';
      page.setState({ mode: 'tags' });
      assert.equal(q('.menu-editor-card'), null, 'tags mode must not show the editor');
    });

    test('a load failure shows an error instead of an editor', async () => {
      globalThis.fetch = async () => { throw new Error('offline'); };
      await mountPage();
      assert.match(q('.error-state').textContent, /Could not load/);
      assert.equal(q('#menu-items-list'), null);
    });
  });

  // ── Visual editor: editing a field ────────────────────────────────────────

  describe('visual editor — editing an existing item', () => {
    test('typing does not re-render the row out from under the caret', async () => {
      await mountPage();
      const input = rows()[0].querySelector('.item-label');
      type(input, 'Homepage');
      assert.equal(rows()[0].querySelector('.item-label'), input, 'row was re-rendered while typing');
      assert.equal(input.value, 'Homepage');
    });

    test('an edit survives every structural action that re-renders', async () => {
      await mountPage();
      type(rows()[1].querySelector('.item-label'), 'About Us');
      type(rows()[1].querySelector('.item-url'), '/about-us');

      click(q('#add-item-btn'));
      assert.deepEqual(visual()[1], ['About Us', '/about-us', 0], 'lost on add');

      click(rows()[0].querySelector('.indent-btn'));
      assert.deepEqual(visual()[1], ['About Us', '/about-us', 0], 'lost on indent');

      click(rows()[3].querySelector('.delete-item-btn'));
      assert.deepEqual(visual()[1], ['About Us', '/about-us', 0], 'lost on delete');
    });

    test('a row whose label is cleared keeps its place in the list', async () => {
      await mountPage();
      // Step one of retyping a label is an empty field. The row must not be
      // treated as absent, or the next click lands on the wrong item.
      type(rows()[3].querySelector('.item-label'), '');
      click(q('#add-item-btn'));

      assert.deepEqual(visual(), [
        ['Home', '/', 0],
        ['About', '/about', 0],
        ['Team', '/about/team', 1],
        ['', '/blog', 0],
        ['', '', 0],
      ]);
    });

    test('an empty row does not shift what the rows after it act on', async () => {
      await mountPage();
      type(rows()[1].querySelector('.item-label'), '');

      // Blog is the last row either way; with the empty row dropped from the
      // collected list this would indent Team, or run off the end.
      click(rows()[3].querySelector('.indent-btn'));
      assert.deepEqual(visual(), [
        ['Home', '/', 0],
        ['', '/about', 0],
        ['Team', '/about/team', 1],
        ['Blog', '/blog', 1],
      ]);

      click(rows()[0].querySelector('.delete-item-btn'));
      assert.deepEqual(visual().map(r => r[0]), ['', 'Team', 'Blog']);
    });

    test('trailing whitespace is trimmed when the row is read back', async () => {
      await mountPage();
      type(rows()[0].querySelector('.item-label'), '  Home  ');
      click(q('#add-item-btn'));
      assert.equal(visual()[0][0], 'Home');
    });
  });

  // ── Visual editor: structure ──────────────────────────────────────────────

  describe('visual editor — structure', () => {
    test('add appends one empty row at the root', async () => {
      await mountPage();
      click(q('#add-item-btn'));
      assert.equal(rows().length, 5);
      assert.deepEqual(visual()[4], ['', '', 0]);
    });

    test('delete removes the row that was clicked, not its neighbour', async () => {
      await mountPage();
      click(rows()[1].querySelector('.delete-item-btn'));
      assert.deepEqual(visual().map(r => r[0]), ['Home', 'Team', 'Blog']);
    });

    test('indent and outdent move one level and stop at the ends', async () => {
      await mountPage();
      const depth = () => visual()[0][2];

      for (let i = 0; i < 5; i++) click(rows()[0].querySelector('.indent-btn'));
      assert.equal(depth(), 3, 'indent must cap at 3');

      for (let i = 0; i < 5; i++) click(rows()[0].querySelector('.outdent-btn'));
      assert.equal(depth(), 0, 'outdent must stop at the root');
    });

    test('dragging by the handle reorders the list', async () => {
      await mountPage();
      dragRow(3, 0);
      assert.deepEqual(visual().map(r => r[0]), ['Blog', 'Home', 'About', 'Team']);
    });

    test('a drag reorder carries edits and depth with the moved row', async () => {
      await mountPage();
      type(rows()[2].querySelector('.item-label'), 'The Team');
      dragRow(2, 0);
      assert.deepEqual(visual(), [
        ['The Team', '/about/team', 1],
        ['Home', '/', 0],
        ['About', '/about', 0],
        ['Blog', '/blog', 0],
      ]);
    });

    test('dropping a row on itself changes nothing', async () => {
      await mountPage();
      dragRow(1, 1);
      assert.deepEqual(visual().map(r => r[0]), ['Home', 'About', 'Team', 'Blog']);
    });
  });

  // ── Visual editor: the drag-arming protocol ───────────────────────────────

  describe('visual editor — dragging is armed by the handle only', () => {
    test('rows are not draggable until the handle is pressed', async () => {
      await mountPage();
      // A row that is draggable at rest swallows mousedown on its inputs, and
      // the label cannot be selected or replaced with the mouse at all.
      assert.ok(rows().every(r => !r.hasAttribute('draggable')), 'a row is draggable at rest');

      fire(rows()[0].querySelector('.drag-handle'), 'mousedown');
      assert.equal(rows()[0].getAttribute('draggable'), 'true');
    });

    test('pressing an input does not arm the row', async () => {
      await mountPage();
      fire(rows()[0].querySelector('.item-label'), 'mousedown');
      fire(rows()[0].querySelector('.item-url'), 'mousedown');
      assert.ok(!rows()[0].hasAttribute('draggable'), 'editing a field armed a drag');
    });

    test('an unarmed dragstart is ignored, so no drop can reorder', async () => {
      await mountPage();
      // What a text drag out of an input looks like: dragstart bubbles up to
      // the row without the handle ever being touched.
      fire(rows()[0], 'dragstart', { dataTransfer: transfer() });
      assert.ok(!rows()[0].classList.contains('dragging'));

      fire(rows()[2], 'drop', { dataTransfer: transfer() });
      assert.deepEqual(visual().map(r => r[0]), ['Home', 'About', 'Team', 'Blog']);
    });

    test('drop cancels the default action rather than returning false', async () => {
      await mountPage();
      fire(rows()[0].querySelector('.drag-handle'), 'mousedown');
      fire(rows()[0], 'dragstart', { dataTransfer: transfer() });
      // Uncancelled, the browser pastes the dragged payload into the drop target.
      const evt = fire(rows()[2], 'drop', { dataTransfer: transfer() });
      assert.equal(evt.defaultPrevented, true);
    });

    test('a press on the handle that never becomes a drag disarms again', async () => {
      await mountPage();
      fire(rows()[0].querySelector('.drag-handle'), 'mousedown');
      // No dragstart, no dragend — just a click. The row must not stay armed,
      // or its inputs are permanently unusable.
      fire(dom.document, 'mouseup');
      assert.ok(!rows()[0].hasAttribute('draggable'), 'a click on the handle left the row armed');
    });

    test('dragend disarms every row', async () => {
      await mountPage();
      fire(rows()[0].querySelector('.drag-handle'), 'mousedown');
      fire(rows()[0], 'dragstart', { dataTransfer: transfer() });
      fire(rows()[0], 'dragend', { dataTransfer: transfer() });

      assert.ok(rows().every(r => !r.hasAttribute('draggable')), 'a row stayed armed');
      assert.ok(rows().every(r => !r.classList.contains('dragging')));
    });

    test('dragenter marks the hovered row only while a drag is live', async () => {
      await mountPage();
      fire(rows()[2], 'dragenter', { dataTransfer: transfer() });
      assert.ok(!rows()[2].classList.contains('drag-over'), 'highlighted without a drag');

      fire(rows()[0].querySelector('.drag-handle'), 'mousedown');
      fire(rows()[0], 'dragstart', { dataTransfer: transfer() });
      fire(rows()[2], 'dragenter', { dataTransfer: transfer() });
      assert.ok(rows()[2].classList.contains('drag-over'));

      fire(rows()[2], 'dragleave', { dataTransfer: transfer() });
      assert.ok(!rows()[2].classList.contains('drag-over'));
    });
  });

  // ── Markdown editor ───────────────────────────────────────────────────────

  describe('markdown editor', () => {
    const toMarkdown = () => click(q('#mode-markdown-btn'));
    const toVisual = () => click(q('#mode-visual-btn'));

    test('switching to markdown serialises exactly what the rows hold', async () => {
      await mountPage();
      toMarkdown();
      assert.equal(markdown(), MARKDOWN);
    });

    test('the switch carries unsaved visual edits into the text', async () => {
      await mountPage();
      type(rows()[0].querySelector('.item-label'), 'Homepage');
      type(rows()[0].querySelector('.item-url'), '/home');
      toMarkdown();
      assert.match(markdown(), /^- \[Homepage\]\(\/home\)$/m);
    });

    test('an unnamed row has no markdown spelling and is left out', async () => {
      await mountPage();
      click(q('#add-item-btn'));
      toMarkdown();
      // A bare `- ` or `- [](url)` does not parse back to the same item.
      assert.equal(markdown(), MARKDOWN);
      assert.ok(!markdown().includes('[]'));
    });

    test('switching back parses the text into rows', async () => {
      await mountPage();
      toMarkdown();
      q('#menu-markdown-input').value = [
        '- [Docs](/docs)',
        '  - [API](/docs/api)',
        '    - [Auth](/docs/api/auth)',
        '- Section',
      ].join('\n');
      toVisual();

      assert.deepEqual(visual(), [
        ['Docs', '/docs', 0],
        ['API', '/docs/api', 1],
        ['Auth', '/docs/api/auth', 2],
        ['Section', '', 0],
      ]);
    });

    test('a label with no link is a group header', async () => {
      await mountPage();
      toMarkdown();
      q('#menu-markdown-input').value = '- Reference\n  - [Guide](/guide)';
      toVisual();
      assert.deepEqual(visual()[0], ['Reference', '', 0]);
    });

    test('blank lines and non-list text are skipped', async () => {
      await mountPage();
      toMarkdown();
      q('#menu-markdown-input').value = '\n- [A](/a)\n\nnot a list item\n   \n- [B](/b)\n';
      toVisual();
      assert.deepEqual(visual().map(r => r[0]), ['A', 'B']);
    });

    test('a link with an empty target keeps its label', async () => {
      await mountPage();
      toMarkdown();
      q('#menu-markdown-input').value = '- [Placeholder]()';
      toVisual();
      assert.deepEqual(visual(), [['Placeholder', '', 0]]);
    });

    test('two switches in a row are a no-op, not a re-parse', async () => {
      await mountPage();
      toMarkdown();
      const first = markdown();
      toMarkdown();
      assert.equal(markdown(), first);
    });

    test('a full round trip through both editors preserves the menu', async () => {
      await mountPage();
      const before = visual();
      click(q('#mode-markdown-btn'));
      click(q('#mode-visual-btn'));
      assert.deepEqual(visual(), before);
    });
  });

  // ── Saving, from either format ────────────────────────────────────────────

  describe('saving', () => {
    test('the visual editor saves a tree plus the markdown that made it', async () => {
      await mountPage();
      click(q('#save-menu-btn'));
      await settle();

      assert.deepEqual(savedBody(), {
        mode: 'custom',
        custom_markdown: MARKDOWN,
        items: [
          { name: 'Home', url: '/', children: [] },
          {
            name: 'About', url: '/about',
            children: [{ name: 'Team', url: '/about/team', children: [] }],
          },
          { name: 'Blog', url: '/blog', children: [] },
        ],
        inline_max: 4,
        more_title: 'More',
      });
    });

    test('unsaved field edits are what gets sent', async () => {
      await mountPage();
      type(rows()[0].querySelector('.item-label'), 'Homepage');
      click(q('#save-menu-btn'));
      await settle();
      assert.equal(savedBody().items[0].name, 'Homepage');
      assert.match(savedBody().custom_markdown, /^- \[Homepage\]\(\/\)$/m);
    });

    test('rows left unnamed are dropped from the payload', async () => {
      await mountPage();
      click(q('#add-item-btn'));
      type(rows()[4].querySelector('.item-url'), '/orphan');
      click(q('#save-menu-btn'));
      await settle();

      assert.equal(savedBody().items.length, 3);
      assert.ok(!savedBody().custom_markdown.includes('/orphan'));
    });

    test('a closed branch does not adopt a later deeper item', async () => {
      await mountPage();
      click(q('#mode-markdown-btn'));
      // Support > FAQ closes when Legal starts; Terms belongs to Legal.
      q('#menu-markdown-input').value = [
        '- [Support](/support)',
        '  - [FAQ](/faq)',
        '- [Legal](/legal)',
        '    - [Terms](/terms)',
      ].join('\n');
      click(q('#save-menu-btn'));
      await settle();

      const [support, legal] = savedBody().items;
      assert.deepEqual(support.children.map(c => c.name), ['FAQ']);
      assert.deepEqual(legal.children.map(c => c.name), ['Terms']);
    });

    test('an item indented with no parent above it becomes a root', async () => {
      await mountPage();
      click(q('#mode-markdown-btn'));
      q('#menu-markdown-input').value = '  - [Orphan](/orphan)\n- [Root](/root)';
      click(q('#save-menu-btn'));
      await settle();
      assert.deepEqual(savedBody().items.map(i => i.name), ['Orphan', 'Root']);
    });

    test('the markdown editor saves what its text says', async () => {
      await mountPage();
      click(q('#mode-markdown-btn'));
      q('#menu-markdown-input').value = '- [Only](/only)';
      click(q('#save-menu-btn'));
      await settle();

      assert.equal(savedBody().custom_markdown, '- [Only](/only)');
      assert.deepEqual(savedBody().items, [{ name: 'Only', url: '/only', children: [] }]);
    });

    test('tags and none modes send no custom menu at all', async () => {
      await mountPage();
      for (const mode of ['tags', 'none']) {
        page.setState({ mode });
        click(q('#save-menu-btn'));
        await settle();
        assert.equal(savedBody().mode, mode);
        assert.equal(savedBody().custom_markdown, '');
        assert.deepEqual(savedBody().items, []);
      }
    });

    test('the slot cap and More title are clamped and saved', async () => {
      await mountPage();
      const cap = q('#inline-max-input');

      cap.value = '11';
      fire(cap, 'change');
      assert.equal(cap.value, '4', 'an out-of-range cap must snap back');

      cap.value = '6';
      fire(cap, 'change');
      type(q('#more-title-input'), 'Others');

      click(q('#save-menu-btn'));
      await settle();
      assert.equal(savedBody().inline_max, 6);
      assert.equal(savedBody().more_title, 'Others');
    });

    test('a successful save publishes the new nav to the rest of the app', async () => {
      await mountPage();
      let navChanged = 0;
      dom.document.addEventListener('nav-changed', () => { navChanged++; });

      click(q('#save-menu-btn'));
      await settle();

      assert.equal(navChanged, 1);
      assert.equal(store.get('settings').nav_menu_mode, 'custom');
      assert.equal(store.get('settings').nav_inline_max, '4');
      assert.equal(store.get('toast').type, 'success');
    });

    test('a failed save reports it and leaves the button usable', async () => {
      await mountPage();
      globalThis.fetch = async () => { throw new Error('nope'); };
      click(q('#save-menu-btn'));
      await settle();

      assert.equal(store.get('toast').type, 'error');
      assert.ok(!q('#save-menu-btn').disabled, 'save stayed disabled after a failure');
    });
  });

  // ── Preview ───────────────────────────────────────────────────────────────

  describe('preview', () => {
    test('it shows the top-level items of the format being edited', async () => {
      await mountPage();
      assert.deepEqual(page._previewItems().map(i => i.name), ['Home', 'About', 'Blog']);

      click(q('#mode-markdown-btn'));
      q('#menu-markdown-input').value = '- [One](/1)\n  - [Deep](/2)\n- [Two](/3)';
      assert.deepEqual(page._previewItems().map(i => i.name), ['One', 'Two']);
    });

    test('unnamed rows are not previewed', async () => {
      await mountPage();
      click(q('#add-item-btn'));
      assert.deepEqual(page._previewItems().map(i => i.name), ['Home', 'About', 'Blog']);
    });

    test('tags mode previews the tag tree, and none previews nothing', async () => {
      await mountPage();
      page.setState({ mode: 'tags' });
      assert.deepEqual(page._previewItems().map(i => i.name), ['Travel', 'Food']);

      page.setState({ mode: 'none' });
      assert.deepEqual(page._previewItems(), []);
    });

    test('the fold controllers are torn down on re-render and unmount', async () => {
      await mountPage();
      assert.ok(page._previewFolds.length > 0, 'no preview folds were created');
      const first = page._previewFolds.slice();

      page.setState({ mode: 'custom' });
      assert.ok(first.every(f => f._providers.length === 0), 'a fold survived a re-render');

      page.unmount();
      assert.equal(page._previewFolds.length, 0);
      page = null;
    });
  });
});
