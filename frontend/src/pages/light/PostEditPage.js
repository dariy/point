/**
 * PostEditPage — create or edit a blog post.
 *
 * Routes:
 *   /light/posts/new          → create
 *   /light/posts/:id/edit     → edit existing
 *
 * Features: title, content (textarea), status, featured, tags (TagsInput),
 * thumbnail, meta description, drag-and-drop media upload, auto-save (draft).
 */

import { Component } from '../../components/Component.js';
import { LightSidebar } from '../../components/light/LightSidebar.js';
import { TagsInput } from '../../components/light/TagsInput.js';
import { getPost, createPost, updatePost } from '../../api/posts.js';
import { uploadMedia } from '../../api/media.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate, debounce } from '../../utils/helpers.js';

const AUTOSAVE_MS = 30_000;

export default class PostEditPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    const id = props.params?.id ? parseInt(props.params.id, 10) : null;
    this.state = {
      loading: !!id,
      saving: false,
      saveStatus: null,   // null | 'saving' | 'saved' | 'error'
      post: null,
      error: null,
      isNew: !id,
      postId: id,
    };
    this._tags = [];
    this._autosaveTimer = null;
    this._tagsInputRef = null;
    this._debouncedAutosave = debounce(this._autosave.bind(this), AUTOSAVE_MS);
  }

  render() {
    const { loading, error, post, isNew, saveStatus, saving } = this.state;

    if (loading) {
      return `
        <div class="light-layout">
          <div id="sidebar-mount"></div>
          <div class="light-main">
            <header class="light-header"><h1>${isNew ? 'New Post' : 'Edit Post'}</h1></header>
            <main class="light-content">
              <div class="loading-spinner" aria-label="Loading…"></div>
            </main>
          </div>
        </div>`;
    }

    if (error) {
      return `
        <div class="light-layout">
          <div id="sidebar-mount"></div>
          <div class="light-main">
            <header class="light-header"><h1>Error</h1></header>
            <main class="light-content">
              <p class="error-state">${escapeHtml(error)}</p>
            </main>
          </div>
        </div>`;
    }

    const p = post || {};
    const title    = escapeHtml(p.title || '');
    const content  = p.content || '';
    const status   = p.status || 'draft';
    const featured = p.is_featured || false;
    const thumb    = escapeHtml(p.thumbnail_path || '');
    const meta     = escapeHtml(p.meta_description || '');
    const fmt      = p.formatter || 'markdown';

    const statusOpts = ['draft', 'published', 'hidden', 'page'].map((s) =>
      `<option value="${s}"${status === s ? ' selected' : ''}>${escapeHtml(s.charAt(0).toUpperCase() + s.slice(1))}</option>`
    ).join('');

    const fmtOpts = ['markdown', 'html', 'raw'].map((f) =>
      `<option value="${f}"${fmt === f ? ' selected' : ''}>${escapeHtml(f)}</option>`
    ).join('');

    const saveLabel = saving ? 'Saving…' : 'Save';
    const statusMsg = saveStatus === 'saved'
      ? '<span class="save-status success">Saved</span>'
      : saveStatus === 'error'
        ? '<span class="save-status error">Save failed</span>'
        : '';

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>${isNew ? 'New Post' : 'Edit Post'}</h1>
            <div class="header-actions">
              ${statusMsg}
              <button id="save-btn" class="btn btn-primary" type="button"
                      ${saving ? 'disabled' : ''}>${escapeHtml(saveLabel)}</button>
              <a href="/light/posts" class="btn btn-secondary">Cancel</a>
            </div>
          </header>
          <main class="light-content">
            <div class="editor-container">

              <div class="editor-main">
                <div class="form-group">
                  <input type="text" id="title-input" class="form-input editor-title"
                         placeholder="Post title" value="${title}" required>
                </div>

                <div class="form-group">
                  <label for="content-editor">Content</label>
                  <textarea id="content-editor" class="editor-content"
                            rows="24" placeholder="Write your post content here…"
                            id="content-editor">${escapeHtml(content)}</textarea>
                </div>

                <div class="card">
                  <div class="card-header"><h3>Drop media here</h3></div>
                  <div class="card-body" id="drop-zone">
                    <p class="upload-area-text">Drag &amp; drop image or video files to insert them into your post.</p>
                    <div id="dropped-media-list"></div>
                  </div>
                </div>
              </div>

              <div class="editor-sidebar">
                <div class="card">
                  <div class="card-header"><h3>Publish</h3></div>
                  <div class="card-body">
                    <div class="form-group">
                      <label for="status-select">Status</label>
                      <select id="status-select" class="form-input">${statusOpts}</select>
                    </div>
                    <div class="form-group">
                      <label for="formatter-select">Formatter</label>
                      <select id="formatter-select" class="form-input">${fmtOpts}</select>
                    </div>
                    <div class="form-group">
                      <label class="checkbox-label">
                        <input type="checkbox" id="featured-check"
                               ${featured ? 'checked' : ''}> Featured post
                      </label>
                    </div>
                  </div>
                </div>

                <div class="card">
                  <div class="card-header"><h3>Tags</h3></div>
                  <div class="card-body">
                    <div id="tags-input-mount"></div>
                  </div>
                </div>

                <div class="card">
                  <div class="card-header"><h3>Thumbnail</h3></div>
                  <div class="card-body">
                    <div class="form-group">
                      <label for="thumbnail-input">Path or URL</label>
                      <input type="text" id="thumbnail-input" class="form-input"
                             placeholder="/2026/01/photo.jpg" value="${thumb}">
                    </div>
                  </div>
                </div>

                <div class="card">
                  <div class="card-header"><h3>SEO</h3></div>
                  <div class="card-body">
                    <div class="form-group">
                      <label for="meta-input">Meta description</label>
                      <textarea id="meta-input" class="form-input" rows="3"
                                maxlength="300" placeholder="SEO description…">${meta}</textarea>
                    </div>
                  </div>
                </div>
              </div>

            </div>
          </main>
        </div>
      </div>`;
  }

  afterRender() {
    const postSlug = this.state.post?.slug;
    this.mountChild(LightSidebar, '#sidebar-mount', {
      currentPath: '/light/posts',
      publicUrl: postSlug ? `/post/${postSlug}` : '/',
      user: store.get('user') || {},
      onLogout: this._handleLogout.bind(this),
    });

    if (this.state.loading || this.state.error) return;

    // Tags input
    this._tagsInputRef = this.mountChild(TagsInput, '#tags-input-mount', {
      tags: this.state.post?.tags || [],
      onChange: (tags) => { this._tags = tags; },
    });
    this._tags = this.state.post?.tags || [];

    // Save button
    const saveBtn = this.$('#save-btn');
    saveBtn?.addEventListener('click', () => this._save());

    // Auto-save on content change
    const titleInput = this.$('#title-input');
    const contentEditor = this.$('#content-editor');
    [titleInput, contentEditor].forEach((el) => {
      el?.addEventListener('input', () => this._debouncedAutosave());
    });

    // Drag-and-drop media upload
    const dropZone = this.$('#drop-zone');
    if (dropZone) {
      dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
      dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files).filter(
          (f) => f.type.startsWith('image/') || f.type.startsWith('video/')
        );
        files.forEach((f) => this._uploadAndInsert(f));
      });
    }
  }

  beforeUnmount() {
    clearTimeout(this._autosaveTimer);
  }

  mount() {
    super.mount();
    if (this.state.postId) {
      this._loadPost(this.state.postId);
    }
  }

  async _loadPost(id) {
    try {
      const post = await getPost(id);
      this._tags = post.tags || [];
      this.setState({ loading: false, post, error: null });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Post not found.' });
    }
  }

  _collectFormData() {
    return {
      title:            (this.$('#title-input')?.value || '').trim(),
      content:          this.$('#content-editor')?.value || '',
      status:           this.$('#status-select')?.value || 'draft',
      formatter:        this.$('#formatter-select')?.value || 'markdown',
      is_featured:      this.$('#featured-check')?.checked || false,
      thumbnail_path:   (this.$('#thumbnail-input')?.value || '').trim() || null,
      meta_description: (this.$('#meta-input')?.value || '').trim() || null,
      tags:             this._tags,
    };
  }

  async _save() {
    const data = this._collectFormData();
    if (!data.title) {
      store.set('toast', { message: 'Title is required.', type: 'error' });
      return;
    }

    this.setState({ saving: true, saveStatus: 'saving' });
    try {
      let post;
      if (this.state.isNew) {
        post = await createPost(data);
        this.state.isNew = false;
        this.state.postId = post.id;
        history.replaceState(null, '', `/light/posts/${post.id}/edit`);
      } else {
        post = await updatePost(this.state.postId, data);
      }
      this.setState({ saving: false, saveStatus: 'saved', post });
      store.set('toast', { message: 'Post saved.', type: 'success' });
      setTimeout(() => this.setState({ saveStatus: null }), 3000);
    } catch (err) {
      this.setState({ saving: false, saveStatus: 'error' });
      store.set('toast', { message: err.message || 'Save failed.', type: 'error' });
    }
  }

  async _autosave() {
    if (this.state.saving || this.state.isNew) return;
    const data = this._collectFormData();
    if (!data.title) return;
    try {
      await updatePost(this.state.postId, data);
      this.setState({ saveStatus: 'saved' });
      setTimeout(() => this.setState({ saveStatus: null }), 2000);
    } catch {
      // Silent autosave failure.
    }
  }

  async _uploadAndInsert(file) {
    const list = this.$('#dropped-media-list');
    const indicator = document.createElement('p');
    indicator.className = 'upload-progress';
    indicator.textContent = `Uploading ${file.name}…`;
    list?.appendChild(indicator);

    try {
      const result = await uploadMedia(file, { post_id: this.state.postId || undefined });
      indicator.remove();

      // Insert markdown or path into content
      const editor = this.$('#content-editor');
      if (editor) {
        const isImage = file.type.startsWith('image/');
        const snippet = isImage
          ? `\n![${file.name}](${result.url})\n`
          : `\n[${file.name}](${result.url})\n`;
        const pos = editor.selectionStart ?? editor.value.length;
        editor.value = editor.value.slice(0, pos) + snippet + editor.value.slice(pos);
      }
    } catch (err) {
      indicator.textContent = `Upload failed: ${err.message || file.name}`;
      indicator.className = 'upload-error';
    }
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
