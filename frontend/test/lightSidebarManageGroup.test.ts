import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';
import { must } from './helpers/dom.ts';
import { mock } from './helpers/mock.ts';
import type { LightSidebar as LightSidebarClass } from '../src/components/light/LightSidebar.ts';

/**
 * The sidebar's Manage group.
 *
 * The group used to be forced open whenever the current page was one of its
 * items (`state.manageExpanded || isManageActive`), which made the toggle dead
 * on exactly the pages you are on when you reach for it: on /light/plugins it
 * flipped the stored flag and nothing moved. The route now only supplies the
 * *default* for a sidebar that has never been toggled; once toggled, the toggle
 * is the answer everywhere.
 */

let LightSidebar: typeof LightSidebarClass;
let prefs: Map<string, string>;

/** Render at `path` with the given stored preference (null = never toggled). */
function renderAt(path: string, stored: string | null) {
  prefs.clear();
  if (stored !== null) prefs.set('sidebar_manage_expanded', stored);
  const sidebar = new LightSidebar(mock<HTMLElement>({}), { currentPath: path });
  // render() returns the RawHtml html`` produces; String() for the assertions.
  return { html: String(sidebar.render()), sidebar };
}

/** The class list of the Manage group in a rendered sidebar. */
const groupClasses = (html: string) =>
  must(html.match(/class="nav-group ([^"]*)" id="manage-group"/), 'manage group')[1];

describe('LightSidebar Manage group', () => {
  before(async () => {
    prefs = new Map();
    global.localStorage = mock<Storage>({
      getItem: (k) => prefs.get(k) ?? null,
      setItem: (k, v) => { prefs.set(k, String(v)); },
      removeItem: (k) => { prefs.delete(k); },
    });
    global.window = mock<typeof window>({
      location: mock<Location>({ pathname: '', search: '', hostname: 'localhost' }),
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => mock<MediaQueryList>({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
    global.document = mock<Document>({
      documentElement: mock<HTMLElement>({ classList: mock<DOMTokenList>({ contains: () => false }) }),
      querySelector: () => null,
      querySelectorAll: () => mock<NodeListOf<Element>>({ length: 0, forEach() {}, [Symbol.iterator]: [][Symbol.iterator] }),
      addEventListener: () => {},
    });
    ({ LightSidebar } = await import('../src/components/light/LightSidebar.ts'));
  });

  beforeEach(() => prefs.clear());

  test('untoggled: opens on a Manage page, stays shut elsewhere', () => {
    assert.match(groupClasses(renderAt('/light/plugins', null).html), /is-expanded/);
    assert.match(groupClasses(renderAt('/light/posts', null).html), /is-collapsed/);
  });

  test('collapsing sticks on the very page the group holds', () => {
    const { html } = renderAt('/light/plugins', 'false');
    assert.match(groupClasses(html), /is-collapsed/);
    assert.match(html, /aria-expanded="false"/);
  });

  test('expanding sticks away from the group too', () => {
    assert.match(groupClasses(renderAt('/light/posts', 'true').html), /is-expanded/);
  });

  test('a collapsed group still marks that it holds the current page', () => {
    assert.match(groupClasses(renderAt('/light/settings', 'false').html), /has-active/);
    assert.doesNotMatch(groupClasses(renderAt('/light/posts', 'false').html), /has-active/);
  });

  test('the first click on an untoggled sidebar moves it, whatever the page', () => {
    // What the click handler flips: the state shown, not the stored null.
    const cases: [string, boolean][] = [['/light/plugins', true], ['/light/posts', false]];
    for (const [path, shown] of cases) {
      const { sidebar } = renderAt(path, null);
      assert.equal(sidebar.state.manageExpanded ?? sidebar._manageActive, shown);
      assert.equal(!(sidebar.state.manageExpanded ?? sidebar._manageActive), !shown);
    }
  });
});
