/**
 * Component.render() — the escape-by-default contract.
 *
 * render() is expected to build its markup with the html`` tag and return what
 * that tag returns, so every interpolation is escaped (safeUrl() in href/src
 * position, escapeHtml() elsewhere) without the subclass doing anything. The
 * base class used to say the opposite: it wrapped whatever render() returned in
 * raw() and left escaping to a comment in its own docstring.
 *
 * Sixty-three render() methods cannot flip in one commit, so a plain string is
 * still adopted verbatim while the migration runs. These tests hold both ends —
 * that html`` output survives untouched, and that the legacy string path still
 * works — so the strict flip has something to break when it removes the second.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';

import { setupDOM } from './helpers/dom.js';
import { Component } from '../src/components/Component.js';
import { html, raw } from '../src/utils/helpers.js';
import { renderTagStrip } from '../src/utils/tagStrip.js';
import { thumbAttrs } from '../src/utils/mediaUrl.js';

describe('Component.render() markup contract', () => {
  let dom;
  let host;

  beforeEach(() => {
    dom = setupDOM();
    host = document.createElement('div');
    document.body.appendChild(host);
  });
  afterEach(() => { dom.cleanup(); });

  /** Mount a component whose render() is `fn`, and hand back its container. */
  const mount = (fn) => {
    class Ad extends Component { render() { return fn.call(this); } }
    new Ad(host, {}).mount();
    return host;
  };

  test('html`` output reaches the DOM as markup, not as text', () => {
    const el = mount(() => html`<p class="hit">ok</p>`);
    assert.strictEqual(el.querySelector('p.hit')?.textContent, 'ok');
  });

  test('a hostile value interpolated by render() cannot open a tag', () => {
    const el = mount(() => html`<p>${'<img src=x onerror=alert(1)>'}</p>`);
    assert.strictEqual(el.querySelectorAll('img').length, 0);
    assert.strictEqual(el.querySelector('p').textContent, '<img src=x onerror=alert(1)>');
  });

  test('a hostile href interpolated by render() is dropped by safeUrl', () => {
    const el = mount(() => html`<a href="${'javascript:alert(1)'}">go</a>`);
    assert.strictEqual(el.querySelector('a').getAttribute('href'), '#');
  });

  test('raw() still opts a trusted constant out, as the SVG blobs need', () => {
    const el = mount(() => html`<span>${raw('<b class="svg">x</b>')}</span>`);
    assert.strictEqual(el.querySelector('b.svg')?.textContent, 'x');
  });

  test('an unmigrated render() returning a plain string is still adopted', () => {
    // The escape hatch. When this stops passing, every render() has moved and
    // adoptLegacyMarkup() can go with it.
    const el = mount(() => '<p class="legacy">hand-escaped</p>');
    assert.strictEqual(el.querySelector('p.legacy')?.textContent, 'hand-escaped');
  });

  test('a markup helper with nothing to render returns something falsy', () => {
    // html`` yields a String OBJECT, so an empty one is truthy — and callers
    // gate a wrapper on the fragment: `frag ? html`<div>${frag}</div>` : ''`.
    // Returning html`` from the empty branch emitted the empty wrapper.
    const wrap = (frag) => String(frag ? html`<div class="w">${frag}</div>` : '');
    assert.strictEqual(wrap(renderTagStrip([])), '');
    assert.strictEqual(wrap(renderTagStrip([{ name: 'a', slug: 'a', inherited: true }])), '');
    assert.strictEqual(wrap(thumbAttrs('')), '');
    assert.match(wrap(renderTagStrip([{ name: 'a', slug: 'a' }])), /^<div class="w">/);
  });

  test('an empty render() leaves the container empty either way', () => {
    assert.strictEqual(mount(() => html``).innerHTML, '');
    host.innerHTML = '';
    assert.strictEqual(mount(() => '').innerHTML, '');
  });
});
