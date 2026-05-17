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
 * Security contract for subclasses:
 *   - escapeHtml() MUST wrap every user-supplied string inside render().
 *   - Dynamic text nodes should be set via element.textContent in afterRender(),
 *     not interpolated into the HTML string.
 *   - Only server-generated HTML (post body, already sanitized server-side)
 *     may be rendered as-is.
 *   - URL attributes must start with '/' or 'https://' only.
 */

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
    /** @type {Function[]} */
    this._storeUnsubs = [];
    this._unmounted = false;
  }

  // ── Subclass interface ────────────────────────────────────────────────────

  /**
   * Return an HTML string describing this component.
   * Must be overridden. All user-provided values MUST be wrapped in escapeHtml().
   * @returns {string}
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
   * Override to cancel timers or unsubscribe from the store.
   */
  beforeUnmount() {}

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Merge delta into state and re-render.
   * @param {object} delta
   */
  setState(delta) {
    if (this._unmounted) return;
    this.state = { ...this.state, ...delta };
    this._rerender();
  }

  /**
   * Merge delta into props and re-render.
   * @param {object} delta
   */
  setProps(delta) {
    if (this._unmounted) return;
    this.props = { ...this.props, ...delta };
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
    this._storeUnsubs.forEach((fn) => fn());
    this._storeUnsubs = [];
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
    const el =
      typeof target === 'string' ? this.container.querySelector(target) : target;
    if (!el) {
      throw new Error(`${this.constructor.name}.mountChild: target "${target}" not found`);
    }
    const child = new Cls(el, props);
    child.mount();
    this._children.push(child);
    return child;
  }

  /**
   * Subscribe to a store key, auto-unsubscribed on unmount.
   * @param {object} storeInstance
   * @param {string} key
   * @param {Function} callback
   */
  subscribeStore(storeInstance, key, callback) {
    const unsub = storeInstance.subscribe(key, callback);
    this._storeUnsubs.push(unsub);
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
    this._unmountChildren();
    this._children = [];
    // render() returns an HTML string. Subclasses must escape all user-supplied
    // values with escapeHtml(). Server-generated HTML (e.g. post content_html)
    // is sanitized server-side before storage and is safe to render directly.
    const markup = this.render();
    this.container.innerHTML = markup;
    this.afterRender();
  }

  _unmountChildren() {
    this._children.forEach((c) => c.unmount());
    this._children = [];
  }
}
