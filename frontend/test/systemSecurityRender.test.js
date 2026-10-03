/**
 * SecurityPage and SystemPage render fields that the API sends.
 *
 * The --strict pass (p-3cfv.8) found two fields the server never sends:
 * SecurityPage read session.last_active (the API sends last_active_at), and
 * SystemPage printed disk.path (DiskInfo has no path). These tests keep the
 * markup tied to the API shape.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';

function markupOf(PageClass, state) {
  const page = new PageClass(document.createElement('div'), {});
  Object.assign(page.state, state);
  return String(page.render());
}

describe('API fields in page markup', () => {
  let dom;
  let SecurityPage;
  let SystemPage;

  before(async () => {
    dom = setupDOM();
    SecurityPage = (await import('../src/pages/light/SecurityPage.ts')).default;
    SystemPage = (await import('../src/pages/light/SystemPage.ts')).default;
  });

  after(() => { dom.cleanup(); });

  test('SecurityPage shows the last_active_at date of a session', () => {
    const markup = markupOf(SecurityPage, {
      loading: false,
      sessions: [{
        id: 7, ip_address: '', user_agent: '', ua_browser: 'Firefox', ua_os: 'Linux',
        created_at: '2026-01-01T00:00:00Z', last_active_at: '2026-03-15T12:00:00Z',
        expires_at: '2026-04-01T00:00:00Z', is_current: false,
      }],
    });
    assert.match(markup, /2026/, 'the Last Active cell should contain the date');
  });

  test('SystemPage disk section has no empty Path line', () => {
    const page = new SystemPage(document.createElement('div'), {});
    const markup = String(page._renderDiskSection({ total: 100, free: 40, used: 60 }));
    assert.match(markup, /60%/);
    assert.doesNotMatch(markup, /Path:/);
  });
});
