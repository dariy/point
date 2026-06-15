import { Component } from '../Component.js';
import { escapeHtml } from '../../utils/helpers.js';

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
    if (!this.state.isOpen) return '';

    return `
      <div class="sh-overlay" id="sh-overlay">
        <div class="sh-dialog">
          <div class="sh-header">
            <h3>Keyboard Shortcuts</h3>
            <button class="sh-close">&times;</button>
          </div>
          <div class="sh-body">
            ${SHORTCUTS.map(g => `
              <div class="sh-group">
                <h4 class="sh-group-title">${escapeHtml(g.group)}</h4>
                <div class="sh-group-items">
                  ${g.items.map(s => `
                    <div class="sh-item">
                      <span class="sh-label">${escapeHtml(s.label)}</span>
                      <kbd class="sh-key">${escapeHtml(s.key)}</kbd>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
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
    document.body.style.overflow = 'hidden';
  }

  close() {
    this.setState({ isOpen: false });
    document.body.style.overflow = '';
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
