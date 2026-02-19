/**
 * Media Management JavaScript - Photo Blog Engine
 * Handles media upload, filtering, and file management
 */

(function () {
    'use strict';

    let uploadModal;

    /**
     * Open upload modal
     */
    const openUploadModal = function () {
        if (uploadModal) uploadModal.classList.add('active');
    };

    /**
     * Close upload modal
     */
    const closeUploadModal = function () {
        if (!uploadModal) return;
        uploadModal.classList.add('closing');
        setTimeout(() => {
            uploadModal.classList.remove('active');
            uploadModal.classList.remove('closing');
        }, 300);
    };

    /**
     * Filter media by type
     */
    const filterByType = function (type) {
        const url = new URL(window.location);
        if (type) {
            url.searchParams.set('file_type', type);
        } else {
            url.searchParams.delete('file_type');
        }
        url.searchParams.delete('page');
        window.location = url;
    };

    /**
     * Handle file uploads
     */
    async function handleFiles(files) {
        if (!files.length) return;

        const progressDiv = document.getElementById('upload-progress');
        const progressBar = progressDiv.querySelector('.storage-bar-fill');
        progressDiv.classList.toggle('hidden', false);
        progressDiv.classList.toggle('visible-block', true);

        for (let i = 0; i < files.length; i++) {
            const progress = ((i / files.length) * 100).toFixed(0);
            progressBar.style.width = `${progress}%`;

            const formData = new FormData();
            formData.append('file', files[i]);

            try {
                const response = await fetch('/api/media/upload', {
                    method: 'POST',
                    body: formData,
                    credentials: 'include'
                });

                if (!response.ok) {
                    const errorData = await response.json().catch(() => ({}));
                    console.error('Server error details:', errorData);
                    const errorMessage = errorData.detail?.message || errorData.detail || 'Upload failed';
                    if (window.LightUtils && window.LightUtils.showToast) {
                        window.LightUtils.showToast(`Failed: ${files[i].name} - ${errorMessage}`, 'error');
                    }
                }
            } catch (error) {
                if (window.LightUtils && window.LightUtils.showToast) {
                    window.LightUtils.showToast(`Failed: ${files[i].name}`, 'error');
                }
            }
        }

        progressBar.style.width = '100%';
        setTimeout(() => {
            window.location.reload();
        }, 500);
    }

    /**
     * Handle media renaming
     */
    async function handleRename(mediaId, oldFilename) {
        let newFilename;
        if (window.LightUtils && window.LightUtils.prompt) {
            newFilename = await window.LightUtils.prompt('Enter new filename:', oldFilename, { title: 'Rename Media' });
        } else {
            newFilename = prompt('Enter new filename:', oldFilename);
        }

        if (!newFilename || newFilename === oldFilename) return;

        try {
            const response = await fetch(`/api/media/${mediaId}/rename`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ new_filename: newFilename }),
                credentials: 'include'
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMessage = errorData.detail || 'Rename failed';
                if (window.LightUtils && window.LightUtils.showToast) {
                    window.LightUtils.showToast(errorMessage, 'error');
                } else if (window.LightUtils && window.LightUtils.alert) {
                    await window.LightUtils.alert(errorMessage, { title: 'Error' });
                } else {
                    alert(errorMessage);
                }
                return;
            }

            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast('Media renamed and post references updated');
            }

            setTimeout(() => window.location.reload(), 500);
        } catch (error) {
            console.error('Rename error:', error);
            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast('An error occurred during rename', 'error');
            }
        }
    }

    /**
     * Initialize media library features
     */
    function init() {
        uploadModal = document.getElementById('upload-modal');

        // Video playback handling
        const videoPreviews = document.querySelectorAll('.media-video-preview');
        videoPreviews.forEach(container => {
            const video = container.querySelector('video');
            
            // Hover to play (muted)
            container.addEventListener('mouseenter', () => {
                if (video.paused) {
                    video.play().catch(() => {});
                }
            });

            container.addEventListener('mouseleave', () => {
                if (!container.classList.contains('is-playing')) {
                    video.pause();
                }
            });

            // Click to toggle full play (with sound if user wants)
            container.addEventListener('click', (e) => {
                // If clicking an action button, don't toggle video
                if (e.target.closest('.media-item-actions')) return;

                if (video.paused || video.muted) {
                    video.muted = false;
                    video.play().catch(() => {});
                    container.classList.add('is-playing');
                } else {
                    video.pause();
                    container.classList.remove('is-playing');
                }
            });

            video.addEventListener('ended', () => {
                container.classList.remove('is-playing');
            });
        });

        // Main action listeners
        document.addEventListener('click', function (e) {
            const uploadOpenBtn = e.target.closest('[data-action="open-upload-modal"]');
            const uploadCloseBtn = e.target.closest('[data-action="close-upload-modal"]');
            const renameBtn = e.target.closest('[data-action="rename-media"]');

            if (uploadOpenBtn) {
                openUploadModal();
            } else if (uploadCloseBtn) {
                closeUploadModal();
            } else if (renameBtn) {
                const mediaId = renameBtn.dataset.mediaId;
                const oldFilename = renameBtn.dataset.filename;
                handleRename(mediaId, oldFilename);
            }
        });

        // Type filter listener
        const typeFilter = document.querySelector('[data-action="filter-type"]');
        if (typeFilter) {
            typeFilter.addEventListener('change', (e) => filterByType(e.target.value));
        }

        // Modal overlay click listener
        if (uploadModal) {
            uploadModal.addEventListener('click', function (e) {
                if (e.target === uploadModal) {
                    closeUploadModal();
                }
            });
        }

        // Enhanced upload area initialization
        const uploadArea = document.querySelector('.upload-area');
        if (uploadArea) {
            const fileInput = uploadArea.querySelector('input[type="file"]');

            uploadArea.addEventListener('click', () => fileInput.click());

            uploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                uploadArea.classList.add('dragover');
            });

            uploadArea.addEventListener('dragleave', () => {
                uploadArea.classList.remove('dragover');
            });

            uploadArea.addEventListener('drop', async (e) => {
                e.preventDefault();
                uploadArea.classList.remove('dragover');
                await handleFiles(e.dataTransfer.files);
            });

            fileInput.addEventListener('change', async (e) => {
                await handleFiles(e.target.files);
            });
        }
    }

    // Run initialization
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
