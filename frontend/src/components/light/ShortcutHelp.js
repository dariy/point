// @ts-nocheck — not yet typecheck-clean; see p-frontend-rendering-m06x.11.
import { Component } from '../Component.js';
import { html } from '../../utils/helpers.js';
import { acquireScrollLock, releaseScrollLock } from '../../utils/scrollLock.js';

const SHORTCUTS = [
  { group: 'Global', items: [
    { key: 'Ctrl + K', label: 'Command Palette' },
    { key: '?', label: 'Show this help' },
    { key: 'Esc', label: 'Close / Cancel' },
  ]},
  { group: 'Editor', items: [
    { key: 'Ctrl + S', label: 'Save post' },
  ]},
  { group: 'Lists', items: [
    { key: 'J / K', label: 'Navigate items' },
    { key: 'Enter', label: 'Edit selected' },
  ]},
];

export class ShortcutHelp extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { isOpen: false };
    this._onGlobalKeyDown = this._onKeyDownGlobal.bind(this);
  }

  render() {
    if (!this.state.isOpen) return html``;

    return html`
      <div class="sh-overlay" id="sh-overlay">
        <div class="sh-dialog">
          <div class="sh-header">
            <h3>Keyboard Shortcuts</h3>
            <button class="sh-close">&times;</button>
          </div>
          <div class="sh-body">
            ${SHORTCUTS.map(g => html`
              <div class="sh-group">
                <h4 class="sh-group-title">${g.group}</h4>
                <div class="sh-group-items">
                  ${g.items.map(s => html`
                    <div class="sh-item">
                      <span class="sh-label">${s.label}</span>
                      <kbd class="sh-key">${s.key}</kbd>
                    </div>
                  `)}
                </div>
              </div>
            `)}
          </div>
        </div>
      </div>
    `;
  }

  afterRender() {
    if (!this.state.isOpen) return;

    this.$('#sh-overlay')?.addEventListener('click', (e) => {
      if (e.target.id === 'sh-overlay' || e.target.classList.contains('sh-close')) this.close();
    });
    this.$('.sh-close')?.addEventListener('click', () => this.close());
  }

  mount() {
    super.mount();
    document.addEventListener('keydown', this._onGlobalKeyDown);
  }

  unmount() {
    document.removeEventListener('keydown', this._onGlobalKeyDown);
    super.unmount();
  }

  open() {
    this.setState({ isOpen: true });
    acquireScrollLock(this);
  }

  close() {
    this.setState({ isOpen: false });
    releaseScrollLock(this);
  }

  beforeUnmount() {
    // Unmounted rather than closed (a page setState) must still unlock the page.
    releaseScrollLock(this);
  }

  _onKeyDownGlobal(e) {
    if (e.key === '?' && !this.state.isOpen) {
      // Don't trigger if typing in an input
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
      e.preventDefault();
      this.open();
    }
    if (e.key === 'Escape' && this.state.isOpen) {
      this.close();
    }
  }
}
