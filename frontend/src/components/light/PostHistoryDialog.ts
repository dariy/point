/**
 * PostHistoryDialog — the revision history of a post, opened from the editor
 * (NF-9).
 *
 * Two views in one modal:
 *  - the list: each revision with its date and kind, newest first;
 *  - the compare view: how one revision differs from the post in the editor
 *    (title, body text, tags, custom CSS), with "Restore".
 *
 * The dialog only reads. "Restore" goes to the `onRestore` prop: the editor
 * asks for confirmation, saves unsaved edits, restores and reloads itself.
 *
 * One instance is one opening: open() appends the overlay to <body>, close()
 * removes it.
 *
 * Usage:
 *   const dialog = new PostHistoryDialog({ postId, getCurrent, onRestore });
 *   dialog.open();
 */

import { Component } from '../Component.ts';
import { acquireScrollLock, releaseScrollLock } from '../../utils/scrollLock.ts';
import { html, setHTML } from '../../utils/helpers.ts';
import { setToast } from '../../store.ts';
import { formatDatetime } from '../../utils/formatters.ts';
import { lineDiff, foldUnchanged } from '../../utils/lineDiff.ts';
import {
  getPostRevision,
  listPostRevisions,
  type PostRevision,
  type PostRevisionSummary,
} from '../../api/posts.ts';

/** The fields of the post in the editor that the compare view reads. */
export interface PostHistoryCurrent {
  title: string;
  content: string;
  tags: string[];
  css: string;
}

export interface PostHistoryDialogProps {
  postId: number;
  /** The post as it is in the editor now, unsaved edits included. */
  getCurrent: () => PostHistoryCurrent;
  /** The user clicked "Restore" on this revision. */
  onRestore: (revision: PostRevision) => void;
  /** The dialog closed. */
  onClose?: () => void;
}

/** The label of each revision kind in the list. */
export const REVISION_KIND_LABELS: Record<string, string> = {
  manual: 'Saved',
  publish: 'Published',
  autosave: 'Autosave',
  restore: 'Restored',
};

/** The label of a revision kind; an unknown kind shows as it is stored. */
export function revisionKindLabel(kind: string): string {
  return REVISION_KIND_LABELS[kind] ?? kind;
}

export class PostHistoryDialog extends Component<PostHistoryDialogProps> {
  _keyHandler: ((e: KeyboardEvent) => void) | null;

  constructor(props: PostHistoryDialogProps) {
    const container = document.createElement('div');
    container.className = 'modal-overlay post-history-overlay';
    container.setAttribute('aria-modal', 'true');
    container.setAttribute('role', 'dialog');
    container.setAttribute('aria-label', 'History');
    document.body.appendChild(container);
    super(container, props);
    this.state = {
      view: 'list',
      loading: true,
      error: null,
      revisions: [] as PostRevisionSummary[],
      revision: null as PostRevision | null,
      loadingRevision: false,
    };
    this._keyHandler = null;
  }

  actions = {
    close(this: PostHistoryDialog) { this.close(); },
    back(this: PostHistoryDialog) { this.setState({ view: 'list', revision: null }); },
    compare(this: PostHistoryDialog, _e: Event, el: Element) {
      this._openRevision(Number(el.getAttribute('data-rev')));
    },
    restore(this: PostHistoryDialog) {
      if (this.state.revision) this.props.onRestore(this.state.revision);
    },
  };

  render() {
    return html`<div class="modal post-history-modal">${this._renderInner()}</div>`;
  }

  /**
   * A change of view rewrites the inside of the modal and keeps the modal
   * element. A rebuilt .modal plays its slide-in animation again, so each
   * change of view would flash.
   */
  update() {
    const modal = this.$('.post-history-modal');
    if (!modal) return false;
    setHTML(modal, this._renderInner());
    return true;
  }

  _renderInner() {
    const { view, revision } = this.state;
    const comparing = view === 'compare' && revision;
    return html`
        <header class="modal-header post-history-header">
          ${comparing ? html`<button class="btn btn-sm btn-secondary" type="button" data-action="back">← Back</button>` : ''}
          <h3>${comparing ? formatDatetime(revision.created_at) : 'History'}</h3>
          <button class="modal-close" type="button" data-action="close" aria-label="Close">\xd7</button>
        </header>
        <div class="modal-body post-history-body">
          ${comparing ? this._renderCompare(revision) : this._renderList()}
        </div>
        ${comparing ? html`
          <footer class="modal-footer">
            <button class="btn btn-secondary" type="button" data-action="back">Cancel</button>
            <button class="btn btn-primary" type="button" data-action="restore" id="post-history-restore">Restore</button>
          </footer>` : ''}`;
  }

  _renderList() {
    const { loading, error, revisions } = this.state;
    if (loading) return html`<div class="loading-spinner" aria-label="Loading…"></div>`;
    if (error) return html`<p class="post-history-empty">${error}</p>`;
    if (!revisions.length) {
      return html`<p class="post-history-empty">No revisions yet. A revision is kept at each save and at each publish.</p>`;
    }
    return html`
      <ul class="post-history-list">
        ${(revisions as PostRevisionSummary[]).map(r => html`
          <li>
            <button class="post-history-item" type="button" data-action="compare" data-rev="${r.id}">
              <span class="post-history-date">${formatDatetime(r.created_at)}</span>
              <span class="post-history-kind post-history-kind--${r.kind}">${revisionKindLabel(r.kind)}</span>
              <span class="post-history-title">${r.title}</span>
            </button>
          </li>`)}
      </ul>`;
  }

  _renderCompare(revision: PostRevision) {
    const current = this.props.getCurrent();
    const sections = [];

    if (current.title !== revision.title) {
      sections.push(html`
        <section class="post-history-section">
          <h4>Title</h4>
          <div class="post-history-diff">
            <div class="post-history-line is-del">${current.title}</div>
            <div class="post-history-line is-add">${revision.title}</div>
          </div>
        </section>`);
    }

    const tagsNow = new Set(current.tags);
    const tagsThen = new Set(revision.tags ?? []);
    const removed = current.tags.filter(t => !tagsThen.has(t));
    const added = (revision.tags ?? []).filter(t => !tagsNow.has(t));
    if (removed.length || added.length) {
      sections.push(html`
        <section class="post-history-section">
          <h4>Tags</h4>
          <div class="post-history-tags">
            ${removed.map(t => html`<span class="post-history-tag is-del">${t}</span>`)}
            ${added.map(t => html`<span class="post-history-tag is-add">${t}</span>`)}
          </div>
        </section>`);
    }

    if (current.content !== revision.content) {
      sections.push(this._renderTextDiff('Body', current.content, revision.content));
    }
    if ((current.css || '') !== (revision.css || '')) {
      sections.push(this._renderTextDiff('Custom CSS', current.css || '', revision.css || ''));
    }

    if (!sections.length) {
      return html`<p class="post-history-empty">This revision is the same as the post in the editor.</p>`;
    }
    return html`
      <p class="post-history-legend">
        <span class="post-history-line is-del">In the editor now</span>
        <span class="post-history-line is-add">In this revision</span>
      </p>
      ${sections}`;
  }

  _renderTextDiff(label: string, now: string, then: string) {
    const lines = foldUnchanged(lineDiff(now, then));
    return html`
      <section class="post-history-section">
        <h4>${label}</h4>
        <div class="post-history-diff">
          ${lines.map(l => l.op === 'fold'
            ? html`<div class="post-history-line is-fold">${l.count} unchanged ${l.count === 1 ? 'line' : 'lines'}</div>`
            : html`<div class="post-history-line is-${l.op}">${l.text || ' '}</div>`)}
        </div>
      </section>`;
  }

  async _load() {
    try {
      const { revisions } = await listPostRevisions(this.props.postId);
      this.setState({ loading: false, revisions: revisions ?? [] });
    } catch (err) {
      this.setState({ loading: false, error: (err as Error).message || 'Could not load the history.' });
    }
  }

  async _openRevision(id: number) {
    if (!id || this.state.loadingRevision) return;
    this.state.loadingRevision = true;
    try {
      const revision = await getPostRevision(this.props.postId, id);
      this.setState({ loadingRevision: false, view: 'compare', revision });
      this.$('.post-history-body')?.scrollTo?.(0, 0);
    } catch (err) {
      this.state.loadingRevision = false;
      setToast({ message: (err as Error).message || 'Could not load the revision.', type: 'error' });
    }
  }

  open() {
    this.mount();
    this.container.classList.add('active');
    acquireScrollLock(this);
    // Escape goes back from the compare view, then closes. A dialog opened on
    // top of this one (the restore confirmation) takes its own Escape.
    this._keyHandler = (e) => {
      if (e.key !== 'Escape' || document.body.lastElementChild !== this.container) return;
      if (this.state.view === 'compare') this.setState({ view: 'list', revision: null });
      else this.close();
    };
    document.addEventListener('keydown', this._keyHandler);
    this.container.addEventListener('click', (e) => {
      if (e.target === this.container) this.close();
    });
    this._load();
  }

  close() {
    if (this._unmounted) return;
    this.unmount();
    this.container.remove();
    this.props.onClose?.();
  }

  beforeUnmount() {
    releaseScrollLock(this);
    if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler);
    this._keyHandler = null;
  }
}
