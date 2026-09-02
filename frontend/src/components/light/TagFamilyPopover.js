import { Component } from '../Component.js';
import { getTag } from '../../api/tags.js';
import { html, navigate } from '../../utils/helpers.js';

export class TagFamilyPopover extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = {
      loading: true,
      tag: null,
      error: null,
    };
  }

  render() {
    const { loading, tag, error } = this.state;
    if (loading) return html`<div class="tfp-popover loading">Loading family…</div>`;
    if (error) return html`<div class="tfp-popover error">${error}</div>`;
    if (!tag) return html``;

    const renderTagLink = (t) => html`<button class="tfp-tag-link" data-id="${t.id}">${t.name}</button>`;

    return html`
      <div class="tfp-popover">
        <div class="tfp-header">
          <div class="tfp-title">${tag.name}</div>
          <div class="tfp-path">${tag.name_path}</div>
        </div>
        <div class="tfp-body">
          ${tag.parents?.length ? html`
            <div class="tfp-section">
              <label>Parents</label>
              <div class="tfp-tags">${tag.parents.map(renderTagLink)}</div>
            </div>` : ''}
          
          ${tag.siblings?.length ? html`
            <div class="tfp-section">
              <label>Siblings</label>
              <div class="tfp-tags">${tag.siblings.map(renderTagLink)}</div>
            </div>` : ''}

          ${tag.children?.length ? html`
            <div class="tfp-section">
              <label>Children</label>
              <div class="tfp-tags">${tag.children.map(renderTagLink)}</div>
            </div>` : ''}
        </div>
        <div class="tfp-footer">
          <button class="btn btn-primary btn-sm tfp-view-posts-btn" data-slug="${tag.slug}">View Posts</button>
        </div>
      </div>
    `;
  }

  afterRender() {
    this.$$('.tfp-tag-link').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        this._load(id);
      });
    });

    this.container.querySelector('.tfp-view-posts-btn')?.addEventListener('click', (e) => {
      const slug = e.target.dataset.slug;
      navigate(`/light/posts?tag=${encodeURIComponent(slug)}`);
    });
  }

  mount() {
    super.mount();
    if (this.props.tagId) this._load(this.props.tagId);
  }

  async _load(id) {
    this.setState({ loading: true, error: null });
    try {
      const tag = await getTag(id);
      this.setState({ loading: false, tag });
    } catch (err) {
      this.setState({ loading: false, error: err.message });
    }
  }
}

/** Global helper to open the family popover at a position. */
export function openTagFamilyPopover(tagId, anchorEl) {
  const existing = document.querySelector('.tfp-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'tfp-overlay';
  document.body.appendChild(overlay);

  const rect = anchorEl.getBoundingClientRect();
  const popoverContainer = document.createElement('div');
  popoverContainer.className = 'tfp-container';
  popoverContainer.style.top = `${rect.bottom + window.scrollY + 8}px`;
  popoverContainer.style.left = `${rect.left + window.scrollX}px`;
  overlay.appendChild(popoverContainer);

  const component = new TagFamilyPopover(popoverContainer, { tagId });
  component.mount();

  const close = () => { component.unmount(); overlay.remove(); };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
}
