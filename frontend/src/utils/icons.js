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
  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
