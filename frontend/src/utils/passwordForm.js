/**
 * The username field every password form needs, even the ones with no username.
 *
 * Point is a single-owner blog: sign-in asks for a password and nothing else,
 * and the change-password and password-reset forms ask only for passwords too.
 * Chrome logs "[DOM] Password forms should have (optionally hidden) username
 * fields for accessibility" over each of them, and a password manager handed a
 * password with no account beside it has nothing to key a saved credential on —
 * the entry it writes on sign-in and the one it writes after a password change
 * do not recognise each other.
 *
 * The fix is a hidden field naming the account. Every form uses the same
 * constant so all of them describe one credential; the value is what the login
 * endpoint calls the owner, and no form actually submits it (each one is
 * handled in JS and sends only what its API expects).
 */

import { html } from './helpers.js';

/**
 * The single account this blog has. Written by the setup wizard
 * (`api/internal/api/setup.go`), and what `/api/auth/login` matches when a
 * request omits `username` — which the sign-in form always does.
 */
export const OWNER_USERNAME = 'the_owner';

/**
 * A hidden `autocomplete="username"` input to place inside a password form.
 *
 * `hidden` rather than off-screen on purpose: password managers read hidden
 * username fields (that is what "optionally hidden" in the warning means), and
 * a field with nothing for the reader to do in it should not be in the tab
 * order or the accessibility tree.
 *
 * @returns {import('./helpers.js').RawHtml}
 */
export function usernameHintField() {
  return html`<input type="text" name="username" value="${OWNER_USERNAME}"
                     autocomplete="username" readonly hidden>`;
}
