import { html, isRawHtml, raw } from '../utils/helpers.js';

/**
 * Base Component class.
 *
 * Every UI element in the application inherits from Component. The class
 * manages the relationship between a component and the real DOM node it owns.
 *
 * Lifecycle:
 *   new Component(container, props)
 *     -> mount()          calls render() then afterRender()
 *     -> setState(delta)  merges state and re-renders
 *     -> setProps(delta)  merges props and re-renders
 *     -> unmount()        beforeUnmount() then container cleared
 *
 * Resource contract:
 *   afterRender() runs again on every re-render, so anything it acquires —
 *   an observer, a store subscription, a listener on document/window, a node
 *   appended outside the container — must be released before the next one
 *   runs, or it accumulates once per setState() for the life of the page.
 *   registerCleanup() is that release: the list is drained before each
 *   re-render and again on unmount, so a resource acquired in afterRender()
 *   lives exactly as long as the render that acquired it. subscribeStore()
 *   and mountChild() are built on it; reach for it directly for everything
 *   else. Guarding an acquisition with a "have I done this already?" flag is
 *   the wrong fix and now an actively broken one — the flag survives the
 *   cleanup that released the resource, so the second render gets neither.
 *
 * Security contract for subclasses:
 *   - render() builds its markup with the html`` tag from utils/helpers.js and
 *     returns what that tag returns. Interpolations are escaped by the tag —
 *     with safeUrl() in href/src position, escapeHtml() everywhere else — so a
 *     subclass never applies either by hand and never forgets to.
 *   - raw() opts a value out of that. It belongs around module-level constants
 *     (the SVG blobs in utils/icons.js) and around HTML the server sanitized
 *     before storing it (a post body). Nothing else.
 *   - Dynamic text nodes can still be set via element.textContent in
 *     afterRender(); that stays the simplest safe option for a lone string.
 */

/**
 * The migration escape hatch: adopt a render() result that is still a plain
 * string, built the old way with hand-applied escapeHtml() calls.
 *
 * Sixty-three render() methods cannot flip in one commit, so plain strings keep
 * working — but only through here, so the trust is stated in one place instead
 * of being implied by every subclass. What is left to migrate is what still
 * escapes by hand:
 *
 *   grep -rn 'escapeHtml(' frontend/src --include='*.js'
 *
 * Do not add callers. This function disappears with the strict flip, which
 * turns a plain string from render() into an error.
 *
 * @param {unknown} markup
 * @returns {import('../utils/helpers.js').RawHtml}
 */
function adoptLegacyMarkup(markup) {
  return raw(markup);
}

export class Component {
  /**
   * @param {HTMLElement} container  The DOM node this component renders into
   * @param {object}      [props]    Initial properties
   */
  constructor(container, props = {}) {
    this.container = container;
    this.props = props;
    this.state = {};
    /** @type {Component[]} */
    this._children = [];
    /**
     * Teardowns for resources acquired by the current render. Drained before
     * every re-render and on unmount.
     * @type {Function[]}
     */
    this._cleanups = [];
    this._unmounted = false;
  }

  // ── Subclass interface ────────────────────────────────────────────────────

  /**
   * Return the markup describing this component, built with the html`` tag.
   * Must be overridden.
   * @returns {import('../utils/helpers.js').RawHtml|string} html`` output; a
   *   plain string is still accepted while the migration to html`` runs.
   */
  render() {
    throw new Error(`${this.constructor.name}.render() not implemented`);
  }

  /**
   * Called after HTML is written to the DOM.
   * Override to attach event listeners or mount child components.
   * Prefer element.textContent for setting dynamic text (safe by default).
   */
  afterRender() {}

  /**
   * Called just before this component is removed from the DOM.
   * Override to release things that outlive a single render — a poll timer
   * started in the constructor, say. Anything acquired in afterRender()
   * belongs in registerCleanup() instead, which also runs between renders.
   */
  beforeUnmount() {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Merge delta into state and re-render.
   * @param {object} delta
   */
  setState(delta) {
    if (this._unmounted) return;
    this.state = {
      ...this.state,
      ...delta
    };
    this._rerender();
  }

  /**
   * Merge delta into props and re-render.
   * @param {object} delta
   */
  setProps(delta) {
    if (this._unmounted) return;
    this.props = {
      ...this.props,
      ...delta
    };
    this._rerender();
  }

  /**
   * Perform the initial render. Call this once after construction.
   */
  mount() {
    this._rerender();
  }

  /**
   * Tear down: call beforeUnmount, unmount children, clear the container.
   */
  unmount() {
    this._unmounted = true;
    this._runCleanups();
    this._unmountChildren();
    this.beforeUnmount();
    this.container.textContent = '';
  }

  // ── Helpers for subclasses ────────────────────────────────────────────────

  /**
   * Mount a child Component inside this component's DOM subtree.
   * Automatically cleaned up when this component re-renders or unmounts.
   *
   * @param {typeof Component} Cls   Component class to instantiate
   * @param {string|HTMLElement} target  Selector or element inside this.container
   * @param {object} [props]
   * @returns {Component}
   */
  mountChild(Cls, target, props = {}) {
    const el = typeof target === 'string' ? this.container.querySelector(target) : target;
    if (!el) {
      throw new Error(`${this.constructor.name}.mountChild: target "${target}" not found`);
    }
    const child = new Cls(el, props);
    child.mount();
    this._children.push(child);
    return child;
  }

  /**
   * Register a teardown for a resource acquired by the current render.
   *
   * Called before the next re-render and again on unmount, whichever comes
   * first, then forgotten — so afterRender() re-registers on every pass and
   * needs no guard. Safe to call from anywhere the component is alive; a
   * cleanup registered outside afterRender() simply lives until the next
   * render boundary like any other.
   *
   * @param {Function} [fn]  Teardown; ignored when not a function, so the
   *                         return value of a setup helper can be passed
   *                         straight through.
   */
  registerCleanup(fn) {
    if (typeof fn === 'function') this._cleanups.push(fn);
  }

  /**
   * Subscribe to a store key for the lifetime of the current render.
   * @param {object} storeInstance
   * @param {string} key
   * @param {Function} callback
   */
  subscribeStore(storeInstance, key, callback) {
    this.registerCleanup(storeInstance.subscribe(key, callback));
  }

  /**
   * Query selector scoped to this component's container.
   * @param {string} selector
   * @returns {HTMLElement|null}
   */
  $(selector) {
    return this.container.querySelector(selector);
  }

  /**
   * Query all within this component's container.
   * @param {string} selector
   * @returns {NodeList}
   */
  $$(selector) {
    return this.container.querySelectorAll(selector);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _rerender() {
    // Release what the previous render acquired, while its DOM is still in
    // place: registered teardowns first, then the imperative hook.
    this._runCleanups();
    // Optional hook called before every re-render including the first.
    // Override in subclasses to release resources (timers, observers, DOM nodes
    // appended outside the container) before the container is replaced.
    // Unlike beforeUnmount() this also runs on setState() / setProps() calls.
    this.beforeRender?.();
    this._unmountChildren();
    this._children = [];
    const markup = this.render();
    // html`` already escaped every interpolation in there, so the result goes
    // in untouched. A render() that has not been migrated yet returns a plain
    // string instead, and adoptLegacyMarkup() is the one place that is trusted.
    this.container.innerHTML = html`${isRawHtml(markup) ? markup : adoptLegacyMarkup(markup)}`;
    this.afterRender();
  }
  _unmountChildren() {
    this._children.forEach(c => c.unmount());
    this._children = [];
  }

  /**
   * Drain the cleanup list. Cleared first so a teardown that re-renders (or
   * registers something new) cannot run the same entry twice, and one that
   * throws cannot strand the ones behind it — a leaked resource is exactly
   * what this list exists to prevent.
   */
  _runCleanups() {
    const fns = this._cleanups;
    this._cleanups = [];
    for (const fn of fns) {
      try {
        fn();
      } catch (err) {
        console.error(`${this.constructor.name}: cleanup failed`, err);
      }
    }
  }
}