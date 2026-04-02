/**
 * MediaPage — media library page.
 *
 * Thin wrapper around MediaBrowser. All media logic lives in the shared
 * MediaBrowser component so it can be reused in the MediaPickerDialog.
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { MediaBrowser } from '../../components/light/MediaBrowser.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { navigate } from '../../utils/helpers.js';

export default class MediaPage extends Component {
  render() {
    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>Media</h1>
          </header>
          <main class="light-content" id="media-browser-mount"></main>
        </div>
      </div>`;
  }

  afterRender() {
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/media',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    this.mountChild(MediaBrowser, '#media-browser-mount', { pickerMode: false });
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/', { replace: true });
  }
}
