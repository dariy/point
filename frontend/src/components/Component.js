import { setHTML, isRawHtml } from '../utils/helpers.js';

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
 *   on(), timer(), interval(), observe() and raf() are registerCleanup() with
 *   the acquisition folded in, so the safe form is also the short one:
 *
 *     this.on(document, 'keydown', e => this._onKey(e));
 *     this.observe(new ResizeObserver(() => this._refit())).observe(el);
 *     this.timer(() => this.setState({ flash: false }), 2000);
 *
 * Event contract — data-action:
 *   A component that declares an `actions` map gets ONE delegated listener per
 *   event type on this.container, bound at mount() and released at unmount().
 *   The container outlives every render, so the binding is established once
 *   instead of re-attached per afterRender() — which retires both halves of
 *   the classic pair of bugs there: a listener never re-attached is a dead
 *   button, one attached twice fires twice.
 *
 *     render()  ->  html`<button data-action="delete" data-id="${id}">…`
 *     class     ->  actions = { delete(e, el) { this._delete(el.dataset.id); } }
 *
 *   Handlers are called with `this` bound to the component, the event, and the
 *   nearest [data-action] ancestor of the target. A bare key answers `click`;
 *   any other event type is delegated by writing it into the key —
 *   `'change:select-all'` — and the set of delegated types is read off the
 *   map, so there is no second list to keep in sync. An event originating
 *   inside a child mounted with mountChild() belongs to that child and is not
 *   dispatched again here.
 *
 * Update contract — in-place rendering:
 *   The default re-render is a rebuild: children unmounted, render() called,
 *   its markup written with setHTML(). That is right whenever the markup is
 *   the whole truth and wrong whenever DOM identity carries something it does
 *   not — a decoded <img> rebuilt is an image thrown away and fetched again,
 *   which is a visible flash. A subclass that can answer a particular change
 *   without the rebuild declares update():
 *
 *     update(prevProps, prevState) {
 *       if (prevProps.posts === this.props.posts) return false;   // rebuild
 *       reconcileList(this.$('.grid'), this.props.posts, p => p.id, ops);
 *       return true;                                              // handled
 *     }
 *
 *   Returning exactly true means handled: _rerender() returns immediately, so
 *   render() and afterRender() do not run, and — because the DOM they wired is
 *   still on screen — neither the cleanup list nor the mounted children are
 *   touched. Anything else falls through to the rebuild, so `return false`,
 *   dropping off the end, or a case not thought about are all the safe answer.
 *   update() is never consulted for the first render; there is nothing to
 *   update yet.
 *
 *   The cost of "handled" is that the component now owns keeping its DOM true
 *   to its props. reconcileList() (utils/reconcileList.js) is the keyed list
 *   half of that, and preserveInteraction() (utils/preserveInteraction.js)
 *   carries focus and scroll across the rebuilds that do happen.
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
 *   - A markup helper with nothing to render returns '' rather than html``.
 *     html`` yields a String OBJECT, so an empty one is still truthy, and the
 *     `frag ? html`<div>${frag}</div>` : ''` shape callers reach for would emit
 *     the empty wrapper. render() itself may return html`` — nothing tests it.
 */

/**
 * The optional hooks a subclass may declare. None of them exist on the base
 * class — every call site tests for one before calling it — so reading them off
 * a Component needs the checker told that the absence is the point.
 *
 * @typedef {object} SubclassHooks
 * @property {(prevProps: object, prevState: object) => unknown} [update]
 *   In-place update. Exactly `true` means handled; see _rerender().
 * @property {() => void} [beforeRender]
 *   Release what the previous render acquired, before the container is replaced.
 * @property {Record<string, (event: Event, el: Element) => unknown>} [actions]
 *   Delegated handlers, keyed by `data-action` name or `'<type>:<name>'`, called
 *   with the component as `this` — see _dispatchAction().
 * @property {(params: object, query: object) => void} [onRouteUpdate]
 *   Same-route navigation: refresh in place instead of remounting (router.js).
 */

/**
 * A component's subclass hooks. A cast, not a check — see {@link SubclassHooks}.
 *
 * @param {Component} component
 * @returns {SubclassHooks}
 */
export function subclassHooks(component) {
  return /** @type {SubclassHooks} */ (/** @type {unknown} */ (component));
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
    /**
     * Teardowns for the delegated `actions` listeners. Bound once at mount()
     * because this.container survives every render; released at unmount().
     * @type {Function[]}
     */
    this._actionTeardowns = [];
    /**
     * Whether render() has ever written into the container. Gates update():
     * the first pass has no DOM to update in place.
     * @type {boolean}
     */
    this._rendered = false;
    this._unmounted = false;
  }

  // ── Subclass interface ────────────────────────────────────────────────────

  /**
   * Return the markup describing this component, built with the html`` tag.
   * Must be overridden.
   * @returns {import('../utils/helpers.js').RawHtml} html`` output. A plain
   *   string is refused — _rerender() throws rather than write it.
   */
  render() {
    throw new Error(`${this.constructor.name}.render() not implemented`);
  }

  // Optional, declared by subclasses that want delegation:
  //   actions = { <data-action value>: (event, el) => void }
  // See the event contract in the class comment.

  // Optional, declared by subclasses that can update their DOM in place:
  //   update(prevProps, prevState) { …; return true; }
  // Returning true skips the rebuild entirely. See the update contract in the
  // class comment.

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
    const prevState = this.state;
    this.state = {
      ...this.state,
      ...delta
    };
    this._rerender(this.props, prevState);
  }

  /**
   * Merge delta into props and re-render.
   * @param {object} delta
   */
  setProps(delta) {
    if (this._unmounted) return;
    const prevProps = this.props;
    this.props = {
      ...this.props,
      ...delta
    };
    this._rerender(prevProps, this.state);
  }

  /**
   * Perform the initial render. Call this once after construction.
   */
  mount() {
    this._bindActions();
    this._rerender();
  }

  /**
   * Tear down: call beforeUnmount, unmount children, clear the container.
   */
  unmount() {
    this._unmounted = true;
    this._unbindActions();
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
    const child = new Cls(/** @type {HTMLElement} */ (el), props);
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
   *
   * Takes one of store.js's `on*` accessors rather than the store and a key,
   * so a mistyped key is a build error instead of a subscription that never
   * fires:
   *
   *   this.subscribeStore(onSettings, () => this.setState({}));
   *
   * @param {Function} subscribe  An `on*` accessor from store.js; returns the
   *                              unsubscribe function.
   * @param {Function} callback   Called with the new value on every change.
   */
  subscribeStore(subscribe, callback) {
    this.registerCleanup(subscribe(callback));
  }

  /**
   * Subscribe to one slice of a store key for the lifetime of the current
   * render, so writes to the rest of that key cost nothing here.
   *
   * Takes an `on*Selector` accessor from store.js, for the same reason
   * subscribeStore() takes an `on*` one:
   *
   *   this.subscribeStoreSelector(onSettingsSelector, s => s.blog_title, cb);
   *
   * @param {Function} subscribeSelector  An `on*Selector` accessor from
   *                                      store.js; returns the unsubscribe
   *                                      function.
   * @param {Function} select    Maps the key's value to the slice to watch
   * @param {Function} callback  Called when the slice changes
   */
  subscribeStoreSelector(subscribeSelector, select, callback) {
    this.registerCleanup(subscribeSelector(select, callback));
  }

  /**
   * Add an event listener released at the next render boundary.
   *
   * The whole point is that the safe form is the short one: no handler stored
   * in a field, no matching removeEventListener to forget, no "did I already
   * bind this?" flag. Registered through registerCleanup(), so a listener
   * taken in afterRender() lives exactly as long as the render that took it.
   *
   * A missing target is a no-op rather than a throw, so the `this.$('.x')` of
   * a conditionally rendered element can be passed straight in.
   *
   * @param {EventTarget|null|undefined} target
   * @param {string} type
   * @param {EventListenerOrEventListenerObject} handler
   * @param {boolean|AddEventListenerOptions} [options]  Passed to both add and
   *                                    remove, so a capture listener detaches
   *                                    correctly.
   * @returns {EventTarget|null} target, for chaining; null when there was none.
   */
  on(target, type, handler, options) {
    if (!target?.addEventListener) return null;
    target.addEventListener(type, handler, options);
    this.registerCleanup(() => target.removeEventListener(type, handler, options));
    return target;
  }

  /**
   * setTimeout whose pending callback is cancelled at the next render boundary.
   * A timer that already fired clears harmlessly.
   * @param {Function} fn
   * @param {number} [ms]
   * @returns {*} the timer id
   */
  timer(fn, ms) {
    const id = setTimeout(fn, ms);
    this.registerCleanup(() => clearTimeout(id));
    return id;
  }

  /**
   * setInterval stopped at the next render boundary.
   *
   * An interval that must survive re-renders — a poll started once — belongs
   * in the constructor with beforeUnmount() to stop it, not here.
   * @param {Function} fn
   * @param {number} [ms]
   * @returns {*} the interval id
   */
  interval(fn, ms) {
    const id = setInterval(fn, ms);
    this.registerCleanup(() => clearInterval(id));
    return id;
  }

  /**
   * Register any object with a disconnect() — ResizeObserver, MutationObserver,
   * IntersectionObserver — to be disconnected at the next render boundary.
   *
   * Returns the observer, so the usual one-liner reads:
   *   this.observe(new ResizeObserver(fn)).observe(el)
   *
   * @template {{ disconnect: Function }} T
   * @param {T} observer
   * @returns {T}
   */
  observe(observer) {
    this.registerCleanup(() => observer.disconnect());
    return observer;
  }

  /**
   * requestAnimationFrame cancelled at the next render boundary, so a frame
   * scheduled by the previous render cannot run against the new DOM.
   * @param {FrameRequestCallback} fn
   * @returns {number} the frame id
   */
  raf(fn) {
    const id = requestAnimationFrame(fn);
    this.registerCleanup(() => cancelAnimationFrame(id));
    return id;
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
   *
   * Typed as HTMLElements to match $(): a component queries the markup its own
   * render() produced, and every caller here treats the results as elements.
   *
   * @param {string} selector
   * @returns {NodeListOf<HTMLElement>}
   */
  $$(selector) {
    return this.container.querySelectorAll(selector);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * @param {object} [prevProps]  props as they were before this change
   * @param {object} [prevState]  state as it was before this change
   */
  _rerender(prevProps, prevState) {
    // The in-place path. Offered only from the second render onwards — before
    // the first there is no DOM to update — and only when the subclass has
    // declared update(). Returning true means "handled": the DOM below is left
    // exactly as it is, which is the whole point, so the cleanups, children and
    // listeners belonging to it are left alone too.
    const hooks = subclassHooks(this);
    if (this._rendered && typeof hooks.update === 'function'
        && hooks.update(prevProps ?? this.props, prevState ?? this.state) === true) {
      return;
    }

    // Release what the previous render acquired, while its DOM is still in
    // place: registered teardowns first, then the imperative hook.
    this._runCleanups();
    // Optional hook called before every re-render including the first.
    // Override in subclasses to release resources (timers, observers, DOM nodes
    // appended outside the container) before the container is replaced.
    // Unlike beforeUnmount() this also runs on setState() / setProps() calls.
    hooks.beforeRender?.();
    this._unmountChildren();
    this._children = [];
    const markup = this.render();
    // The contract, enforced rather than documented: a plain string here would
    // reach innerHTML with nothing having escaped it, which is the whole class
    // of bug the html`` tag exists to remove. There is no escape hatch — build
    // the markup with the tag, and use raw() for the pieces that need it.
    // setHTML() re-checks this, but the message it can give names a sink; the
    // one worth reading here names the subclass whose render() is at fault.
    if (!isRawHtml(markup)) {
      throw new TypeError(
        `${this.constructor.name}.render() must return html\`\` output, got ` +
        `${markup === null ? 'null' : typeof markup}. Build it with the html tag ` +
        'from utils/helpers.js.',
      );
    }
    setHTML(this.container, markup);
    this._rendered = true;
    this.afterRender();
  }
  _unmountChildren() {
    this._children.forEach(c => c.unmount());
    this._children = [];
  }

  /**
   * Bind the delegated `actions` listeners to this.container.
   *
   * The event types come from the map itself: a bare key answers `click`, and
   * a key of the form `'<type>:<name>'` contributes its type. Deriving them
   * this way means a component declares its wiring in exactly one place — a
   * second list would be a thing to forget, and forgetting it produces a
   * button that silently does nothing.
   */
  _bindActions() {
    const { actions } = subclassHooks(this);
    if (!actions || !this.container?.addEventListener) return;
    if (this._actionTeardowns.length) return; // already bound; mount() is idempotent

    const types = new Set();
    for (const key of Object.keys(actions)) {
      const sep = key.indexOf(':');
      types.add(sep > 0 ? key.slice(0, sep) : 'click');
    }

    const dispatch = event => this._dispatchAction(event);
    for (const type of types) {
      this.container.addEventListener(type, dispatch);
      this._actionTeardowns.push(
        () => this.container.removeEventListener(type, dispatch),
      );
    }
  }

  /** Release the delegated listeners. Only unmount() ends their lifetime. */
  _unbindActions() {
    const fns = this._actionTeardowns;
    this._actionTeardowns = [];
    for (const fn of fns) fn();
  }

  /**
   * Route one delegated event to its handler.
   *
   * `closest` rather than the target itself, so the click that lands on an
   * icon inside the button still finds the button. A hit inside a child
   * mounted with mountChild() is that child's to answer — it bubbles through
   * here on its way up the tree, and dispatching it again would run the
   * parent's same-named action a second time.
   *
   * @param {Event} event
   */
  _dispatchAction(event) {
    const { actions } = subclassHooks(this);
    if (!actions) return;

    const el = /** @type {Element} */ (event.target)?.closest?.('[data-action]');
    if (!el || !this.container.contains(el)) return;

    for (const child of this._children) {
      if (child.container !== this.container && child.container?.contains(el)) return;
    }

    const name = el.getAttribute('data-action');
    const handler = actions[`${event.type}:${name}`]
      ?? (event.type === 'click' ? actions[name] : undefined);
    if (typeof handler !== 'function') return;

    handler.call(this, event, el);
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