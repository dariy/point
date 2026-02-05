/**
 * Media Management JavaScript - Photo Blog Engine
 * Handles media upload, filtering, and file management
 */

(function () {
    'use strict';

    const uploadModal = document.getElementById('upload-modal');
    if (!uploadModal) return;

    /**
     * Open upload modal
     */
    window.openUploadModal = function () {
        uploadModal.classList.add('active');
    };

    /**
     * Close upload modal
     */
    window.closeUploadModal = function () {
        uploadModal.classList.add('closing');
        setTimeout(() => {
            uploadModal.classList.remove('active');
            uploadModal.classList.remove('closing');
        }, 300);
    };

    /**
     * Filter media by type
     */
    window.filterByType = function (type) {
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
        progressDiv.style.display = 'block';

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
                    window.LightUtils.showToast(`Failed: ${files[i].name} - ${errorMessage}`, 'error');
                }
            } catch (error) {
                window.LightUtils.showToast(`Failed: ${files[i].name}`, 'error');
            }
        }

        progressBar.style.width = '100%';
        setTimeout(() => {
            window.location.reload();
        }, 500);
    }

    // Close modal on overlay click
    uploadModal.addEventListener('click', function (e) {
        if (e.target === uploadModal) {
            closeUploadModal();
        }
    });

    // Enhanced upload area
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

})();
