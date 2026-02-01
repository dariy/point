/**
 * Settings Page JavaScript - Photo Blog Engine
 * Handles blog settings form submission
 */

(function() {
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
            status.textContent = 'Saving...';
            status.className = 'save-status';

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
                    status.textContent = 'Settings saved successfully!';
                    status.classList.add('success');
                    setTimeout(() => {
                        status.textContent = '';
                    }, 3000);
                } else {
                    const data = await response.json();
                    status.textContent = 'Error: ' + (data.detail || 'Failed to save settings');
                    status.classList.add('error');
                }
            } catch (error) {
                status.textContent = 'Error: ' + error.message;
                status.classList.add('error');
            } finally {
                saveBtn.disabled = false;
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
