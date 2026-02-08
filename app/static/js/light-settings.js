/**
 * Settings Page JavaScript - Photo Blog Engine
 * Handles blog settings form submission
 */

(function () {
    'use strict';

    function initSettingsForm() {
        const settingsForm = document.getElementById('settings-form');
        if (!settingsForm) return;

        settingsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.target;
            const saveBtn = form.querySelector('button[type="submit"]');
            const status = document.getElementById('save-status');

            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';

            const formData = new FormData(form);
            const settings = {};

            // Handle form data
            for (const [key, value] of formData.entries()) {
                if (['posts_per_page', 'max_image_width', 'jpeg_quality', 'storage_quota_mb'].includes(key)) {
                    settings[key] = parseInt(value, 10);
                } else {
                    settings[key] = value;
                }
            }

            // Handle checkboxes (not in FormData if unchecked)
            settings['show_view_counts'] = form.querySelector('input[name="show_view_counts"]').checked;
            settings['enable_analytics'] = form.querySelector('input[name="enable_analytics"]').checked;

            try {
                const response = await fetch('/api/settings', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ settings }),
                });

                if (response.ok) {
                    // Use toast notification
                    if (window.LightUtils && window.LightUtils.showToast) {
                        window.LightUtils.showToast('Settings saved successfully!', 'success');
                    }
                } else {
                    const data = await response.json();
                    const errorMsg = data.detail || 'Failed to save settings';
                    if (window.LightUtils && window.LightUtils.showToast) {
                        window.LightUtils.showToast(errorMsg, 'error');
                    }
                }
            } catch (error) {
                if (window.LightUtils && window.LightUtils.showToast) {
                    window.LightUtils.showToast('Error: ' + error.message, 'error');
                }
            } finally {
                saveBtn.disabled = false;
                saveBtn.textContent = 'Save Settings';
            }
        });
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initSettingsForm);
    } else {
        initSettingsForm();
    }

})();
