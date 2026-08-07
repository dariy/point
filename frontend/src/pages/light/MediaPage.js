/**
 * MediaPage — media library page.
 *
 * Thin wrapper around MediaBrowser. All media logic lives in the shared
 * MediaBrowser component so it can be reused in the MediaPickerDialog.
 */

import { Component } from '../../components/Component.js';
import { adminLayoutTemplate, setupAdminLayout } from '../../components/light/AdminLayout.js';
import { MediaBrowser } from '../../components/light/MediaBrowser.js';
import { UPLOAD_SVG } from '../../utils/icons.js';

export default class MediaPage extends Component {
  render() {
    // Upload lives in the header, like "New Post" on the posts list. The picker
    // keeps its own in-browser upload button — it has no admin header.
    const actions = `
      <button id="media-upload-btn" class="btn btn-primary" title="Upload files">${UPLOAD_SVG}<span class="btn-label">Upload</span></button>
    `;

    return adminLayoutTemplate({
      title: 'Media',
      actions,
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

    const browser = this.mountChild(MediaBrowser, '#media-browser-mount', { pickerMode: false });

    this.$('#media-upload-btn')?.addEventListener('click', () => browser.openFilePicker());
  }

  beforeUnmount() {
    this._cleanupAdminLayout?.();
  }
}
