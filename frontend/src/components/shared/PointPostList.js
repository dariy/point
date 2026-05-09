import { BaseWebComponent } from '../BaseWebComponent.js';

/**
 * Proof-of-Concept component for Post List using Shadow DOM.
 */
export class PointPostList extends BaseWebComponent {
  constructor() {
    super();
    this.state = { posts: [] };
  }

  connectedCallback() {
    super.connectedCallback();
    this.subscribeBus('posts:updated', (posts) => {
      this.setState({ posts });
    });
  }

  render() {
    const { posts } = this.state;
    if (!posts.length) {
      return `<div part="empty">No posts found.</div>`;
    }

    return `
      <style>
        .container {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: var(--pt-spacing-gap, 12px);
          padding: var(--pt-spacing-base, 16px);
        }
        .post-card {
          border: 1px solid var(--pt-colors-muted, #ccc);
          padding: 8px;
        }
      </style>
      <div class="container" part="container">
        ${posts.map(post => `
          <div class="post-card" part="card">
            <h3 part="title">${this._escape(post.title)}</h3>
          </div>
        `).join('')}
      </div>
    `;
  }

  _escape(str) {
    if (!str) return '';
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return str.replace(/[&<>"']/g, (m) => map[m]);
  }
}
