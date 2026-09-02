/**
 * Every password form names an account.
 *
 * Point signs its single owner in with a password and no username, so its
 * password forms used to contain a password box and nothing else. Chrome logs
 * "[DOM] Password forms should have (optionally hidden) username fields for
 * accessibility" over exactly that shape, and a password manager given a
 * password with no account beside it cannot tell the credential it saved at
 * sign-in from the one it saved after a password change.
 *
 * usernameHintField() is the answer, and this test is what keeps the next
 * password form from forgetting it: it renders each page for real and walks the
 * forms, rather than trusting that the helper is still called.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { OWNER_USERNAME } from '../src/utils/passwordForm.js';

/** Render a page component and hand back its markup as a string. */
function markupOf(PageClass, props = {}, state = null) {
  const container = document.createElement('div');
  const page = new PageClass(container, props);
  if (state) Object.assign(page.state, state);
  return String(page.render());
}

/** The <form> elements in some markup, parsed. */
function formsIn(markup) {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return Array.from(host.querySelectorAll('form'));
}

describe('password forms', () => {
  let dom;
  let pages;

  before(async () => {
    dom = setupDOM();
    const [login, security, reset] = await Promise.all([
      import('../src/pages/light/LoginPage.js'),
      import('../src/pages/light/SecurityPage.js'),
      import('../src/pages/light/PasswordResetPage.js'),
    ]);
    pages = [
      ['LoginPage', () => markupOf(login.default)],
      ['SecurityPage', () => markupOf(security.default, {}, { loading: false, sessions: [] })],
      ['PasswordResetPage', () => markupOf(reset.default, { params: { token: 'tok' } })],
    ];
  });

  after(() => { dom.cleanup(); });

  test('each one carries a username field', () => {
    for (const [name, render] of pages) {
      const forms = formsIn(render());
      const withPassword = forms.filter(f => f.querySelector('input[type="password"]'));
      assert.ok(withPassword.length > 0, `${name} should render a password form`);

      for (const form of withPassword) {
        const username = form.querySelector('input[autocomplete="username"]');
        assert.ok(username, `${name}: form#${form.id} has a password box and no username field`);
        assert.equal(username.getAttribute('value'), OWNER_USERNAME,
          `${name}: form#${form.id} names an account other than the owner`);
      }
    }
  });

  test('the username field is hidden, and out of the way', () => {
    for (const [name, render] of pages) {
      for (const field of formsIn(render()).flatMap(f => Array.from(f.querySelectorAll('input[autocomplete="username"]')))) {
        assert.ok(field.hasAttribute('hidden'), `${name}: the username field should be hidden`);
        assert.ok(field.hasAttribute('readonly'), `${name}: the username field should be readonly`);
      }
    }
  });

  test('password boxes say which password they want', () => {
    // A manager only offers to update a saved credential when the new-password
    // boxes are labelled as such; the reset form used to say autocomplete="off".
    for (const [name, render] of pages) {
      for (const box of formsIn(render()).flatMap(f => Array.from(f.querySelectorAll('input[type="password"]')))) {
        const kind = box.getAttribute('autocomplete');
        assert.ok(kind === 'current-password' || kind === 'new-password',
          `${name}: password box #${box.id} declares autocomplete="${kind}"`);
      }
    }
  });
});
