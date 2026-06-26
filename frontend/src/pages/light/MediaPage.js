/**
 * MediaPage — media library page.
 *
 * Thin wrapper around MediaBrowser. All media logic lives in the shared
 * MediaBrowser component so it can be reused in the MediaPickerDialog.
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { MediaBrowser } from '../../components/light/MediaBrowser.js';

export default class MediaPage extends Component {
  render() {
    return adminLayoutTemplate({
      title: 'Media',
      content: `<div id="media-browser-mount"></div>`
    });
  }

  afterRender() {
    this._cleanupAdminLayout = setupAdminLayout(this, {
      currentPath: '/light/media',
    });

    // Fixed-viewport layout (media.css .media-page-main): the gallery fills the
    // available width/height, its grid scrolls, and pagination stays pinned.
    this.$('.light-main')?.classList.add('media-page-main');

    this.mountChild(MediaBrowser, '#media-browser-mount', { pickerMode: false });
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
  }
}
