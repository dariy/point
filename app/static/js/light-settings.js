/**
 * Settings Page JavaScript - Photo Blog Engine
 * Handles blog settings form submission
 */

(function () {
    'use strict';

    function initTestGenAIConnection() {
        const testBtn = document.getElementById('test-genai-connection');
        const endpointInput = document.getElementById('genai_api_endpoint');
        const resultDiv = document.getElementById('genai-test-result');

        if (!testBtn || !endpointInput || !resultDiv) return;

        testBtn.addEventListener('click', async () => {
            const endpoint = endpointInput.value.trim();

            if (!endpoint) {
                resultDiv.className = 'connection-test-result error';
                resultDiv.textContent = 'Please enter a GenAI API endpoint first';
                return;
            }

            // Disable button and show testing state
            testBtn.disabled = true;
            testBtn.textContent = 'Testing...';
            resultDiv.className = 'connection-test-result info';
            resultDiv.textContent = 'Testing connection...';

            try {
                const response = await fetch('/api/settings/test-genai-connection', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                });

                const data = await response.json();

                if (data.status === 'success') {
                    resultDiv.className = 'connection-test-result success';
                    resultDiv.textContent = `✓ ${data.message}`;
                    if (data.response_data) {
                        resultDiv.textContent += ` (Response: ${JSON.stringify(data.response_data)})`;
                    }
                } else {
                    resultDiv.className = 'connection-test-result error';
                    resultDiv.textContent = `✗ ${data.message}`;
                }
            } catch (error) {
                resultDiv.className = 'connection-test-result error';
                resultDiv.textContent = `✗ Error: ${error.message}`;
            } finally {
                testBtn.disabled = false;
                testBtn.textContent = 'Test Connection';
            }
        });
    }

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
                if (['posts_per_page', 'max_image_width', 'jpeg_quality', 'storage_quota_mb', 'about_post_id', 'thumbnail_width', 'thumbnail_height'].includes(key)) {
                    // Parse as integer, but only if value is not empty
                    settings[key] = value ? parseInt(value, 10) : null;
                } else {
                    settings[key] = value;
                }
            }

            // Handle checkboxes (not in FormData if unchecked)
            settings['show_view_counts'] = form.querySelector('input[name="show_view_counts"]').checked;
            settings['enable_analytics'] = form.querySelector('input[name="enable_analytics"]').checked;
            settings['use_thumbnails'] = form.querySelector('input[name="use_thumbnails"]').checked;

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
        document.addEventListener('DOMContentLoaded', () => {
            initSettingsForm();
            initTestGenAIConnection();
        });
    } else {
        initSettingsForm();
        initTestGenAIConnection();
    }

})();
