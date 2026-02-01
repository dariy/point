/**
 * Post Editor JavaScript - Photo Blog Engine
 * Handles post editing, preview, and form submission
 */

(function() {
    'use strict';

    /**
     * Initialize preview toggle
     */
    function initPreviewToggle() {
        const previewToggle = document.querySelector('.preview-toggle');
        if (!previewToggle) return;

        previewToggle.addEventListener('click', function() {
            const previewCard = document.getElementById('preview-card');
            previewCard.style.display = previewCard.style.display === 'none' ? 'block' : 'none';
        });
    }

    /**
     * Initialize post form submission
     */
    function initPostForm() {
        const postForm = document.getElementById('post-form');
        if (!postForm) return;

        postForm.addEventListener('submit', async function(e) {
            e.preventDefault();

            const form = e.target;
            const formData = new FormData(form);
            const postId = form.dataset.postId;

            // Build request body
            const data = {
                title: formData.get('title'),
                content: formData.get('content'),
                excerpt: formData.get('excerpt') || null,
                status: formData.get('status'),
                is_featured: formData.get('is_featured') === '1',
                custom_url: formData.get('custom_url') || null,
                meta_description: formData.get('meta_description') || null,
                tags: formData.get('tags') ? formData.get('tags').split(',').filter(t => t.trim()) : []
            };

            const url = postId ? `/api/posts/${postId}` : '/api/posts';
            const method = postId ? 'PUT' : 'POST';

            try {
                const response = await fetch(url, {
                    method: method,
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(data),
                    credentials: 'include'
                });

                if (response.ok) {
                    const result = await response.json();
                    // Clear local storage draft
                    localStorage.removeItem(postId ? `draft_${postId}` : 'draft_new');
                    // Redirect to posts list or edit page
                    if (!postId) {
                        window.location.href = `/light/posts/${result.id}`;
                    } else {
                        window.LightUtils.showToast('Post saved successfully');
                    }
                } else {
                    const error = await response.json();
                    window.LightUtils.showToast(error.detail || 'Failed to save post', 'error');
                }
            } catch (error) {
                console.error('Save error:', error);
                window.LightUtils.showToast('An error occurred while saving', 'error');
            }
        });
    }

    /**
     * Initialize keyboard shortcuts
     */
    function initKeyboardShortcuts() {
        // Keyboard shortcut for save (Ctrl/Cmd + S)
        document.addEventListener('keydown', function(e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                const saveBtn = document.getElementById('btn-save');
                if (saveBtn) saveBtn.click();
            }
        });
    }

    /**
     * Initialize all editor features
     */
    function init() {
        initPreviewToggle();
        initPostForm();
        initKeyboardShortcuts();
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
