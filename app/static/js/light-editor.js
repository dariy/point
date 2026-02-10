/**
 * Post Editor JavaScript - Photo Blog Engine
 * Handles post editing, preview, and form submission
 */

(function () {
    'use strict';

    /**
     * Initialize tags input handling
     */
    function initTagsInput() {
        const tagsInput = document.getElementById('tags');
        if (!tagsInput) return;

        tagsInput.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                // Add comma if not present at end
                const val = tagsInput.value.trim();
                if (val && !val.endsWith(',')) {
                    tagsInput.value = val + ', ';
                }
            }
        });
    }


    /**
     * Initialize post form submission
     */
    function initPostForm() {
        const postForm = document.getElementById('post-form');
        if (!postForm) return;

        postForm.addEventListener('submit', async function (e) {
            e.preventDefault();

            const form = e.target;
            const formData = new FormData(form);
            const postId = form.dataset.postId;

            // Collect tags from hidden input
            const allTags = formData.get('tags') ? formData.get('tags').split(',').map(t => t.trim()).filter(t => t.length > 0) : [];

            // Build request body
            const data = {
                title: formData.get('title'),
                content: formData.get('content'),
                excerpt: formData.get('excerpt') || null,
                status: formData.get('status'),
                is_featured: formData.get('is_featured') === '1',
                slug: formData.get('slug') || null,
                meta_description: formData.get('meta_description') || null,
                tags: allTags
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
        document.addEventListener('keydown', function (e) {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                const saveBtn = document.getElementById('btn-save'); // Note: ID in template is btn-save-header
                if (saveBtn) saveBtn.click();
                else {
                    const headerSave = document.getElementById('btn-save-header');
                    if (headerSave) headerSave.click();
                }
            }
        });
    }

    /**
     * Initialize card toggling
     */
    function initCardToggling() {
        const cardHeaders = document.querySelectorAll('.card-header');

        cardHeaders.forEach(header => {
            // Check if card should be foldable (all cards with headers in editor)
            const card = header.closest('.card');
            if (!card) return;

            // Add indicator icon if not present
            if (!header.querySelector('.toggle-icon')) {
                const icon = document.createElement('span');
                icon.className = 'toggle-icon';
                icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';
                icon.style.marginLeft = 'auto';

                // If header has flex-between, append to it, otherwise make header flex
                if (header.classList.contains('flex-between')) {
                    header.appendChild(icon);
                } else {
                    header.classList.add('flex-between');
                    // Add flex styles if not present (handled by CSS class usually, but ensure it)
                    header.style.display = 'flex';
                    header.style.alignItems = 'center';
                    header.style.justifyContent = 'space-between';
                    header.appendChild(icon);
                }
            }

            // Handle click
            header.addEventListener('click', function (e) {
                // Don't trigger if clicking buttons inside header
                if (e.target.closest('button') || e.target.closest('a') || e.target.closest('.badge')) {
                    return;
                }

                card.classList.toggle('collapsed');
            });
        });
    }

    /**
     * Initialize autofocus for elements with data-autofocus
     */
    function initAutofocus() {
        const postForm = document.getElementById('post-form');
        if (postForm && postForm.dataset.autofocus === 'true') {
            const titleInput = document.getElementById('title');
            if (titleInput) titleInput.focus();
        }
    }

    /**
     * Initialize Add Media button
     */
    function initMediaButton() {
        const addMediaBtn = document.getElementById('add-media-btn');
        const fileInput = document.getElementById('media-file-input');
        const contentTextarea = document.getElementById('content');

        if (!addMediaBtn || !fileInput || !contentTextarea) return;

        // Trigger file input when button is clicked
        addMediaBtn.addEventListener('click', function () {
            fileInput.click();
        });

        // Handle file selection
        fileInput.addEventListener('change', async function (e) {
            const files = e.target.files;
            if (!files || files.length === 0) return;

            const postForm = document.getElementById('post-form');
            const postId = postForm ? postForm.dataset.postId : null;

            for (const file of files) {
                // Check if image or video
                const isImage = file.type.startsWith('image/');
                const isVideo = file.type.startsWith('video/');

                if (!isImage && !isVideo) {
                    if (window.LightUtils && window.LightUtils.showToast) {
                        window.LightUtils.showToast(`Skipped ${file.name}: Not an image or video`, 'warning');
                    }
                    continue;
                }

                // Show uploading state
                if (window.LightUtils && window.LightUtils.showToast) {
                    window.LightUtils.showToast(`Uploading ${file.name}...`, 'info');
                }

                await uploadAndInsertMedia(file, postId, contentTextarea);
            }

            // Clear the file input so the same file can be selected again
            fileInput.value = '';
        });
    }

    /**
     * Upload a file and insert it into the content textarea
     */
    async function uploadAndInsertMedia(file, postId, textarea) {
        const formData = new FormData();
        formData.append('file', file);
        if (postId) {
            formData.append('post_id', postId);
        }

        try {
            const response = await fetch('/api/media/upload', {
                method: 'POST',
                body: formData,
                credentials: 'include'
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMessage = errorData.detail?.message || errorData.detail || 'Upload failed';
                throw new Error(errorMessage);
            }

            const data = await response.json();

            // Insert media tag at cursor position
            const startPos = textarea.selectionStart;
            const text = textarea.value;

            // Check if we need to prepend a newline
            const needsNewline = startPos > 0 && text.substring(startPos - 1, startPos) !== '\n';

            let tag = `${data.url}\n`;
            const content = (needsNewline ? '\n' : '') + tag;
            const endPos = textarea.selectionEnd;

            // Insert at cursor
            textarea.value = text.substring(0, startPos) + content + text.substring(endPos, text.length);

            // Move cursor after inserted text
            const newPos = startPos + content.length;
            textarea.selectionStart = newPos;
            textarea.selectionEnd = newPos;

            // Trigger input event for auto-save and preview
            textarea.dispatchEvent(new Event('input'));

            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast(`Uploaded: ${file.name}`);
            }

        } catch (error) {
            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast(`Failed to upload: ${file.name}`, 'error');
            }
            console.error('Upload error:', error);
        }
    }

    /**
     * Initialize all editor features
     */
    function init() {
        initTagsInput();
        initMediaButton();
        initPostForm();
        initKeyboardShortcuts();
        initCardToggling();
        initAutofocus();
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
