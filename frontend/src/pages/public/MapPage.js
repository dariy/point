/**
 * MapPage — Leaflet map with tag location markers.
 *
 * Fetches: GET /api/tags (all tags with location data)
 * Props (from router): { params, query }
 *
 * Leaflet is vendored at /assets/vendor/leaflet/leaflet.js and
 * /assets/vendor/leaflet/leaflet.css — loaded dynamically if needed.
 */

import { Component } from '../../components/Component.js';
import { PublicHeader } from '../../components/public/PublicHeader.js';
import { PublicFooter } from '../../components/public/PublicFooter.js';
import { listTags } from '../../api/tags.js';
import { store } from '../../store.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';

const LEAFLET_JS  = '/assets/vendor/leaflet/leaflet.js';
const LEAFLET_CSS = '/assets/vendor/leaflet/leaflet.css';

/** Load Leaflet once, return the L global. */
async function loadLeaflet() {
  if (window.L) return window.L;

  // Inject CSS
  if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = LEAFLET_CSS;
    document.head.appendChild(link);
  }

  // Inject script
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LEAFLET_JS;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });

  return window.L;
}

export default class MapPage extends Component {
  constructor(container, props = {}) {
    super(container, props);
    this.state = { loading: true, tags: [], error: null };
    this._map = null;
  }

  render() {
    const { loading, error } = this.state;

    if (loading) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main" aria-busy="true">
            <div class="loading-spinner" aria-label="Loading map…"></div>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    if (error) {
      return `
        <div class="site-wrapper">
          <div id="header-mount"></div>
          <main class="site-main">
            <p class="error-message" role="alert">${escapeHtml(error)}</p>
          </main>
          <div id="footer-mount"></div>
        </div>`;
    }

    return `
      <div class="site-wrapper">
        <div id="header-mount"></div>
        <main class="site-main site-main--map">
          <div id="leaflet-map" class="map-container" aria-label="Tag locations map"></div>
        </main>
        <div id="footer-mount"></div>
      </div>`;
  }

  afterRender() {
    const settings = store.get('settings') || {};
    const navTags = store.get('navTags') || [];
    this.mountChild(PublicHeader, '#header-mount', { settings, navTags, currentPath: '/map' });
    this.mountChild(PublicFooter, '#footer-mount', { settings });

    if (!this.state.loading && !this.state.error) {
      this._initMap();
    }
  }

  beforeUnmount() {
    if (this._map) {
      this._map.remove();
      this._map = null;
    }
  }

  mount() {
    super.mount();
    this._load();
  }

  async _load() {
    try {
      const tags = await listTags({ with_counts: true });
      document.title = 'Map';
      this.setState({ loading: false, tags, error: null });
    } catch (err) {
      this.setState({ loading: false, tags: [], error: err.message || 'Failed to load map data.' });
    }
  }

  async _initMap() {
    const mapEl = this.$('#leaflet-map');
    if (!mapEl) return;

    let L;
    try {
      L = await loadLeaflet();
    } catch {
      mapEl.textContent = 'Failed to load map library.';
      return;
    }

    this._map = L.map(mapEl).setView([20, 0], 2);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 18,
    }).addTo(this._map);

    const { tags } = this.state;
    const tagsWithLocations = tags.filter(
      (t) => !t.is_hidden && t.locations?.length
    );

    tagsWithLocations.forEach((tag) => {
      tag.locations.forEach((loc) => {
        const marker = L.marker([loc.latitude, loc.longitude]).addTo(this._map);
        const label = `<strong>${tag.name}</strong><br><a href="/tag/${tag.slug}">View posts</a>`;
        marker.bindPopup(label);
        marker.on('click', () => marker.openPopup());
      });
    });
  }
}
