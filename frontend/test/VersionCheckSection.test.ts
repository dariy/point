import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { mock } from './helpers/mock.ts';

type VersionInfo = Awaited<ReturnType<typeof import('../src/api/system.ts').getVersion>>;

describe('VersionCheckSection', () => {
  let VersionCheckSection: typeof import('../src/components/light/sections/VersionCheckSection.ts').VersionCheckSection;

  before(async () => {
    globalThis.document = mock<Document>({
      createElement: () => mock<HTMLElement>({
        style: mock<CSSStyleDeclaration>({}),
        classList: mock<DOMTokenList>({ add: () => {}, remove: () => {} }),
        addEventListener: () => {},
        removeEventListener: () => {}
      }),
      body: mock<HTMLElement>({ appendChild: <T extends Node>(n: T) => n }),
      addEventListener: () => {},
      removeEventListener: () => {}
    });
    globalThis.window = mock<typeof window>({
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true
    });
    const mod = await import('../src/components/light/sections/VersionCheckSection.ts');
    VersionCheckSection = mod.VersionCheckSection;
  });

  function sectionWith(info: VersionInfo, extra = {}) {
    const container = mock<HTMLElement>({ querySelector: () => null });
    const section = new VersionCheckSection(container);
    section.state = { ...section.state, loading: false, info, ...extra };
    return section.render();
  }

  // The verdict line is the whole point of the block: an admin must be able to
  // tell a failed check apart from "nothing new".
  test('reports a failed check verbatim instead of claiming you are up to date', () => {
    const html = sectionWith({
      current: 'v0.1.42',
      latest: 'v0.1.42',
      update_available: false,
      fetched: false,
      error: 'GitHub API returned 403'
    });

    assert.ok(html.includes('GitHub API returned 403'), 'upstream error should be shown');
    assert.ok(!html.includes("running the latest release"), 'must not claim up-to-date after a failure');
  });

  test('announces an available update', () => {
    const html = sectionWith({
      current: 'v0.1.42',
      latest: 'v0.1.43',
      update_available: true,
      fetched: true
    });

    assert.ok(html.includes('v0.1.43'), 'the newer version should be named');
    assert.ok(html.includes('./update.sh'), 'the update command should be shown');
  });

  // An install that has never reached GitHub must say so rather than render an
  // empty "latest" that reads as "no update available".
  test('distinguishes "never checked" from "up to date"', () => {
    const html = sectionWith({ current: 'v0.1.42', latest: '', update_available: false, fetched: false });

    assert.ok(html.includes('never'), 'last checked should read as never');
    assert.ok(html.includes('No upstream version known yet'), 'verdict should ask for a check');
    assert.ok(!html.includes("running the latest release"), 'must not claim up-to-date without an answer');
  });

  test('confirms a live round-trip right after a manual check', () => {
    const html = sectionWith(
      { current: 'v0.1.43', latest: 'v0.1.43', update_available: false, fetched: true, checked_at: '2026-08-01T10:00:00Z' },
      { justChecked: true }
    );

    assert.ok(html.includes('running the latest release'), 'verdict should be up to date');
    assert.ok(html.includes('from GitHub just now'), 'a forced check should say it reached GitHub');
  });

  test('does not claim a live round-trip when answering from cache', () => {
    const html = sectionWith({
      current: 'v0.1.43',
      latest: 'v0.1.43',
      update_available: false,
      fetched: false,
      checked_at: '2026-08-01T10:00:00Z'
    });

    assert.ok(html.includes('running the latest release'), 'verdict should be up to date');
    assert.ok(!html.includes('from GitHub just now'), 'cached answers must not be presented as fresh');
  });
});
