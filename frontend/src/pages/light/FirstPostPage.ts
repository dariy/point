/**
 * FirstPostPage — the full-screen "Add your first photos" flow that opens
 * after setup (US-005). One upload, an optional title, one Publish.
 *
 * Steps: pick (drop zone + file button) → review (order, remove, title) →
 * done (link to the post + "Choose a look").
 *
 * Uploads go through the normal upload API. The post content is the media
 * paths, one per line — the same form the editor writes — so the server's
 * media visibility rules apply on publish without special cases.
 */

import { Component } from '../../components/Component.ts';
import { html } from '../../utils/helpers.ts';
import { uploadMultiple } from '../../api/media.ts';
import type { Media } from '../../api/media.ts';
import { createPost } from '../../api/posts.ts';
import type { Post } from '../../api/posts.ts';
import { thumbUrl } from '../../utils/mediaUrl.ts';

/** Where "Skip for now" lands and where the reminder banner lives. */
export const FIRST_POST_PATH = '/light/first-post';

/** localStorage key: the owner closed the dashboard reminder. */
export const FIRST_POST_BANNER_DISMISSED = 'first_post_banner_dismissed';

/**
 * Move the item at `from` by `delta` places, clamped to the list.
 * @returns a new array; the input is not changed
 */
export function moveItem<T>(items: T[], from: number, delta: number): T[] {
  const to = Math.max(0, Math.min(items.length - 1, from + delta));
  if (to === from || from < 0 || from >= items.length) return items.slice();
  const out = items.slice();
  const [it] = out.splice(from, 1);
  out.splice(to, 0, it);
  return out;
}

/** The post body for the chosen photos: one media path per line. */
export function firstPostContent(media: Pick<Media, 'path'>[]): string {
  return media.map((m) => m.path).join('\n');
}

interface State {
  step: 'pick' | 'review' | 'done';
  busy: boolean;
  error: string | null;
  media: Media[];
  title: string;
  post: Post | null;
}

export default class FirstPostPage extends Component {
  declare state: State;

  constructor(container: HTMLElement, props = {}) {
    super(container, props);
    this.state = { step: 'pick', busy: false, error: null, media: [], title: '', post: null };
  }

  render() {
    const { step, error } = this.state;
    const body = step === 'done' ? this._renderDone()
      : step === 'review' ? this._renderReview()
      : this._renderPick();
    return html`
      <div class="setup-page-container first-post-page" data-step="${step}">
        <div class="card first-post-card">
          ${error ? html`<div class="error-message" role="alert">${error}</div>` : ''}
          ${body}
        </div>
      </div>
    `;
  }

  _renderPick() {
    const { busy } = this.state;
    return html`
      <div class="card-header">
        <h2>Add your first photos</h2>
        <p class="text-muted text-small">They become your first post. You can change everything later.</p>
      </div>
      <div class="card-body">
        <label class="first-post-drop ${busy ? 'is-busy' : ''}" id="first-post-drop">
          <input type="file" id="first-post-files" accept="image/*" multiple hidden ${busy ? 'disabled' : ''}>
          <span class="first-post-drop-text">${busy ? 'Uploading…' : 'Drop photos here'}</span>
          <span class="btn btn-primary" role="button">${busy ? 'Please wait' : 'Choose photos'}</span>
        </label>
        <p class="first-post-skip"><a href="/light" id="first-post-skip">Skip for now</a></p>
      </div>
    `;
  }

  _renderReview() {
    const { media, title, busy } = this.state;
    const last = media.length - 1;
    return html`
      <div class="card-header">
        <h2>Your first post</h2>
        <p class="text-muted text-small">Put the photos in order, then publish.</p>
      </div>
      <div class="card-body">
        <div class="form-group">
          <label class="form-label" for="first-post-title">Title (optional)</label>
          <input type="text" id="first-post-title" class="form-input" value="${title}"
                 ${busy ? 'disabled' : ''}>
        </div>
        <ol class="first-post-list">
          ${media.map((m, i) => html`
            <li class="first-post-item" data-path="${m.path}">
              <img src="${thumbUrl(m.path)}" alt="${m.alt_text || m.filename || ''}" loading="lazy">
              <span class="first-post-item-actions">
                <button type="button" class="btn btn-icon btn-sm" data-move="-1" data-index="${String(i)}"
                        aria-label="Move earlier" ${i === 0 || busy ? 'disabled' : ''}>↑</button>
                <button type="button" class="btn btn-icon btn-sm" data-move="1" data-index="${String(i)}"
                        aria-label="Move later" ${i === last || busy ? 'disabled' : ''}>↓</button>
                <button type="button" class="btn btn-icon btn-sm" data-remove="${String(i)}"
                        aria-label="Remove" ${busy ? 'disabled' : ''}>×</button>
              </span>
            </li>`)}
        </ol>
        <div class="setup-submit-wrapper">
          <button type="button" id="first-post-publish" class="btn btn-primary setup-submit-btn"
                  ${busy || media.length === 0 ? 'disabled' : ''}>
            ${busy ? 'Publishing…' : 'Publish'}
          </button>
        </div>
        <p class="first-post-skip"><a href="/light" id="first-post-skip">Skip for now</a></p>
      </div>
    `;
  }

  _renderDone() {
    const { post } = this.state;
    const url = post?.slug ? `/posts/${post.slug}` : '/';
    return html`
      <div class="card-header">
        <h2>Your first post is live</h2>
        <p class="text-muted text-small">Next, give your site its own look.</p>
      </div>
      <div class="card-body">
        <div class="setup-submit-wrapper first-post-done-actions">
          <a href="/style" id="first-post-look" class="btn btn-primary setup-submit-btn">Choose a look</a>
          <a href="${url}" id="first-post-view" class="btn btn-text">View your post</a>
        </div>
      </div>
    `;
  }

  afterRender() {
    const input = this.$('#first-post-files') as HTMLInputElement | null;
    input?.addEventListener('change', () => {
      if (input.files?.length) this._upload([...input.files]);
    });

    const drop = this.$('#first-post-drop');
    if (drop) {
      drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('is-over');
        const files = [...((e as DragEvent).dataTransfer?.files || [])];
        if (files.length) this._upload(files);
      });
    }

    const titleInput = this.$('#first-post-title') as HTMLInputElement | null;
    titleInput?.addEventListener('input', () => { this.state.title = titleInput.value; });

    this.container.querySelectorAll<HTMLButtonElement>('[data-move]').forEach((b) =>
      b.addEventListener('click', () => this.setState({
        media: moveItem(this.state.media, Number(b.dataset.index), Number(b.dataset.move)),
      })));
    this.container.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach((b) =>
      b.addEventListener('click', () => {
        const media = this.state.media.filter((_, i) => i !== Number(b.dataset.remove));
        this.setState({ media, step: media.length ? 'review' : 'pick' });
      }));

    this.$('#first-post-publish')?.addEventListener('click', () => this._publish());
  }

  async _upload(files: File[]) {
    if (this.state.busy) return;
    this.setState({ busy: true, error: null });
    try {
      const res = await uploadMultiple(files);
      const media = [...this.state.media, ...(res.uploaded || [])];
      const error = res.total_failed
        ? `${res.total_failed} file(s) could not be uploaded.`
        : null;
      this.setState({ busy: false, media, error, step: media.length ? 'review' : 'pick' });
    } catch (err) {
      this.setState({ busy: false, error: (err as Error).message || 'Upload failed.' });
    }
  }

  async _publish() {
    const { media, title, busy } = this.state;
    if (busy || !media.length) return;
    this.setState({ busy: true, error: null });
    try {
      const post = await createPost({
        title: title.trim(),
        content: firstPostContent(media),
        status: 'published',
      });
      this.setState({ busy: false, post, step: 'done' });
    } catch (err) {
      this.setState({ busy: false, error: (err as Error).message || 'Could not publish.' });
    }
  }
}
