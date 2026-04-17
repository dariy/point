/**
 * SettingsPage — admin configuration form.
 *
 * Fetches all settings and renders them in a grouped form.
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { getAllSettings, updateSettings } from '../../api/settings.js';
import { listPosts } from '../../api/posts.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate, normalizeSettings } from '../../utils/helpers.js';

const SETTING_GROUPS = [
  {
    title: 'General',
    keys: ['blog_title', 'blog_subtitle', 'author_name', 'about_post_id']
  },
  {
    title: 'Display',
    keys: ['posts_per_page', 'min_tag_posts_to_show', 'default_theme', 'immersive_nav_direction', 'show_view_counts', 'use_thumbnails', 'show_tag_cloud', 'show_immersive_excerpt', 'exif_visibility']
  },
  {
    title: 'Storage & System',
    keys: ['storage_quota_mb', 'enable_map', 'enable_back`up', 'backup_interval_hours']
  },
  {
    title: 'Advanced',
    keys: ['max_upload_size_mb', 'thumbnail_width', 'thumbnail_height', 'jpeg_quality']
  },
  {
    title: 'AI (Gemini)',
    keys: ['GEMINI_API_KEY', 'gemini_prompt_title', 'gemini_prompt_tags', 'gemini_prompt_excerpt']
  }
];

const NUMERIC_KEYS = new Set([
  'max_upload_size_mb', 'thumbnail_width', 'thumbnail_height', 'jpeg_quality'
]);

export default class SettingsPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      settings: {},
      posts: [],
      saving: false,
      error: null,
    };
  }

  render() {
    const { loading, error, settings, posts, saving } = this.state;

    let content = '';
    if (loading) {
      content = `<div class="loading-spinner" aria-label="Loading settings…"></div>`;
    } else if (error) {
      content = `<p class="error-state" role="alert">${escapeHtml(error)}</p>`;
    } else {
      content = `
        <form id="settings-form" class="settings-grid">
          ${SETTING_GROUPS.map(group => this._renderGroup(group, settings, posts)).join('')}
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

  _renderGroup(group, settings, posts) {
    const inputs = [];
    const toggles = [];

    for (const key of group.keys) {
      if (key === 'gemini_prompt_tags' || key === 'gemini_prompt_excerpt') continue;
      const value = settings[key] ?? '';
      const label = key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

      let input = '';
      let isToggle = false;

      if (key === 'about_post_id') {
        const options = posts.map(p => {
          const slug = escapeHtml(p.slug);
          const title = escapeHtml(p.title || p.slug);
          const selected = p.slug === value ? ' selected' : '';
          return `<option value="${slug}"${selected}>${title}</option>`;
        }).join('');
        const previewLink = value
          ? `<a href="/post/${escapeHtml(String(value))}" target="_blank" class="settings-preview-link">Preview ↗</a>`
          : '';
        input = `<div class="settings-input-with-preview">
          <select name="${key}" id="${key}" class="form-select">
            <option value="">— None —</option>
            ${options}
          </select>
          ${previewLink}
        </div>`;
      } else if (key === 'default_theme') {
        input = `
          <select name="${key}" id="${key}" class="form-select">
            <option value="light"${value === 'light' ? ' selected' : ''}>Light</option>
            <option value="dark"${value === 'dark' ? ' selected' : ''}>Dark</option>
            <option value="auto"${value === 'auto' ? ' selected' : ''}>Auto (System)</option>
          </select>`;
      } else if (key === 'immersive_nav_direction') {
        const isFeed = value === 'feed';
        input = `
          <select name="${key}" id="${key}" class="form-select">
            <option value="chronological"${!isFeed ? ' selected' : ''}>Chronological (◁ older, ▷ newer)</option>
            <option value="feed"${isFeed ? ' selected' : ''}>Feed order (◁ newer, ▷ older)</option>
          </select>`;
      } else if (key === 'exif_visibility') {
        const v = value || 'hide';
        input = `
          <select name="${key}" id="${key}" class="form-select">
            <option value="hide"${v === 'hide' ? ' selected' : ''}>Hide</option>
            <option value="admin"${v === 'admin' ? ' selected' : ''}>Admins only</option>
            <option value="all"${v === 'all' ? ' selected' : ''}>Everyone</option>
          </select>`;
      } else if (NUMERIC_KEYS.has(key) || key.includes('per_page') || key.includes('quota') || key.includes('interval') || key.includes('posts_to_show')) {
        input = `<input type="number" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}" min="0">`;
      } else if (key.includes('enable') || key.includes('show') || key.includes('use')) {
        const checked = value === 'true' || value === true || value === 1 || value === '1';
        toggles.push({ key, label, checked });
        isToggle = true;
      } else if (key === 'GEMINI_API_KEY') {
        const isConfigured = settings['GEMINI_API_KEY_CONFIGURED'] === 'true' || settings['GEMINI_API_KEY_CONFIGURED'] === true;
        const placeholder = isConfigured ? '******** (Configured)' : 'Enter Gemini API Key';
        input = `<input type="password" name="${key}" id="${key}" class="form-input" placeholder="${placeholder}" value="">`;
      } else if (key === 'gemini_prompt_title') {
        const tv = escapeHtml(settings['gemini_prompt_title'] ?? '');
        const kv = escapeHtml(settings['gemini_prompt_tags'] ?? '');
        const ev = escapeHtml(settings['gemini_prompt_excerpt'] ?? '');
        input = `<div class="prompt-template">
          <div class="prompt-line prompt-line-fixed">Analyze this image and return a JSON object.</div>
          <div class="prompt-line">
            <span class="prompt-key">"title" <span class="prompt-type">(string)</span>:</span>
            <input type="text" name="gemini_prompt_title" class="form-input prompt-part" value="${tv}" placeholder="a concise, descriptive title" maxlength="200">
          </div>
          <div class="prompt-line">
            <span class="prompt-key">"tags" <span class="prompt-type">(array of strings)</span>:</span>
            <input type="text" name="gemini_prompt_tags" class="form-input prompt-part" value="${kv}" placeholder="relevant keyword tags" maxlength="200">
          </div>
          <div class="prompt-line">
            <span class="prompt-key">"excerpt" <span class="prompt-type">(string)</span>:</span>
            <input type="text" name="gemini_prompt_excerpt" class="form-input prompt-part" value="${ev}" placeholder="a 1-2 sentence description" maxlength="200">
          </div>
          <div class="prompt-line prompt-line-fixed">Return only valid JSON, no markdown or extra text.</div>
        </div>`;
      } else {
        input = `<input type="text" name="${key}" id="${key}" class="form-input" value="${escapeHtml(String(value))}">`;
      }

      if (!isToggle) {
        const isPromptComposite = key === 'gemini_prompt_title';
        const fieldClass = isPromptComposite ? 'settings-field settings-field-top' : 'settings-field';
        const displayLabel = isPromptComposite ? 'Analysis Prompt' : label;
        inputs.push(`
          <div class="${fieldClass}">
            <label class="settings-field-label"${isPromptComposite ? '' : ` for="${key}"`}>${escapeHtml(displayLabel)}</label>
            ${input}
          </div>`);
      }
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

    const wideGroup = group.keys.includes('gemini_prompt_title');
    return `
      <div class="card${wideGroup ? ' card-full-width' : ''}">
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

    const aboutSelect = this.$('select[name="about_post_id"]');
    if (aboutSelect) {
      aboutSelect.addEventListener('change', () => {
        const slug = aboutSelect.value;
        const wrapper = aboutSelect.closest('.settings-input-with-preview');
        let link = wrapper?.querySelector('.settings-preview-link');
        if (slug) {
          if (link) {
            link.href = `/post/${slug}`;
          } else {
            const a = document.createElement('a');
            a.href = `/post/${slug}`;
            a.target = '_blank';
            a.className = 'settings-preview-link';
            a.textContent = 'Preview ↗';
            wrapper.appendChild(a);
          }
        } else if (link) {
          link.remove();
        }
      });
    }
  }

  mount() {
    super.mount();
    // Delegated listener on the container so it survives re-renders.
    this.container.addEventListener('change', (e) => {
      if (e.target.classList.contains('setting-pill-input')) {
        this._handleCheckboxChange(e.target.name, e.target.checked);
      }
    });
    this._load();
  }

  async _load() {
    this.setState({ loading: true, error: null });
    try {
      const [settings, postsResult] = await Promise.all([
        getAllSettings(),
        listPosts({ status: 'page', per_page: 200 }),
      ]);
      this.setState({
        loading: false,
        settings: normalizeSettings(settings),
        posts: postsResult.posts || [],
      });
    } catch (err) {
      console.error('[SettingsPage] load error:', err);
      store.set('toast', { message: 'Could not load settings.', type: 'error' });
      this.setState({ loading: false });
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
        if (k === 'GEMINI_API_KEY') {
          if (val) data[k] = val;
          return;
        }
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
    if (NUMERIC_KEYS.has(key) || key.includes('per_page') || key.includes('quota') || key.includes('interval') || key.includes('posts_to_show')) return 'number';
    if (key.includes('enable') || key.includes('show') || key.includes('use')) return 'boolean';
    return 'string';
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/', { replace: true });
  }
}
