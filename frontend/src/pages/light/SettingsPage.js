/**
 * SettingsPage — admin configuration form.
 *
 * Fetches all settings and renders them in a grouped form.
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { getAllSettings, updateSettings } from '../../api/settings.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';

const SETTING_GROUPS = [
  {
    title: 'General',
    keys: ['blog_title', 'blog_subtitle', 'author_name', 'author_bio', 'footer_text']
  },
  {
    title: 'Display',
    keys: ['posts_per_page', 'default_theme', 'show_view_counts', 'use_thumbnails', 'show_tag_cloud']
  },
  {
    title: 'Storage & System',
    keys: ['storage_quota_mb', 'enable_map', 'enable_backup', 'backup_interval_hours']
  },
  {
    title: 'Access',
    keys: ['multi_user_mode']
  }
];

export default class SettingsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      settings: {},
      saving: false,
      error: null,
    };
  }

  render() {
    const { loading, error, settings, saving } = this.state;

    let content = '';
    if (loading) {
      content = `<div class="loading-spinner" aria-label="Loading settings…"></div>`;
    } else if (error) {
      content = `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;
    } else {
      content = `
        <form id="settings-form">
          ${SETTING_GROUPS.map(group => this._renderGroup(group, settings)).join('')}
          <div class="form-actions" style="margin-top: var(--spacing-xl)">
            <button type="submit" class="btn btn-primary" ${saving ? 'disabled' : ''}>
              ${saving ? 'Saving…' : 'Save Settings'}
            </button>
          </div>
        </form>`;
    }

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Settings</h1>
          </header>
          <main class="light-content">
            ${content}
          </main>
        </div>
      </div>`;
  }

  _renderGroup(group, settings) {
    const fields = group.keys.map(key => {
      const value = settings[key] ?? '';
      const label = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

      // Determine input type
      let input = '';
      if (key === 'author_bio' || key === 'footer_text') {
        input = `<textarea name="${key}" class="form-input" rows="3">${escapeHtml(String(value))}</textarea>`;
      } else if (key === 'default_theme') {
        input = `
          <select name="${key}" class="form-input">
            <option value="light"${value === 'light' ? ' selected' : ''}>Light</option>
            <option value="dark"${value === 'dark' ? ' selected' : ''}>Dark</option>
            <option value="auto"${value === 'auto' ? ' selected' : ''}>Auto (System)</option>
          </select>`;
      } else if (key.includes('enable') || key.includes('show') || key.includes('use')) {
        const checked = value === 'true' || value === true || value === 1 || value === '1';
        input = `<input type="checkbox" name="${key}" ${checked ? 'checked' : ''}>`;
      } else if (key.includes('per_page') || key.includes('quota') || key.includes('interval')) {
        input = `<input type="number" name="${key}" class="form-input" value="${escapeHtml(String(value))}">`;
      } else {
        input = `<input type="text" name="${key}" class="form-input" value="${escapeHtml(String(value))}">`;
      }

      const isCheckbox = input.startsWith('<input type="checkbox"');

      return `
        <div class="form-group ${isCheckbox ? 'checkbox-group' : ''}">
          ${isCheckbox ? '' : `<label>${escapeHtml(label)}</label>`}
          ${input}
          ${isCheckbox ? `<label>${escapeHtml(label)}</label>` : ''}
        </div>`;
    }).join('');

    return `
      <div class="card" style="margin-bottom: var(--spacing-xl)">
        <div class="card-header"><h2>${escapeHtml(group.title)}</h2></div>
        <div class="card-body">
          ${fields}
        </div>
      </div>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/settings',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading || this.state.error) return;

    this.$('#settings-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      this._handleSave();
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    this.setState({ loading: true, error: null });
    try {
      const settings = await getAllSettings();
      this.setState({ loading: false, settings });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load settings.' });
    }
  }

  async _handleSave() {
    const form = this.$('#settings-form');
    if (!form) return;

    const formData = new FormData(form);
    const data = {};

    // Collect all keys from groups to ensure we handle checkboxes
    SETTING_GROUPS.forEach(g => {
      g.keys.forEach(k => {
        const val = formData.get(k);
        const type = this._getSettingType(k);

        if (type === 'boolean') {
          data[k] = val === 'on' || val === 'true' || val === true;
        } else if (type === 'number') {
          data[k] = val ? parseInt(val, 10) : 0;
        } else {
          data[k] = val || '';
        }
      });
    });

    this.setState({ saving: true });
    try {
      await updateSettings(data);
      store.set('toast', { message: 'Settings updated.', type: 'success' });
      this.setState({ saving: false, settings: { ...this.state.settings, ...data } });

      // Update document title if blog_title changed
      if (data.blog_title) {
        document.title = data.blog_title;
        store.set('settings', { ...store.get('settings'), blog_title: data.blog_title });
      }
    } catch (err) {
      this.setState({ saving: false });
      store.set('toast', { message: err.message || 'Update failed.', type: 'error' });
    }
  }

  _getSettingType(key) {
    if (key.includes('enable') || key.includes('show') || key.includes('use')) return 'boolean';
    if (key.includes('per_page') || key.includes('quota') || key.includes('interval')) return 'number';
    return 'string';
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
