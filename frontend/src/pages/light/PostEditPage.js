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
import { MediaPickerDialog } from '../../components/light/MediaPickerDialog.js';
import { getPost, createPost, updatePost } from '../../api/posts.js';
import { uploadMedia, analyzeMedia, analyzeMediaByPath, listMedia, renameMedia } from '../../api/media.js';
import { logout } from '../../api/auth.js';
import { store } from '../../store.js';
import { escapeHtml, navigate, debounce } from '../../utils/helpers.js';
import { VisualEditor } from '../../components/light/VisualEditor.js';

const AUTOSAVE_MS = 30_000;

const IMAGE_PATH_RE = /^\/\d{4}\/\d{2}\/.+$/;

/**
 * Parse content string into an ordered list of image and text nodes.
 * Consecutive non-image lines are grouped into a single text node.
 * @param {string} content
 * @returns {Array<{type:'image',path:string}|{type:'text',text:string}>}
 */
function parseNodes(content) {
  const lines = (content || '').split('\n');
  const nodes = [];
  let textBuf = [];

  const flushText = () => {
    const text = textBuf.join('\n').trim();
    if (text) nodes.push({ type: 'text', text });
    textBuf = [];
  };

  for (const line of lines) {
    if (IMAGE_PATH_RE.test(line.trim())) {
      flushText();
      nodes.push({ type: 'image', path: line.trim() });
    } else {
      textBuf.push(line);
    }
  }
  flushText();
  return nodes;
}

/**
 * Serialize an ordered node list back to the plain-text content format.
 * @param {Array<{type:string,path?:string,text?:string}>} nodes
 * @returns {string}
 */
function serializeNodes(nodes) {
  return nodes.map((n) => (n.type === 'image' ? n.path : n.text)).join('\n');
}

/** Extract tag name strings from either a string[] or {name,slug}[] array. */
const toTagNames = (tags) => (tags || []).map((t) => (typeof t === 'string' ? t : t.name));

export default class PostEditPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    const id = props.params?.id ? parseInt(props.params.id, 10) : null;
    this.state = {
      loading: !!id,
      saving: false,
      analyzingField: null,   // 'title' | 'tags' | 'excerpt' | null
      post: null,
      error: null,
      isNew: !id,
      postId: id,
      editorMode: 'visual',
    };
    this._tags = [];
    this._nodes = []; // canonical node list for visual mode
    this._autosaveTimer = null;
    this._unmounted = false;
    this._analyzing = false;
    this._tagsInputRef = null;
    this._debouncedAutosave = debounce(this._autosave.bind(this), AUTOSAVE_MS);
    this._mediaPicker = null;
    this._visualEditorRef = null;
    this._dragCount = 0;
  }

  render() {
    const { loading, error, post, isNew, saving } = this.state;
    const analyzing = this._analyzing;

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
    const slug     = escapeHtml(p.slug || '');
    const content  = p.content || '';
    const status   = p.status || 'draft';
    const featured = p.is_featured || false;
    const thumb    = escapeHtml(p.thumbnail_path || '');
    const meta     = escapeHtml(p.meta_description || '');
    const fmt      = p.formatter || 'markdown';
    const excerpt  = p.excerpt || '';

    const statusOpts = ['draft', 'published', 'hidden', 'page'].map((s) =>
      `<option value="${s}"${status === s ? ' selected' : ''}>${escapeHtml(s.charAt(0).toUpperCase() + s.slice(1))}</option>`
    ).join('');

    const fmtOpts = ['markdown', 'html', 'raw'].map((f) =>
      `<option value="${f}"${fmt === f ? ' selected' : ''}>${escapeHtml(f)}</option>`
    ).join('');

    const saveLabel    = saving    ? 'Saving…'    : 'Save';
    const analyzeLabel = analyzing ? 'Analyzing…' : 'Analyze';
    const { analyzingField } = this.state;
    const aiBtnDisabled = analyzing || !!analyzingField;
    const aiBtn = (field) =>
      `<button class="field-ai-btn" data-field="${field}" type="button"
               title="Fill with AI" ${aiBtnDisabled ? 'disabled' : ''}
               aria-label="AI fill ${field}">✦</button>`;

    const modeToggle = `
  <div class="editor-mode-toggle">
    <button id="mode-text-btn" type="button"
            class="${this.state.editorMode === 'text' ? 'active' : ''}">Text</button>
    <button id="mode-visual-btn" type="button"
            class="${this.state.editorMode === 'visual' ? 'active' : ''}">Visual</button>
  </div>`;

    const contentArea = this.state.editorMode === 'visual'
      ? `<div id="visual-editor-mount"></div>`
      : `<textarea id="content-editor" class="editor-content"
               rows="24" placeholder="Write your post content here\u2026">${escapeHtml(content)}</textarea>`;

    return `
      <div class="light-layout">
        <div id="sidebar-mount"></div>
        <div class="light-main">
          <header class="light-header">
            <h1>${isNew ? 'New Post' : 'Edit Post'}</h1>
            <div class="header-actions">
              <button id="analyze-btn" class="btn btn-secondary" type="button"
                      ${analyzing ? 'disabled' : ''}>${escapeHtml(analyzeLabel)}</button>
              <button id="save-btn" class="btn btn-primary" type="button"
                      ${saving ? 'disabled' : ''}>${escapeHtml(saveLabel)}</button>
              <a href="/light/posts" class="btn btn-secondary">Cancel</a>
            </div>
          </header>
          <main class="light-content editor-full-width">
            <div class="editor-main">
              <div class="title-row">
                <input type="checkbox" id="featured-check" style="display:none"
                       ${featured ? 'checked' : ''}>
                <button id="featured-toggle" type="button"
                        class="featured-btn${featured ? ' is-featured' : ''}"
                        title="${featured ? 'Unmark as featured' : 'Mark as featured'}">
                  ${featured ? '★' : '☆'}
                </button>
                <select id="status-select" class="status-select badge-${escapeHtml(status)}">
                  ${statusOpts}
                </select>
                <div class="title-input-wrapper">
                  <input type="text" id="title-input" class="form-input editor-title"
                         placeholder="Post title" value="${title}" required>
                  ${aiBtn('title')}
                </div>
              </div>

              <div class="slug-row">
                <span class="slug-prefix">/post/</span>
                <input type="text" id="slug-input" class="form-input editor-slug"
                       placeholder="post-slug" value="${slug}" spellcheck="false">
              </div>

              <div class="tags-row">
                <div class="tags-input-wrapper">
                  <div id="tags-input-mount" class="tags-row-input"></div>
                  ${aiBtn('tags')}
                </div>
              </div>

              <div class="form-group excerpt-row">
                <textarea id="excerpt-editor" class="form-input editor-excerpt"
                          rows="3" placeholder="Post excerpt…">${escapeHtml(excerpt)}</textarea>
                ${aiBtn('excerpt')}
              </div>

              <div class="form-group">
                ${modeToggle}
                ${contentArea}
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

    // Media picker dialog (created once, reused across open/close cycles)
    if (!this._mediaPicker) {
      this._mediaPicker = new MediaPickerDialog({
        onConfirm: (items) => this._insertMediaPaths(items),
      });
      this._mediaPicker.mount();
    }

    this.$('#mode-text-btn')?.addEventListener('click', () => this._switchMode('text'));
    this.$('#mode-visual-btn')?.addEventListener('click', () => this._switchMode('visual'));

    // Per-field AI fill buttons
    this.container.querySelectorAll('.field-ai-btn').forEach((btn) => {
      btn.addEventListener('click', () => this._analyzeField(btn.dataset.field));
    });

    // Tags input
    this._tagsInputRef = this.mountChild(TagsInput, '#tags-input-mount', {
      tags: toTagNames(this.state.post?.tags),
      onChange: (tags) => { this._tags = tags; },
    });
    this._tags = toTagNames(this.state.post?.tags);

    // Save button
    const saveBtn = this.$('#save-btn');
    saveBtn?.addEventListener('click', () => this._save());

    // Analyze button — uses first image path from content, or opens picker
    const analyzeBtn = this.$('#analyze-btn');
    analyzeBtn?.addEventListener('click', () => {
      const path = this._extractImagePath();
      if (path) {
        this._handleAnalyze({ path });
      } else {
        this._mediaPicker.open((items) => this._handleAnalyze(items[0]));
      }
    });

    // Featured star toggle
    const featuredToggle = this.$('#featured-toggle');
    const featuredCheck  = this.$('#featured-check');
    featuredToggle?.addEventListener('click', () => {
      const newVal = !featuredCheck.checked;
      featuredCheck.checked = newVal;
      featuredToggle.textContent = newVal ? '★' : '☆';
      featuredToggle.classList.toggle('is-featured', newVal);
      featuredToggle.title = newVal ? 'Unmark as featured' : 'Mark as featured';
      this._autoSaveField({ is_featured: newVal });
    });

    // Status pill — auto-save on change
    const statusSelect = this.$('#status-select');
    statusSelect?.addEventListener('change', () => {
      const newStatus = statusSelect.value;
      statusSelect.className = `status-select badge-${newStatus}`;
      this._autoSaveField({ status: newStatus });
    });

    // Auto-save on content change
    const titleInput = this.$('#title-input');
    const slugInput = this.$('#slug-input');
    const contentEditor = this.$('#content-editor');
    [titleInput, slugInput, contentEditor].forEach((el) => {
      el?.addEventListener('input', () => this._debouncedAutosave());
    });

    if (this.state.editorMode === 'visual') {
      this._mountVisualEditor();
    }

    // Window-level drag-and-drop media upload
    // Remove stale listeners from any previous render before re-attaching.
    document.removeEventListener('dragenter', this._onDragEnter);
    document.removeEventListener('dragleave', this._onDragLeave);
    document.removeEventListener('dragover', this._onDragOver);
    document.removeEventListener('drop', this._onDrop);
    this._dragCount = 0;
    this._onDragEnter = () => {
      this._dragCount++;
      document.body.classList.add('drag-active');
    };
    this._onDragLeave = () => {
      this._dragCount--;
      if (this._dragCount === 0) document.body.classList.remove('drag-active');
    };
    this._onDragOver = (e) => { e.preventDefault(); };
    this._onDrop = (e) => {
      e.preventDefault();
      this._dragCount = 0;
      document.body.classList.remove('drag-active');
      const files = Array.from(e.dataTransfer.files).filter(
        (f) => f.type.startsWith('image/') || f.type.startsWith('video/')
      );
      files.forEach((f) => this._uploadAndInsert(f));
    };
    document.addEventListener('dragenter', this._onDragEnter);
    document.addEventListener('dragleave', this._onDragLeave);
    document.addEventListener('dragover', this._onDragOver);
    document.addEventListener('drop', this._onDrop);
  }

  beforeUnmount() {
    this._unmounted = true; // Prevent pending debounced autosave from firing after navigation
    clearTimeout(this._autosaveTimer);
    document.removeEventListener('dragenter', this._onDragEnter);
    document.removeEventListener('dragleave', this._onDragLeave);
    document.removeEventListener('dragover', this._onDragOver);
    document.removeEventListener('drop', this._onDrop);
    document.body.classList.remove('drag-active');
    this._mediaPicker?.destroy();
    this._mediaPicker = null;
    this._visualEditorRef = null;
  }

  _insertMediaPaths(items) {
    if (!items.length) return;
    if (this.state.editorMode === 'visual') {
      this._nodes = [
        ...this._nodes,
        ...items.map((item) => ({ type: 'image', path: item.path })),
      ];
      if (this._visualEditorRef) {
        this._visualEditorRef.setProps({ nodes: this._nodes });
      } else if (this.$('#visual-editor-mount')) {
        this._mountVisualEditor();
      }
      return;
    }
    const editor = this.$('#content-editor');
    if (!editor) return;
    const paths = items.map((item) => item.path).join('\n');
    editor.value = editor.value.trimEnd() + '\n' + paths;
    editor.scrollTop = editor.scrollHeight;
  }

  _mountVisualEditor() {
    if (this._visualEditorRef) {
      this._visualEditorRef.unmount();
      const idx = this._children.indexOf(this._visualEditorRef);
      if (idx !== -1) this._children.splice(idx, 1);
      this._visualEditorRef = null;
    }
    this._visualEditorRef = this.mountChild(VisualEditor, '#visual-editor-mount', {
      nodes: this._nodes,
      onChange: (nodes) => {
        this._nodes = nodes;
        this._visualEditorRef?.setProps({ nodes });
        this._debouncedAutosave();
      },
      onInput: () => {
        this._debouncedAutosave();
      },
      onAddMedia: (index) => {
        this._mediaPicker.open((items) => {
          if (!items.length) return;
          const newNodes = items.map((item) => ({ type: 'image', path: item.path }));
          this._nodes.splice(index, 0, ...newNodes);
          this._visualEditorRef?.setProps({ nodes: this._nodes });
          this._debouncedAutosave();
        });
      },
      onRename: (oldPath, newFilename) => this._handleRename(oldPath, newFilename),
    });
  }

  async _handleRename(oldPath, newFilename) {
    const lastSlash = oldPath.lastIndexOf('/');
    const folder = oldPath.slice(1, lastSlash);    // strip leading /: "2026/02"
    try {
      const result = await listMedia({ folder, per_page: 200 });
      const item = (result.media || []).find((m) => m.path === oldPath);
      if (!item) throw new Error(`Media not found: ${oldPath}`);

      const updated = await renameMedia(item.id, newFilename);
      const newPath = updated.path;

      this._nodes = this._nodes.map((n) =>
        n.type === 'image' && n.path === oldPath ? { ...n, path: newPath } : n
      );
      this._visualEditorRef?.setProps({ nodes: this._nodes });
      this._debouncedAutosave();
      store.set('toast', { message: 'File renamed.', type: 'success' });
    } catch (err) {
      store.set('toast', { message: err.message || 'Rename failed.', type: 'error' });
      throw err;
    }
  }

  _switchMode(targetMode) {
    if (this.state.editorMode === targetMode) return;

    if (targetMode === 'visual') {
      const content = this.$('#content-editor')?.value ?? (this.state.post?.content || '');
      this._nodes = parseNodes(content);
      this.setState({ editorMode: 'visual' });
    } else {
      // visual → text: serialize current nodes (reads live textarea values if editor mounted)
      const content = this._visualEditorRef?.serializeNodes() ?? serializeNodes(this._nodes);
      const post = { ...(this.state.post || {}), content };
      this.setState({ editorMode: 'text', post });
    }
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
      // Normalize status to lowercase to guard against unexpected API casing.
      if (post.status) post.status = post.status.toLowerCase();
      this._tags = toTagNames(post.tags);
      const nodes = parseNodes(post.content);
      this._nodes = nodes;
      this.setState({ loading: false, post, error: null, editorMode: 'visual' });
    } catch (err) {
      this.setState({ loading: false, error: err.message || 'Post not found.' });
    }
  }

  _collectFormData() {
    return {
      title:            (this.$('#title-input')?.value || '').trim(),
      slug:             (this.$('#slug-input')?.value || '').trim() || null,
      excerpt:          (this.$('#excerpt-editor')?.value || '').trim() || null,
      content: this.state.editorMode === 'visual'
        ? (this._visualEditorRef?.serializeNodes() ?? serializeNodes(this._nodes))
        : (this.$('#content-editor')?.value || ''),
      // Prefer DOM value; fall back to known state to prevent accidental reset to 'draft'.
      status:           this.$('#status-select')?.value || this.state.post?.status || 'draft',
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

    this.setState({ saving: true });
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
      this.setState({ saving: false, post });
      store.set('toast', { message: 'Post saved.', type: 'success' });
    } catch (err) {
      this.setState({ saving: false });
      store.set('toast', { message: err.message || 'Save failed.', type: 'error' });
    }
  }

  async _autosave() {
    if (this._unmounted || this.state.saving || this.state.isNew) return;
    const data = this._collectFormData();
    if (!data.title) return;
    try {
      await updatePost(this.state.postId, data);
    } catch {
      // Silent autosave failure.
    }
  }

  /** Extract first image path from the content textarea. */
  _extractImagePath() {
    if (this.state.editorMode === 'visual') {
      return this._nodes.find((n) => n.type === 'image')?.path ?? null;
    }
    const content = this.$('#content-editor')?.value || '';
    const match = content.match(
      /(?:^|["'\s(])(\/\d{4}\/\d{2}\/.+?\.(?:jpe?g|png|webp|gif|avif|heic|tiff|bmp))(?:["'\s)]|$)/i
    );
    return match ? match[1] : null;
  }

  _analyzeField(field) {
    if (this._analyzing || this.state.analyzingField) return;
    const path = this._extractImagePath();
    if (path) {
      this._doAnalyzeField(field, { path });
    } else {
      this._mediaPicker.open((items) => {
        if (items?.[0]) this._doAnalyzeField(field, items[0]);
      });
    }
  }

  async _doAnalyzeField(field, item) {
    if (!item) return;
    // Disable all field AI buttons directly — avoid setState re-render which discards unsaved input.
    this.$$(`.field-ai-btn`).forEach(b => { b.disabled = true; });
    try {
      const result = item.id
        ? await analyzeMedia(item.id)
        : await analyzeMediaByPath(item.path);

      const post = { ...(this.state.post || {}) };
      if (field === 'title' && result.title) {
        post.title = result.title;
      } else if (field === 'tags' && result.tags?.length) {
        const currentTags = this._tags || [];
        const mergedTags = [
          ...currentTags,
          ...(result.tags || []).filter((t) => !currentTags.includes(t)),
        ];
        this._tags = mergedTags;
        post.tags = mergedTags.map((name) => ({ name, slug: name }));
      } else if (field === 'excerpt' && result.excerpt) {
        post.excerpt = result.excerpt;
      }

      store.set('toast', { message: `${field.charAt(0).toUpperCase() + field.slice(1)} filled.`, type: 'success' });
      this.setState({ analyzingField: null, post });
    } catch (err) {
      store.set('toast', { message: err.message || 'Analysis failed.', type: 'error' });
      this.setState({ analyzingField: null });
    }
  }

  async _handleAnalyze(item) {
    if (!item || this._analyzing) return;

    // Snapshot current form values before doing anything — avoids re-render discarding typed input.
    const snap = this._collectFormData();

    // Disable the analyze button directly without calling setState (which would re-render and discard input).
    this._analyzing = true;
    const analyzeBtn = this.$('#analyze-btn');
    if (analyzeBtn) { analyzeBtn.disabled = true; analyzeBtn.textContent = 'Analyzing…'; }
    try {
      const result = item.id
        ? await analyzeMedia(item.id)
        : await analyzeMediaByPath(item.path);

      const mergedTags = [
        ...snap.tags,
        ...(result.tags || []).filter((t) => !snap.tags.includes(t)),
      ];

      const post = {
        ...(this.state.post || {}),
        title:   snap.title   || result.title   || '',
        excerpt: snap.excerpt || result.excerpt  || null,
        content: snap.content,
        slug:    snap.slug,
        tags:    mergedTags.map((name) => ({ name, slug: name })),
      };
      if (this.state.editorMode === 'visual') this._nodes = parseNodes(post.content);

      store.set('toast', { message: 'Analysis complete.', type: 'success' });
      this._analyzing = false;
      this.setState({ post });
    } catch (err) {
      // Restore the user's form values even on failure.
      const post = {
        ...(this.state.post || {}),
        title:   snap.title,
        excerpt: snap.excerpt,
        content: snap.content,
        slug:    snap.slug,
        tags:    snap.tags.map((name) => ({ name, slug: name })),
      };
      if (this.state.editorMode === 'visual') this._nodes = parseNodes(post.content);
      store.set('toast', { message: err.message || 'Analysis failed.', type: 'error' });
      this._analyzing = false;
      this.setState({ post });
    }
  }

  async _autoSaveField(patch) {
    if (this.state.isNew || this.state.saving) return;
    const formData = this._collectFormData();
    const fullData = { ...formData, ...patch };
    try {
      const post = await updatePost(this.state.postId, fullData);
      this.state.post = post;
      store.set('toast', { message: 'Saved.', type: 'success' });
    } catch (err) {
      store.set('toast', { message: err.message || 'Auto-save failed.', type: 'error' });
    }
  }

  async _uploadAndInsert(file) {
    try {
      const result = await uploadMedia(file, { post_id: this.state.postId || undefined });
      if (this.state.editorMode === 'visual') {
        this._insertMediaPaths([{ path: result.path }]);
      } else {
        const editor = this.$('#content-editor');
        if (editor) {
          editor.value = editor.value.trimEnd() + `\n${result.path}`;
          editor.scrollTop = editor.scrollHeight;
        }
      }
    } catch (err) {
      store.set('toast', { message: `Upload failed: ${err.message || file.name}`, type: 'error' });
    }
  }

  async _handleLogout() {
    try { await logout(); } catch { /* ignore */ }
    store.set('user', null);
    navigate('/light/login', { replace: true });
  }
}
