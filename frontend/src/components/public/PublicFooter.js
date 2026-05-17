/**
 * Public site footer — copyright, pagination slot (normal), or post tags (immersive).
 *
 * Props:
 *   settings      {object}    Public blog settings (blog_title, author_name)
 *   immersiveTags {object[]}  When non-empty, renders as immersive tag bar instead of pagination slot
 */

import { Component } from '../Component.js';
import { escapeHtml, navigate } from '../../utils/helpers.js';
import { renderTagLink, buildTagIndex, setupTagFlyout, createHotZone } from '../../utils/tags.js';
import {
  CHEVRON_SVG,
  EXIF_SHUTTER_SVG, EXIF_APERTURE_SVG, EXIF_FOCAL_SVG,
  EXIF_ISO_SVG, EXIF_CAMERA_SVG, EXIF_MODEL_SVG,
} from '../../utils/icons.js';
import { store } from '../../store.js';

// Fields shown publicly, in display order.
// icon: SVG string; fmt: optional value formatter.
const EXIF_FIELDS = [
  { key: 'ExposureTime',    icon: EXIF_SHUTTER_SVG,  label: 'Shutter',  fmt: _fmtShutter },
  { key: 'FNumber',         icon: EXIF_APERTURE_SVG, label: 'Aperture', fmt: _fmtFNumber },
  { key: 'FocalLength',     icon: EXIF_FOCAL_SVG,    label: 'Focal',    fmt: _fmtFocal },
  { key: 'ISOSpeedRatings', icon: EXIF_ISO_SVG,      label: 'ISO',      fmt: _fmtISO },
  { key: 'Make',            icon: EXIF_CAMERA_SVG,   label: 'Make',     fmt: null },
  { key: 'Model',           icon: EXIF_MODEL_SVG,    label: 'Model',    fmt: null },
];

function _evalFraction(val) {
  const s = String(val);
  const m = s.match(/^(-?\d+)\/(\d+)$/);
  if (m) return parseInt(m[1], 10) / parseInt(m[2], 10);
  return parseFloat(s);
}

function _fmtShutter(val) {
  const s = String(val);
  // Keep fraction form if denominator > 1 (e.g. "1/200"), add "s"
  if (/^\d+\/\d+$/.test(s)) return `${s} s`;
  const n = _evalFraction(s);
  return n >= 1 ? `${n} s` : `1/${Math.round(1 / n)} s`;
}

function _fmtFNumber(val) {
  const n = _evalFraction(val);
  return `f/${Number(n.toFixed(1))}`;
}

function _fmtFocal(val) {
  const n = _evalFraction(val);
  return `${Math.round(n)} mm`;
}

function _fmtISO(val) {
  return `ISO ${val}`;
}

export class PublicFooter extends Component {
  render() {
    const { settings = {}, immersiveTags = [], exifMedia = [] } = this.props;
    const author = escapeHtml(settings.author_name || settings.blog_title || '');

    const aboutHref = settings.about_post_id
      ? `/post/${escapeHtml(settings.about_post_id)}`
      : '/light';

    let centerSlot;
    if (immersiveTags.length) {
      const navTags = store.get('navTags') || [];
      const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
      const visibleTags = immersiveTags.filter((t) => {
        if (!tagIndex) return true;
        const entry = tagIndex.get(t.slug);
        return !entry || entry.isLeaf;
      });
      const tagLinks = visibleTags.map((t) => renderTagLink(t)).join('');
      // EXIF pill — rendered only when at least one allowed field is present
      const hasExif = exifMedia.some((m) =>
        m.metadata && EXIF_FIELDS.some(({ key }) => key in m.metadata));
      const exifPill = hasExif
        ? `<button class="tag-link exif-pill" type="button" aria-expanded="false" aria-label="Show EXIF data">exif <span class="flyout-indicator" aria-hidden="true">${CHEVRON_SVG}</span></button>`
        : '';
      centerSlot = `<div class="immersive-tags">${tagLinks}${exifPill}</div>`;
    } else {
      centerSlot = `<div id="pagination-mount"></div>`;
    }

    return `
      <footer class="site-footer">
        <div class="footer-container">
          <div class="footer-content">
            <p class="footer-copyright">
              <a href="/light">&copy;</a>${author ? ` <a href="${aboutHref}">${author}</a>` : ''}
            </p>
            ${centerSlot}
          </div>
        </div>
      </footer>`;
  }

  afterRender() {
    const tagsEl = this.$('.immersive-tags');
    if (!tagsEl) return;
    const navTags = store.get('navTags') || [];
    const tagIndex = navTags.length ? buildTagIndex(navTags) : null;
    this._cleanupFlyout = setupTagFlyout(tagsEl, tagIndex, navigate);

    const pill = tagsEl.querySelector('.exif-pill');
    if (pill) this._setupExifPill(pill);
  }

  _setupExifPill(pill) {
    const { exifMedia = [] } = this.props;

    // Attach flyout to document.body with position:fixed so it floats above
    // everything. CSS rule `.immersive-layout.ui-hidden .exif-flyout` hides it
    // when the footer slides away — no JS timer needed.
    const flyout = document.createElement('div');
    flyout.className = 'exif-flyout hidden';
    flyout.style.cssText = 'position:fixed; z-index:500;';
    document.body.appendChild(flyout);
    this._exifFlyout = flyout;

    // Populate flyout — only the allowed fields, with icons, from the first media item with metadata
    const firstMeta = exifMedia.find((m) => m.metadata && Object.keys(m.metadata).length > 0)?.metadata || {};
    const svgParser = new DOMParser();
    const table = document.createElement('table');
    table.className = 'exif-flyout-table';
    EXIF_FIELDS.forEach(({ key, icon, label, fmt }) => {
      if (!(key in firstMeta)) return;
      const tr = document.createElement('tr');
      const tdK = document.createElement('td');
      tdK.setAttribute('title', label);
      // icon is a static SVG string from icons.js — not user data
      const svgEl = svgParser.parseFromString(icon, 'image/svg+xml').documentElement;
      tdK.appendChild(svgEl);
      const tdV = document.createElement('td');
      tdV.textContent = fmt ? fmt(firstMeta[key]) : String(firstMeta[key]);
      tr.appendChild(tdK);
      tr.appendChild(tdV);
      table.appendChild(tr);
    });
    flyout.appendChild(table);

    let _openTimer = null;
    const show = () => {
      flyout.style.visibility = 'hidden';
      flyout.classList.remove('hidden');
      const fW = flyout.offsetWidth;
      const pillRect = pill.getBoundingClientRect();
      // horizontal: centre over pill, clamped to viewport
      const pillCenter = pillRect.left + pillRect.width / 2;
      let left = Math.round(pillCenter - fW / 2);
      left = Math.max(8, Math.min(left, window.innerWidth - fW - 8));
      // vertical: above the pill, gap of 8px (fixed positioning from top)
      const top = pillRect.top - flyout.offsetHeight - 8;
      flyout.style.left = `${left}px`;
      flyout.style.top = `${top}px`;
      flyout.style.bottom = '';
      flyout.style.visibility = '';
      pill.classList.add('is-active');
      pill.setAttribute('aria-expanded', 'true');

      this._exifHotZone?.stop();
      this._exifHotZone = createHotZone(() => [pill, flyout], hide);
    };

    const hide = () => {
      this._exifHotZone?.stop();
      this._exifHotZone = null;
      flyout.classList.add('hidden');
      pill.classList.remove('is-active');
      pill.setAttribute('aria-expanded', 'false');
    };

    pill.addEventListener('mouseenter', () => {
      clearTimeout(_openTimer);
      _openTimer = setTimeout(() => {
        _openTimer = null;
        if (!flyout.classList.contains('hidden')) return;
        show();
      }, 300);
    });
    pill.addEventListener('mouseleave', () => clearTimeout(_openTimer));

    pill.addEventListener('click', (e) => {
      clearTimeout(_openTimer);
      e.stopPropagation();
      flyout.classList.contains('hidden') ? show() : hide();
    });

    const dismiss = (e) => {
      if (!flyout.contains(e.target) && e.target !== pill) hide();
    };
    document.addEventListener('click', dismiss);
    this._exifDismiss = dismiss;
  }

  beforeUnmount() {
    this._cleanupFlyout?.();
    this._exifHotZone?.stop();
    this._exifFlyout?.remove();
    this._exifFlyout = null;
    if (this._exifDismiss) {
      document.removeEventListener('click', this._exifDismiss);
      this._exifDismiss = null;
    }
  }
}
