/**
 * Base Web Component class for Point.
 * Handles Shadow DOM, lifecycle management, and Event Bus subscriptions.
 */

export class BaseWebComponent extends HTMLElement {
  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: 'open' });
    this._busSubscriptions = [];
    this.state = {};
    this.props = {};
  }

  /**
   * Called when the element is added to the document.
   */
  connectedCallback() {
    this._rerender();
  }

  /**
   * Called when the element is removed from the document.
   */
  disconnectedCallback() {
    this._busSubscriptions.forEach(({ event, callback }) => {
      window.Point.off(event, callback);
    });
    this._busSubscriptions = [];
  }

  /**
   * Return an HTML string for the component.
   * Override this in subclasses.
   */
  render() {
    return '';
  }

  /**
   * Called after render to the Shadow DOM.
   */
  afterRender() {}

  /**
   * Subscribe to PointBus, auto-unsubscribed on disconnect.
   * @param {string} event 
   * @param {Function} callback 
   */
  subscribeBus(event, callback) {
    this._busSubscriptions.push({ event, callback });
    window.Point.on(event, callback);
  }

  /**
   * Internal rerender logic.
   */
  _rerender() {
    this.shadow.innerHTML = `
      <style>
        :host {
          display: block;
          box-sizing: border-box;
          /* Default theming variables as fallback */
          --pt-bg: var(--bg, #ffffff);
          --pt-text: var(--text, #000000);
          --pt-accent: var(--accent, #007aff);
        }
      </style>
      ${this.render()}
    `;
    this.afterRender();
  }

  /**
   * Update component state and rerender.
   * @param {object} delta 
   */
  setState(delta) {
    this.state = { ...this.state, ...delta };
    this._rerender();
  }
}
