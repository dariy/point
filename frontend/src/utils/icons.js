/**
 * Shared SVG icon constants for use across components.
 * Each icon uses currentColor so it inherits the parent element's color.
 */

export const APP_LOGO_SVG = `<svg class="app-logo" viewBox="0 0 128 128" version="1.1"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path class="logo-shape" d="M128 64A64 64 0 1 0 64 128h48a16 16 0 0 0 16-16V64z" />
</svg>`;

export const CHEVRON_SVG = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const MAP_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"
        fill="currentColor"/>
  <circle cx="12" cy="9" r="2.5" fill="white"/>
</svg>`;

export const GLOBE_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="12" cy="12" r="9"/>
  <path d="M3 12h18"/>
  <path d="M12 3c2.5 2.5 3.8 5.7 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.7-3.8-9S9.5 5.5 12 3z"/>
</svg>`;

export const LOCK_SVG = `<svg class="locker-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"
  xmlns="http://www.w3.org/2000/svg" aria-label="Hidden" role="img">
  <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12
    c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9
    H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
</svg>`;

export const LOGOUT_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="16,17 21,12 16,7" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="21" y1="12" x2="9" y2="12" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const LOGIN_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="10,17 15,12 10,7" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="15" y1="12" x2="3" y2="12" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const FOLDER_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const CALENDAR_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="3" y="4" width="18" height="18" rx="2" ry="2" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const SUN_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="2"
    stroke-linecap="round"/>
  <line x1="12" y1="2"  x2="12" y2="5"  stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="19" x2="12" y2="22" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="2"  y1="12" x2="5"  y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="19" y1="12" x2="22" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="4.22"  y1="4.22"  x2="6.34"  y2="6.34"  stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="17.66" y1="17.66" x2="19.78" y2="19.78" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="19.78" y1="4.22"  x2="17.66" y2="6.34"  stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="6.34"  y1="17.66" x2="4.22"  y2="19.78" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const MOON_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const EDIT_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M11 4H4a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// ── Admin sidebar icons ────────────────────────────────────────────────────

export const DASHBOARD_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const POSTS_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="14 2 14 8 20 8" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="16" y1="13" x2="8" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="16" y1="17" x2="8" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const MEDIA_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="8.5" cy="8.5" r="1.5" stroke="currentColor" stroke-width="2"/>
  <polyline points="21 15 16 10 5 21" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const TAGS_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="7" y1="7" x2="7.01" y2="7" stroke="currentColor" stroke-width="2"
    stroke-linecap="round"/>
</svg>`;

export const SETTINGS_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2"/>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06
    a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09
    A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06
    A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09
    A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06
    A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09
    a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06
    A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09
    a1.65 1.65 0 0 0-1.51 1z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const SECURITY_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const SYSTEM_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const THEMES_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M12 21a9 9 0 1 1 0-18c4.97 0 9 3.58 9 8 0 1.47-.4 2.85-1.1 4.02L18 16l-1 4.5c-.14.65-.7 1.1-1.35 1.1H12z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="7.5" cy="10.5" r="1.5" fill="currentColor"/>
  <circle cx="12" cy="7.5" r="1.5" fill="currentColor"/>
  <circle cx="16.5" cy="10.5" r="1.5" fill="currentColor"/>
</svg>`;

export const PLUGINS_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M14 4a2 2 0 1 0-4 0v2H7a1 1 0 0 0-1 1v3H4a2 2 0 1 0 0 4h2v3a1 1 0 0 0 1 1h3v2a2 2 0 1 0 4 0v-2h3a1 1 0 0 0 1-1v-3a2 2 0 1 0 0-4V7a1 1 0 0 0-1-1h-3V4z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const RESTORE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polyline points="1 4 1 10 7 10" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M3.51 15a9 9 0 1 0 .49-4.54" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const EXTERNAL_LINK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="15 3 21 3 21 9" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="10" y1="14" x2="21" y2="3" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

/* ── Action / status icons ───────────────────────────────────────────────── */

export const X_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="18" y1="6" x2="6" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="6" y1="6" x2="18" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const REFRESH_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polyline points="1,4 1,10 7,10" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="23,20 23,14 17,14" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const WARNING_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="12" y1="9" x2="12" y2="13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="17" x2="12.01" y2="17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const STAR_SVG = `<svg width="16" height="16" viewBox="0 0 24 24"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"
    fill="currentColor" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const STAR_OUTLINE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const SPARKLE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M12 2l2.4 7.6H22l-6.4 4.6 2.4 7.8L12 17.4l-6 4.6 2.4-7.8L2 9.6h7.6z"
    fill="currentColor"/>
</svg>`;

export const MUSIC_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="2"/>
  <circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="2"/>
</svg>`;

export const PLAY_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polygon points="5,3 19,12 5,21" fill="currentColor" stroke="currentColor"
    stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const PAUSE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/>
  <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/>
</svg>`;

export const MINUS_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const SHUFFLE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polyline points="16 3 21 3 21 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="4" y1="20" x2="21" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="21 16 21 21 16 21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="15" y1="15" x2="21" y2="21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="4" y1="4" x2="9" y2="9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const REPEAT_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polyline points="17 1 21 5 17 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M3 11V9a4 4 0 0 1 4-4h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="7 23 3 19 7 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M21 13v2a4 4 0 0 1-4 4H3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const LIST_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="8" y1="6" x2="21" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="8" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="8" y1="18" x2="21" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="3" y1="6" x2="3.01" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="3" y1="12" x2="3.01" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="3" y1="18" x2="3.01" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const TREE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="5" cy="12" r="2" stroke="currentColor" stroke-width="2"/>
  <circle cx="19" cy="5" r="2" stroke="currentColor" stroke-width="2"/>
  <circle cx="19" cy="19" r="2" stroke="currentColor" stroke-width="2"/>
  <path d="M7 12h4a2 2 0 0 0 2-2V7" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M7 12h4a2 2 0 0 1 2 2v3" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const CHEVRON_RIGHT_SVG = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const SEARCH_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="11" cy="11" r="8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="21" y1="21" x2="16.65" y2="16.65" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const COMMENTS_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const MENU_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="3" y1="6" x2="21" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="7" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="11" y1="18" x2="21" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const TRASH_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polyline points="3 6 5 6 21 6" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M14 11v6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const CHECK_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <polyline points="20 6 9 17 4 12" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const PLUS_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="12" y1="5" x2="12" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="5" y1="12" x2="19" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const SELECT_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <polyline points="9 11 11 13 15 9" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="14" y1="6" x2="21" y2="6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="14" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="14" y1="18" x2="21" y2="18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const LINK_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const MAXIMIZE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export const MINIMIZE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;


export const SHARE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg>';

export const RSS_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1"></circle></svg>';

export const EXPAND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"></polyline><polyline points="9 21 3 21 3 15"></polyline><line x1="21" y1="3" x2="14" y2="10"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>';

export const INFO_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"
    stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="12" y1="16" x2="12" y2="12" stroke="currentColor" stroke-width="2"
    stroke-linecap="round"/>
  <line x1="12" y1="8" x2="12.01" y2="8" stroke="currentColor" stroke-width="2"
    stroke-linecap="round"/>
</svg>`;

export const SLIDERS_SVG = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"
  xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <line x1="4" y1="21" x2="4" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="4" y1="10" x2="4" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="21" x2="12" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="12" y1="8" x2="12" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="20" y1="21" x2="20" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="20" y1="12" x2="20" y2="3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="1" y1="14" x2="7" y2="14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="9" y1="8" x2="15" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <line x1="17" y1="16" x2="23" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
</svg>`;

