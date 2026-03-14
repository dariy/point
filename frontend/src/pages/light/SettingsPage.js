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
import { escapeHtml, navigate, normalizeSettings } from '../../utils/helpers.js';

const SETTING_GROUPS = [
  {
    title: 'General',
    keys: ['blog_title', 'blog_subtitle', 'author_name', 'author_bio', 'footer_text', 'about_post_id']
  },
  {
    title: 'Display',
    keys: ['posts_per_page', 'min_tag_posts_to_show', 'default_theme', 'show_view_counts', 'use_thumbnails', 'show_tag_cloud', 'show_immersive_excerpt']
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
        <form id="settings-form" class="settings-grid">
          ${SETTING_GROUPS.map(group => this._renderGroup(group, settings)).join('')}
        </form>`;
    }

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Settings</h1>
            <div class="header-actions">
              <button type="submit" form="settings-form" class="btn btn-primary" ${saving ? 'disabled' : ''}>
                ${saving ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          </header>
          <main class="light-content">
            ${content}
          </main>
        </div>
      </div>`;
  }

  _renderGroup(group, settings) {
    const inputs = [];
    const toggles = [];

    for (const key of group.keys) {
      const value = settings[key] ?? '';
      const label = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

      if (key.includes('enable') || key.includes('show') || key.includes('use')) {
        const checked = value === 'true' || value === true || value === 1 || value === '1';
        toggles.push({ key, label, checked });
        continue;
      }

      let input = '';
      if (key === 'about_post_id') {
        const previewLink = value
          ? `<a href="/post/${escapeHtml(String(value))}" target="_blank" class="settings-preview-link">Preview ↗</a>`
          : '';
        input = `<div class="settings-input-with-preview">
          <input type="text" name="${key}" class="form-input" placeholder="Post slug or ID (e.g. about)" value="${escapeHtml(String(value))}">
          ${previewLink}
        </div>`;
      } else if (key === 'author_bio' || key === 'footer_text') {
        input = `<textarea name="${key}" class="form-textarea" rows="3">${escapeHtml(String(value))}</textarea>`;
      } else if (key === 'default_theme') {
        input = `
          <select name="${key}" class="form-select">
            <option value="light"${value === 'light' ? ' selected' : ''}>Light</option>
            <option value="dark"${value === 'dark' ? ' selected' : ''}>Dark</option>
            <option value="auto"${value === 'auto' ? ' selected' : ''}>Auto (System)</option>
          </select>`;
      } else if (key.includes('per_page') || key.includes('quota') || key.includes('interval') || key.includes('posts_to_show')) {
        input = `<input type="number" name="${key}" class="form-input" value="${escapeHtml(String(value))}" min="0">`;
      } else {
        input = `<input type="text" name="${key}" class="form-input" value="${escapeHtml(String(value))}">`;
      }

      const isTextarea = key === 'author_bio' || key === 'footer_text';
      inputs.push(`
        <div class="settings-field${isTextarea ? ' settings-field-top' : ''}">
          <label class="settings-field-label">${escapeHtml(label)}</label>
          ${input}
        </div>`);
    }

    const inputsHtml = inputs.join('');
    const togglesHtml = toggles.length ? `
      <div class="setting-pill-group${inputs.length ? ' setting-pill-group-divided' : ''}">
        ${toggles.map(({ key, label, checked }) => `
          <label class="setting-pill">
            <input type="checkbox" name="${key}" class="setting-pill-input" ${checked ? 'checked' : ''}>
            <span class="setting-pill-label">${escapeHtml(label)}</span>
          </label>`).join('')}
      </div>` : '';

    return `
      <div class="card">
        <div class="card-header"><h2>${escapeHtml(group.title)}</h2></div>
        <div class="card-body">
          ${inputsHtml}${togglesHtml}
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

    this.$$('.setting-pill-input').forEach(cb => {
      cb.addEventListener('change', () => this._handleCheckboxChange(cb.name, cb.checked));
    });
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    this.setState({ loading: true, error: null });
    try {
      const settings = normalizeSettings(await getAllSettings());
      this.setState({ loading: false, settings });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Failed to load settings.' });
    }
  }

  async _handleCheckboxChange(key, checked) {
    try {
      const updated = normalizeSettings(await updateSettings({ [key]: String(checked) }));
      const merged = { ...this.state.settings, ...updated };
      this.setState({ settings: merged });
      store.set('settings', merged);
    } catch (err) {
      store.set('toast', { message: err.message || 'Update failed.', type: 'error' });
    }
  }

  async _handleSave() {
    const form = this.$('#settings-form');
    if (!form) return;

    const formData = new FormData(form);
    const data = {};

    SETTING_GROUPS.forEach(g => {
      g.keys.forEach(k => {
        const type = this._getSettingType(k);
        if (type === 'boolean') return; // saved on checkbox change
        const val = formData.get(k);
        if (type === 'number') {
          data[k] = String(val ? parseInt(val, 10) : 0);
        } else {
          data[k] = val || '';
        }
      });
    });

    this.setState({ saving: true });
    try {
      const updated = normalizeSettings(await updateSettings(data));
      const merged = { ...this.state.settings, ...updated };
      store.set('toast', { message: 'Settings updated.', type: 'success' });
      this.setState({ saving: false, settings: merged });
      store.set('settings', merged);

      // Update document title if blog_title changed
      if (data.blog_title) {
        document.title = data.blog_title;
      }
    } catch (err) {
      this.setState({ saving: false });
      store.set('toast', { message: err.message || 'Update failed.', type: 'error' });
    }
  }

  _getSettingType(key) {
    if (key.includes('enable') || key.includes('show') || key.includes('use')) return 'boolean';
    if (key.includes('per_page') || key.includes('quota') || key.includes('interval') || key.includes('posts_to_show')) return 'number';
    return 'string';
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
