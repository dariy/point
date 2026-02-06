/**
 * Theme Toggle - Photo Blog Engine
 * Handles dark/light theme switching with system preference detection
 */

(function () {
    'use strict';

    const THEME_KEY = 'theme-preference';
    const THEME_DARK = 'dark';
    const THEME_LIGHT = 'light';

    /**
     * Get the current theme preference
     * Priority: localStorage > system preference > default (light)
     */
    function getThemePreference() {
        // Check localStorage first
        const storedPreference = localStorage.getItem(THEME_KEY);
        if (storedPreference) {
            return storedPreference;
        }

        // Check system preference
        if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            return THEME_DARK;
        }

        // Default to light
        return THEME_LIGHT;
    }

    /**
     * Apply theme to the document
     */
    function applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);

        // Update meta theme-color for mobile browsers
        const metaThemeColor = document.querySelector('meta[name="theme-color"]');
        if (metaThemeColor) {
            metaThemeColor.setAttribute(
                'content',
                theme === THEME_DARK ? '#1e293b' : '#ffffff'
            );
        }
    }

    /**
     * Save theme preference to localStorage
     */
    function saveThemePreference(theme) {
        localStorage.setItem(THEME_KEY, theme);
    }

    /**
     * Toggle between light and dark themes
     */
    function toggleTheme() {
        const currentTheme = document.documentElement.getAttribute('data-theme') || THEME_LIGHT;
        const newTheme = currentTheme === THEME_DARK ? THEME_LIGHT : THEME_DARK;

        applyTheme(newTheme);
        saveThemePreference(newTheme);

        // Dispatch custom event for other components to react
        window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: newTheme } }));
    }

    /**
     * Initialize theme toggle buttons
     */
    function initThemeToggle() {
        const toggleButtons = document.querySelectorAll('.theme-toggle');
        toggleButtons.forEach(function (button) {
            button.addEventListener('click', function (e) {
                e.preventDefault();
                toggleTheme();
            });
        });
    }

    /**
     * Listen for system theme changes
     */
    function watchSystemPreference() {
        if (!window.matchMedia) return;

        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

        mediaQuery.addEventListener('change', function (e) {
            // Only auto-switch if user hasn't set a preference
            if (!localStorage.getItem(THEME_KEY)) {
                applyTheme(e.matches ? THEME_DARK : THEME_LIGHT);
            }
        });
    }

    /**
     * Initialize theme on page load
     * This runs immediately to prevent flash of unstyled content
     */
    function initTheme() {
        const theme = getThemePreference();
        applyTheme(theme);
    }

    // Apply theme immediately (before DOM is ready)
    initTheme();

    // Set up event listeners when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            initThemeToggle();
            watchSystemPreference();
        });
    } else {
        initThemeToggle();
        watchSystemPreference();
    }

    // Expose theme API for external use
    window.ThemeManager = {
        toggle: toggleTheme,
        get: function () {
            return document.documentElement.getAttribute('data-theme') || THEME_LIGHT;
        },
        set: function (theme) {
            if (theme === THEME_DARK || theme === THEME_LIGHT) {
                applyTheme(theme);
                saveThemePreference(theme);
            }
        },
        reset: function () {
            localStorage.removeItem(THEME_KEY);
            initTheme();
        }
    };

})();
