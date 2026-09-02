import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert';

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

let LightSidebar;
let prefs;

/** Render at `path` with the given stored preference (null = never toggled). */
function renderAt(path, stored) {
  prefs.clear();
  if (stored !== null) prefs.set('sidebar_manage_expanded', stored);
  const sidebar = new LightSidebar({}, { currentPath: path });
  // render() returns the RawHtml html`` produces; String() for the assertions.
  return { html: String(sidebar.render()), sidebar };
}

/** The class list of the Manage group in a rendered sidebar. */
const groupClasses = (html) => html.match(/class="nav-group ([^"]*)" id="manage-group"/)[1];

describe('LightSidebar Manage group', () => {
  before(async () => {
    prefs = new Map();
    global.localStorage = {
      getItem: (k) => (prefs.has(k) ? prefs.get(k) : null),
      setItem: (k, v) => prefs.set(k, String(v)),
      removeItem: (k) => prefs.delete(k),
    };
    global.window = {
      location: { pathname: '', search: '', hostname: 'localhost' },
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    };
    global.document = {
      documentElement: { classList: { contains: () => false } },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
    };
    ({ LightSidebar } = await import('../src/components/light/LightSidebar.js'));
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
    for (const [path, shown] of [['/light/plugins', true], ['/light/posts', false]]) {
      const { sidebar } = renderAt(path, null);
      assert.equal(sidebar.state.manageExpanded ?? sidebar._manageActive, shown);
      assert.equal(!(sidebar.state.manageExpanded ?? sidebar._manageActive), !shown);
    }
  });
});
