/**
 * Light JavaScript - Photo Blog Engine
 */

(function () {
    'use strict';

    // ===========================
    // Utility Functions
    // ===========================

    /**
     * Format bytes to human readable size
     */
    function formatBytes(bytes, decimals = 2) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
    }

    /**
     * Debounce function calls
     */
    function debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    /**
     * Show a toast notification
     */
    function showToast(message, type = 'success') {
        const toast = document.createElement('div');
        toast.className = `flash-message flash-${type}`;
        toast.textContent = message;

        let container = document.body.querySelector('.flash-messages-container');
        if (!container) {
            container = document.createElement('div');
            container.className = 'flash-messages flash-messages-container';
            document.body.appendChild(container);
        }

        container.appendChild(toast);

        // Auto-remove after delay
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'translateX(20px)';
            setTimeout(() => {
                toast.remove();
            }, 300);
        }, 3000);
    }

    // ===========================
    // Tags Input Component
    // ===========================

    class TagsInput {
        constructor(container) {
            this.container = container;
            this.input = container.querySelector('input[type="text"]');
            this.hiddenInput = container.querySelector('input[type="hidden"]');
            this.suggestions = container.querySelector('.tags-suggestions');
            this.tags = [];
            this.allTags = [];

            this.init();
        }

        init() {
            // Load existing tags
            if (this.hiddenInput && this.hiddenInput.value) {
                this.tags = this.hiddenInput.value.split(',').filter(t => t.trim());
                this.renderTags();
            }

            // Load available tags for autocomplete
            if (this.container.dataset.tags) {
                try {
                    this.allTags = JSON.parse(this.container.dataset.tags);
                } catch (e) {
                    console.error('Failed to parse tags:', e);
                }
            }

            // Event listeners
            this.input.addEventListener('keydown', this.handleKeyDown.bind(this));
            this.input.addEventListener('input', debounce(this.handleInput.bind(this), 200));
            this.container.addEventListener('click', () => this.input.focus());
        }

        handleKeyDown(e) {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const value = this.input.value.trim();
                if (value && !this.tags.includes(value)) {
                    this.addTag(value);
                }
                this.input.value = '';
            } else if (e.key === 'Backspace' && !this.input.value && this.tags.length) {
                this.removeTag(this.tags.length - 1);
            }
        }

        handleInput() {
            const value = this.input.value.toLowerCase();
            if (!value || !this.suggestions) return;

            const matches = this.allTags
                .filter(tag => tag.toLowerCase().includes(value) && !this.tags.includes(tag))
                .slice(0, 5);

            if (matches.length) {
                this.showSuggestions(matches);
            } else {
                this.hideSuggestions();
            }
        }

        showSuggestions(matches) {
            if (!this.suggestions) return;
            this.suggestions.innerHTML = matches
                .map(tag => `<div class="suggestion-item" data-tag="${tag}">${tag}</div>`)
                .join('');
            this.suggestions.style.display = 'block';

            this.suggestions.querySelectorAll('.suggestion-item').forEach(item => {
                item.addEventListener('click', () => {
                    this.addTag(item.dataset.tag);
                    this.input.value = '';
                    this.hideSuggestions();
                });
            });
        }

        hideSuggestions() {
            if (this.suggestions) {
                this.suggestions.style.display = 'none';
            }
        }

        addTag(tag) {
            this.tags.push(tag);
            this.renderTags();
            this.updateHiddenInput();
        }

        removeTag(index) {
            this.tags.splice(index, 1);
            this.renderTags();
            this.updateHiddenInput();
        }

        renderTags() {
            const tagsHtml = this.tags.map((tag, i) => `
                <span class="tag">
                    ${tag}
                    <span class="tag-remove" data-index="${i}">&times;</span>
                </span>
            `).join('');

            // Find or create tags container
            let tagsContainer = this.container.querySelector('.tags-list');
            if (!tagsContainer) {
                tagsContainer = document.createElement('div');
                tagsContainer.className = 'tags-list';
                this.container.insertBefore(tagsContainer, this.input);
            }

            tagsContainer.innerHTML = tagsHtml;

            // Add remove event listeners
            tagsContainer.querySelectorAll('.tag-remove').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.removeTag(parseInt(btn.dataset.index));
                });
            });
        }

        updateHiddenInput() {
            if (this.hiddenInput) {
                this.hiddenInput.value = this.tags.join(',');
            }
        }
    }

    // ===========================
    // File Upload Component
    // ===========================

    class FileUploader {
        constructor(element) {
            this.element = element;
            this.input = element.querySelector('input[type="file"]');
            this.uploadUrl = element.dataset.uploadUrl || '/api/media/upload';
            this.onUpload = null;

            this.init();
        }

        init() {
            // Drag and drop events
            this.element.addEventListener('dragover', this.handleDragOver.bind(this));
            this.element.addEventListener('dragleave', this.handleDragLeave.bind(this));
            this.element.addEventListener('drop', this.handleDrop.bind(this));

            // File input change
            if (this.input) {
                this.input.addEventListener('change', this.handleFileSelect.bind(this));
            }

            // Click to upload
            this.element.addEventListener('click', () => {
                if (this.input) this.input.click();
            });
        }

        handleDragOver(e) {
            e.preventDefault();
            this.element.classList.add('dragover');
        }

        handleDragLeave(e) {
            e.preventDefault();
            this.element.classList.remove('dragover');
        }

        handleDrop(e) {
            e.preventDefault();
            this.element.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length) {
                this.uploadFiles(files);
            }
        }

        handleFileSelect(e) {
            const files = e.target.files;
            if (files.length) {
                this.uploadFiles(files);
            }
        }

        async uploadFiles(files) {
            for (const file of files) {
                await this.uploadFile(file);
            }
        }

        async uploadFile(file) {
            const formData = new FormData();
            formData.append('file', file);

            try {
                const response = await fetch(this.uploadUrl, {
                    method: 'POST',
                    body: formData,
                    credentials: 'include'
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    console.error('Server error details:', errorData);
                    const errorMessage = errorData.detail?.message || errorData.detail || 'Upload failed';
                    throw new Error(errorMessage);
                }

                const data = await response.json();
                showToast(`Uploaded: ${file.name}`);

                if (this.onUpload) {
                    this.onUpload(data);
                }

                // Refresh page to show new upload
                if (window.location.pathname === '/light/media') {
                    window.location.reload();
                }
            } catch (error) {
                showToast(`Failed to upload: ${file.name}`, 'error');
                console.error('Upload error:', error);
            }
        }
    }

    // ===========================
    // Modal Component
    // ===========================

    class Modal {
        constructor(element) {
            this.overlay = element;
            this.modal = element.querySelector('.modal');
            this.closeBtn = element.querySelector('.modal-close');

            this.init();
        }

        init() {
            if (this.closeBtn) {
                this.closeBtn.addEventListener('click', () => this.close());
            }

            this.overlay.addEventListener('click', (e) => {
                if (e.target === this.overlay) {
                    this.close();
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.overlay.classList.contains('active')) {
                    this.close();
                }
            });
        }

        open() {
            this.overlay.classList.add('active');
            document.body.style.overflow = 'hidden';
        }

        close() {
            this.overlay.classList.add('closing');
            setTimeout(() => {
                this.overlay.classList.remove('active');
                this.overlay.classList.remove('closing');
                document.body.style.overflow = '';
            }, 300);
        }
    }

    // ===========================
    // Dialog System
    // ===========================

    /**
     * Create standard modals if they don't exist
     */
    function ensureModals() {
        if (!document.getElementById('confirm-modal')) {
            const confirmOverlay = document.createElement('div');
            confirmOverlay.id = 'confirm-modal';
            confirmOverlay.className = 'modal-overlay';
            confirmOverlay.innerHTML = `
                <div class="modal" style="width: 400px; min-width: 300px;">
                    <div class="modal-header">
                        <h3 id="confirm-title">Confirm Action</h3>
                    </div>
                    <div class="modal-body">
                        <p id="confirm-message"></p>
                    </div>
                    <div class="modal-footer">
                        <button id="confirm-cancel" class="btn btn-secondary">Cancel</button>
                        <button id="confirm-ok" class="btn btn-primary">Confirm</button>
                    </div>
                </div>
            `;
            document.body.appendChild(confirmOverlay);
        }

        if (!document.getElementById('alert-modal')) {
            const alertOverlay = document.createElement('div');
            alertOverlay.id = 'alert-modal';
            alertOverlay.className = 'modal-overlay';
            alertOverlay.innerHTML = `
                <div class="modal" style="width: 400px; min-width: 300px;">
                    <div class="modal-header">
                        <h3 id="alert-title">Notification</h3>
                    </div>
                    <div class="modal-body">
                        <p id="alert-message"></p>
                    </div>
                    <div class="modal-footer">
                        <button id="alert-ok" class="btn btn-primary">OK</button>
                    </div>
                </div>
            `;
            document.body.appendChild(alertOverlay);
        }

        if (!document.getElementById('prompt-modal')) {
            const promptOverlay = document.createElement('div');
            promptOverlay.id = 'prompt-modal';
            promptOverlay.className = 'modal-overlay';
            promptOverlay.innerHTML = `
                <div class="modal" style="width: 400px; min-width: 300px;">
                    <div class="modal-header">
                        <h3 id="prompt-title">Input Required</h3>
                    </div>
                    <div class="modal-body">
                        <p id="prompt-message"></p>
                        <div class="mt-3">
                            <input type="text" id="prompt-input" class="form-input" style="width: 100%;">
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button id="prompt-cancel" class="btn btn-secondary">Cancel</button>
                        <button id="prompt-ok" class="btn btn-primary">OK</button>
                    </div>
                </div>
            `;
            document.body.appendChild(promptOverlay);
        }
    }

    /**
     * Custom alert dialog
     */
    function alert(message, options = {}) {
        ensureModals();
        return new Promise((resolve) => {
            const modalEl = document.getElementById('alert-modal');
            const titleEl = modalEl.querySelector('#alert-title');
            const messageEl = modalEl.querySelector('#alert-message');
            const okBtn = modalEl.querySelector('#alert-ok');

            if (titleEl) titleEl.textContent = options.title || 'Notification';
            if (messageEl) messageEl.textContent = message;
            if (okBtn) okBtn.textContent = options.okText || 'OK';

            const modal = new Modal(modalEl);

            const handleOk = () => {
                modal.close();
                okBtn.removeEventListener('click', handleOk);
                resolve();
            };

            okBtn.addEventListener('click', handleOk);
            modal.open();
        });
    }

    /**
     * Custom prompt dialog
     */
    function prompt(message, defaultValue = '', options = {}) {
        ensureModals();
        return new Promise((resolve) => {
            const modalEl = document.getElementById('prompt-modal');
            const titleEl = modalEl.querySelector('#prompt-title');
            const messageEl = modalEl.querySelector('#prompt-message');
            const inputEl = modalEl.querySelector('#prompt-input');
            const okBtn = modalEl.querySelector('#prompt-ok');
            const cancelBtn = modalEl.querySelector('#prompt-cancel');

            if (titleEl) titleEl.textContent = options.title || 'Input Required';
            if (messageEl) messageEl.textContent = message;
            if (inputEl) {
                inputEl.value = defaultValue;
                inputEl.placeholder = options.placeholder || '';
            }

            const modal = new Modal(modalEl);

            const handleOk = () => {
                const value = inputEl.value;
                modal.close();
                cleanup();
                resolve(value);
            };

            const handleCancel = () => {
                modal.close();
                cleanup();
                resolve(null);
            };

            const cleanup = () => {
                okBtn.removeEventListener('click', handleOk);
                cancelBtn.removeEventListener('click', handleCancel);
            };

            okBtn.addEventListener('click', handleOk);
            cancelBtn.addEventListener('click', handleCancel);

            modal.open();
            setTimeout(() => inputEl.focus(), 100);
        });
    }

    /**
     * Custom confirmation dialog using Modal
     */
    function confirm(message, options = {}) {
        ensureModals();
        return new Promise((resolve) => {
            const modalEl = document.getElementById('confirm-modal');
            const titleEl = modalEl.querySelector('#confirm-title');
            const messageEl = modalEl.querySelector('#confirm-message');
            const okBtn = modalEl.querySelector('#confirm-ok');
            const cancelBtn = modalEl.querySelector('#confirm-cancel');

            if (titleEl) titleEl.textContent = options.title || 'Confirm Action';
            if (messageEl) messageEl.textContent = message;
            if (okBtn) {
                okBtn.textContent = options.okText || 'OK';
                okBtn.className = `btn btn-${options.okVariant || 'danger'}`;
            }
            if (cancelBtn) cancelBtn.textContent = options.cancelText || 'Cancel';

            const modal = new Modal(modalEl);

            const handleOk = () => {
                modal.close();
                cleanup();
                resolve(true);
            };

            const handleCancel = () => {
                modal.close();
                cleanup();
                resolve(false);
            };

            const cleanup = () => {
                okBtn.removeEventListener('click', handleOk);
                cancelBtn.removeEventListener('click', handleCancel);
            };

            okBtn.addEventListener('click', handleOk);
            cancelBtn.addEventListener('click', handleCancel);

            modal.open();
        });
    }

    // ===========================
    // Delete Handlers
    // ===========================

    async function handleDelete(e) {
        const btn = e.target.closest('[data-delete-url]');
        if (!btn) return;

        e.preventDefault();
        const url = btn.dataset.deleteUrl;
        const name = btn.dataset.deleteName || 'this item';

        const confirmed = await confirm(`Are you sure you want to delete ${name}?`);
        if (!confirmed) return;

        try {
            const response = await fetch(url, {
                method: 'DELETE',
                credentials: 'include'
            });

            if (!response.ok) {
                throw new Error('Delete failed');
            }

            showToast('Deleted successfully');

            // Handle redirect if specified
            if (btn.dataset.redirectUrl) {
                setTimeout(() => {
                    window.location.href = btn.dataset.redirectUrl;
                }, 500);
                return;
            }

            // Remove element or reload
            const row = btn.closest('tr, .media-item, .card');
            if (row) {
                row.style.opacity = '0';
                setTimeout(() => row.remove(), 300);
            } else {
                window.location.reload();
            }
        } catch (error) {
            showToast('Failed to delete', 'error');
            console.error('Delete error:', error);
        }
    }

    // ===========================
    // Copy URL Handler
    // ===========================

    async function handleCopyUrl(e) {
        const btn = e.target.closest('[data-copy-url]');
        if (!btn) return;

        e.preventDefault();

        const textToCopy = btn.dataset.copyMarkdown || (window.location.origin + btn.dataset.copyUrl);
        const message = btn.dataset.copyMarkdown ? 'Markdown copied to clipboard' : 'URL copied to clipboard';

        try {
            await navigator.clipboard.writeText(textToCopy);
            showToast(message);
        } catch (error) {
            // Fallback for older browsers
            const input = document.createElement('input');
            input.value = textToCopy;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            document.body.removeChild(input);
            showToast(message);
        }
    }

    // ===========================
    // Keyboard Shortcuts
    // ===========================

    function initKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ignore if typing in an input
            if (
                e.target.tagName === 'INPUT' ||
                e.target.tagName === 'TEXTAREA' ||
                e.target.isContentEditable
            ) {
                return;
            }

            // Number keys (1-9) to open posts in list view
            if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const rows = document.querySelectorAll('table.table tbody tr');
                if (rows.length > 0) {
                    const index = parseInt(e.key) - 1;
                    if (rows[index]) {
                        // Look for a link in the first cell or any link in the row
                        const link = rows[index].querySelector('td:first-child a') || rows[index].querySelector('a');
                        if (link) {
                            e.preventDefault();
                            link.click();
                        }
                    }
                }
            }

            // Ctrl/Cmd + S to save
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                const form = document.querySelector('form.post-form, form.editor-form');
                if (form) {
                    e.preventDefault();
                    form.submit();
                }
            }
        });
    }

    // ===========================
    // Mobile Sidebar Toggle
    // ===========================

    function initMobileSidebar() {
        const sidebar = document.querySelector('.light-sidebar');
        const toggle = document.querySelector('.sidebar-toggle');

        if (toggle && sidebar) {
            toggle.addEventListener('click', () => {
                sidebar.classList.toggle('open');
            });

            // Close on outside click
            document.addEventListener('click', (e) => {
                if (sidebar.classList.contains('open') &&
                    !sidebar.contains(e.target) &&
                    !toggle.contains(e.target)) {
                    sidebar.classList.remove('open');
                }
            });
        }
    }

    // ===========================
    // Auto-save Draft
    // ===========================

    function initAutoSave() {
        const form = document.querySelector('form.post-form');
        if (!form) return;

        const titleInput = form.querySelector('[name="title"]');
        const contentInput = form.querySelector('[name="content"]');

        if (!titleInput || !contentInput) return;

        const postId = form.dataset.postId;
        const storageKey = postId ? `draft_${postId}` : 'draft_new';

        // Load draft
        const draft = localStorage.getItem(storageKey);
        if (draft) {
            try {
                const data = JSON.parse(draft);
                if (!titleInput.value && data.title) titleInput.value = data.title;
                if (!contentInput.value && data.content) contentInput.value = data.content;
            } catch (e) { }
        }

        // Auto-save
        const save = debounce(() => {
            const data = {
                title: titleInput.value,
                content: contentInput.value,
                timestamp: Date.now()
            };
            localStorage.setItem(storageKey, JSON.stringify(data));
        }, 1000);

        titleInput.addEventListener('input', save);
        contentInput.addEventListener('input', save);

        // Clear on successful submit
        form.addEventListener('submit', () => {
            localStorage.removeItem(storageKey);
        });
    }

    // ===========================
    // Preview Panel
    // ===========================

    function initPreview() {
        const contentInput = document.querySelector('[name="content"]');
        const previewPanel = document.querySelector('.preview-panel');
        const previewToggle = document.querySelector('.preview-toggle');

        if (!contentInput || !previewPanel) return;

        if (previewToggle) {
            previewToggle.addEventListener('click', () => {
                const previewCard = document.getElementById('preview-card');
                if (previewCard) {
                    previewCard.style.display = previewCard.style.display === 'none' ? 'block' : 'none';
                }
            });
        }

        const updatePreview = debounce(async () => {
            const content = contentInput.value;
            if (!content) {
                previewPanel.innerHTML = '<p class="text-muted">Start typing to see preview...</p>';
                return;
            }

            try {
                // Simple markdown preview (basic)
                let html = content
                    // Standalone image URLs (on their own line) - convert to img tags
                    .replace(/^(\/\d{4}\/\d{2}\/[^\s]+\.(jpg|jpeg|png|gif|webp|mp4|webm))$/gm, (match) => {
                        const isVideo = match.match(/\.(mp4|webm)$/i);
                        if (isVideo) {
                            return `<video src="${match}" controls style="max-width: 100%;"></video>`;
                        }
                        return `<img src="${match}" alt="" style="max-width: 100%;">`;
                    })
                    // Headers
                    .replace(/^### (.*$)/gm, '<h3>$1</h3>')
                    .replace(/^## (.*$)/gm, '<h2>$1</h2>')
                    .replace(/^# (.*$)/gm, '<h1>$1</h1>')
                    // Bold
                    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                    // Italic
                    .replace(/\*(.*?)\*/g, '<em>$1</em>')
                    // Links
                    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
                    // Images (markdown format) - handle relative URLs
                    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
                        // If URL starts with /, prepend /media
                        if (url.startsWith('/') && !url.startsWith('/media')) {
                            url = '/media' + url;
                        }
                        return `<img src="${url}" alt="${alt}" style="max-width: 100%;">`;
                    })
                    // Line breaks
                    .replace(/\n\n/g, '</p><p>')
                    .replace(/\n/g, '<br>');

                previewPanel.innerHTML = '<p>' + html + '</p>';
            } catch (error) {
                console.error('Preview error:', error);
            }
        }, 300);

        contentInput.addEventListener('input', updatePreview);
        updatePreview();
    }

    // ===========================
    // Content Editor Dropzone
    // ===========================

    class ContentEditorDropzone {
        constructor(textarea) {
            this.textarea = textarea;
            this.form = textarea.closest('form');
            // Use the parent card-body as drop zone if available, otherwise use textarea
            this.dropZone = textarea.closest('.card-body') || textarea;
            this.uploadUrl = '/api/media/upload';
            this.dragCounter = 0;

            this.init();
        }

        init() {
            // Drag and drop events
            this.dropZone.addEventListener('dragenter', this.handleDragEnter.bind(this));
            this.dropZone.addEventListener('dragover', this.handleDragOver.bind(this));
            this.dropZone.addEventListener('dragleave', this.handleDragLeave.bind(this));
            this.dropZone.addEventListener('drop', this.handleDrop.bind(this));
        }

        handleDragEnter(e) {
            e.preventDefault();
            this.dragCounter++;
            this.dropZone.classList.add('dragover');
        }

        handleDragOver(e) {
            e.preventDefault();
            // Ensure dragover class is present (sometimes needed if dragenter didn't fire correctly)
            this.dropZone.classList.add('dragover');
        }

        handleDragLeave(e) {
            e.preventDefault();
            this.dragCounter--;
            if (this.dragCounter <= 0) {
                this.dropZone.classList.remove('dragover');
                this.dragCounter = 0;
            }
        }

        handleDrop(e) {
            e.preventDefault();
            this.dragCounter = 0;
            this.dropZone.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length) {
                this.uploadFiles(files);
            }
        }

        async uploadFiles(files) {
            // Get post ID if available
            const postId = this.form ? this.form.dataset.postId : null;

            for (const file of files) {
                // Check if image or video
                const isImage = file.type.startsWith('image/');
                const isVideo = file.type.startsWith('video/');

                if (!isImage && !isVideo) {
                    showToast(`Skipped ${file.name}: Not an image or video`, 'warning');
                    continue;
                }

                // Show uploading state
                showToast(`Uploading ${file.name}...`, 'info');

                await this.uploadFile(file, postId);
            }
        }

        async uploadFile(file, postId) {
            const formData = new FormData();
            formData.append('file', file);
            if (postId) {
                formData.append('post_id', postId);
            }

            try {
                const response = await fetch(this.uploadUrl, {
                    method: 'POST',
                    body: formData,
                    credentials: 'include'
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    console.error('Server error details:', errorData);
                    const errorMessage = errorData.detail?.message || errorData.detail || 'Upload failed';
                    throw new Error(errorMessage);
                }

                const data = await response.json();

                // Insert markdown or HTML tag
                this.insertMediaTag(data);

                showToast(`Uploaded: ${file.name}`);

            } catch (error) {
                showToast(`Failed to upload: ${file.name}`, 'error');
                console.error('Upload error:', error);
            }
        }

        insertMediaTag(data) {
            const startPos = this.textarea.selectionStart;
            const text = this.textarea.value;

            // Check if we need to prepend a newline
            const needsNewline = startPos > 0 && text.substring(startPos - 1, startPos) !== '\n';

            let tag = `${data.url}\n`;

            const content = (needsNewline ? '\n' : '') + tag;
            const endPos = this.textarea.selectionEnd;

            // Insert at cursor
            this.textarea.value = text.substring(0, startPos) +
                content +
                text.substring(endPos, text.length);

            // Move cursor after inserted text
            const newPos = startPos + content.length;
            this.textarea.selectionStart = newPos;
            this.textarea.selectionEnd = newPos;

            // Trigger input event for auto-save and preview
            this.textarea.dispatchEvent(new Event('input'));
        }
    }

    // ===========================
    // Initialize
    // ===========================

    function init() {
        // Handle existing flash messages (server-rendered or client-rendered)
        document.querySelectorAll('.flash-messages .flash-message, .flash-messages-container .flash-message').forEach(toast => {
            setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(20px)';
                setTimeout(() => toast.remove(), 300);
            }, 5000);
        });

        // Initialize content editor dropzone
        const editorContent = document.querySelector('.editor-content');
        if (editorContent) {
            new ContentEditorDropzone(editorContent);
        }

        // Initialize tags inputs
        document.querySelectorAll('.tags-input').forEach(el => {
            new TagsInput(el);
        });

        // Initialize file uploaders
        document.querySelectorAll('.upload-area').forEach(el => {
            new FileUploader(el);
        });

        // Initialize modals
        document.querySelectorAll('.modal-overlay').forEach(el => {
            new Modal(el);
        });

        // Delete handlers
        document.addEventListener('click', handleDelete);

        // Copy URL handlers
        document.addEventListener('click', handleCopyUrl);

        // Keyboard shortcuts
        initKeyboardShortcuts();

        // Mobile sidebar
        initMobileSidebar();

        // Auto-save
        initAutoSave();

        // Preview panel
        initPreview();
    }

    // Run when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Export utilities
    window.LightUtils = {
        showToast,
        formatBytes,
        confirm,
        alert,
        prompt,
        Modal,
        TagsInput,
        FileUploader
    };
})();
