import { BaseWebComponent } from './BaseWebComponent.js';
import { GestureController } from '../../utils/gestures.js';

/**
 * Proof-of-Concept component for Lightbox using Shadow DOM and Passive Gestures.
 */
export class PointLightbox extends BaseWebComponent {
  constructor() {
    super();
    this.state = { isOpen: false, currentImage: null };
    this._gestures = null;
  }

  connectedCallback() {
    super.connectedCallback();
    this.subscribeBus('lightbox:open', (data) => {
      this.setState({ isOpen: true, currentImage: data.url });
    });
  }

  afterRender() {
    if (this.state.isOpen) {
      const container = this.shadow.querySelector('.lightbox-overlay');
      if (container && !this._gestures) {
        this._gestures = new GestureController(container, {
          onSwipeCommit: (dir) => {
            window.Point.emit('lightbox:swipe', { direction: dir });
          }
        });
      }
    } else if (this._gestures) {
      this._gestures.destroy();
      this._gestures = null;
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._gestures) {
      this._gestures.destroy();
    }
  }

  render() {
    if (!this.state.isOpen) return '';

    return `
      <style>
        .lightbox-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0,0,0,0.9);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          touch-action: pan-y; /* Support horizontal swipe without preventDefault */
        }
        img {
          max-width: 90%;
          max-height: 90%;
          object-fit: contain;
        }
      </style>
      <div class="lightbox-overlay" part="overlay">
        <img src="${this.state.currentImage}" part="image" />
      </div>
    `;
  }
}
