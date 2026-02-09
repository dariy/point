/**
 * System Page JavaScript - Photo Blog Engine
 * Handles system tools, backups, logs, and modal dialogs
 */

(function () {
    'use strict';

    // ===========================
    // Modal Dialog System (using LightUtils)
    // ===========================

    /**
     * Show confirmation dialog (wrapper for LightUtils)
     */
    const showConfirm = function (title, message, confirmText = 'Confirm', isDanger = false, cancelText = 'Cancel') {
        if (!window.LightUtils || !window.LightUtils.confirm) {
            return Promise.resolve(window.confirm(message));
        }
        return window.LightUtils.confirm(message, {
            title: title,
            okText: confirmText,
            okVariant: isDanger ? 'danger' : 'primary',
            cancelText: cancelText
        });
    };

    /**
     * Show alert dialog (wrapper for LightUtils)
     */
    const showAlert = function (title, message) {
        if (!window.LightUtils || !window.LightUtils.alert) {
            window.alert(message);
            return Promise.resolve();
        }
        return window.LightUtils.alert(message, { title: title });
    };

    // ===========================
    // Progress Overlay
    // ===========================

    /**
     * Show blocking progress overlay
     */
    const showProgress = function (message = 'Processing...') {
        let overlay = document.getElementById('progress-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'progress-overlay';
            overlay.className = 'modal-overlay progress-overlay';
            overlay.innerHTML = `
                <div class="progress-modal">
                    <div class="progress-spinner"></div>
                    <div class="progress-message">${message}</div>
                </div>
            `;
            document.body.appendChild(overlay);
        } else {
            const messageEl = overlay.querySelector('.progress-message');
            if (messageEl) messageEl.textContent = message;
        }
        overlay.classList.add('active');
    };

    /**
     * Hide progress overlay
     */
    const hideProgress = function () {
        const overlay = document.getElementById('progress-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    };

    // ===========================
    // System Operations
    // ===========================

    /**
     * Clear application cache
     */
    const clearCache = async function (pattern) {
        const confirmed = await showConfirm(
            'Clear Cache',
            'Are you sure you want to clear the cache? This may temporarily slow down page loads.',
            'Clear Cache'
        );
        if (!confirmed) return;

        try {
            const response = await fetch('/api/system/cache/clear?pattern=' + pattern, { method: 'POST' });
            const data = await response.json();
            if (response.ok) {
                await showAlert('Success', 'Cache cleared! ' + data.cleared_count + ' entries removed.');
                location.reload();
            } else {
                await showAlert('Error', data.detail);
            }
        } catch (error) {
            await showAlert('Error', error.message);
        }
    };

    /**
     * Trigger manual backup
     */
    const triggerBackup = async function (event) {
        // Confirm before starting backup
        const confirmed = await showConfirm(
            'Create Backup',
            'This will create a full backup of your database and media files.\n\nThis may take several minutes depending on the size of your data. Please do not close this page or interrupt the process.',
            'Create Backup',
            false
        );

        if (!confirmed) return;

        try {
            // Show blocking progress overlay
            showProgress('Creating backup...');
            const response = await fetch('/api/system/backup', { method: 'POST' });
            const data = await response.json();

            // Hide progress overlay
            hideProgress();
            if (response.ok) {
                await showAlert('Success', 'Backup created successfully!\nPath: ' + data.path);
                refreshBackups();
            } else {
                await showAlert('Error', data.detail);
            }
        } catch (error) {
            hideProgress();
            await showAlert('Error', error.message);
        }
    };

    /**
     * Cleanup orphaned media files
     */
    const cleanupOrphaned = async function () {
        const confirmed = await showConfirm(
            'Delete Orphaned Media',
            'Are you sure you want to delete orphaned media files? This action cannot be undone.',
            'Delete Files',
            true
        );
        if (!confirmed) return;

        try {
            const response = await fetch('/api/media/orphaned', { method: 'DELETE' });
            const data = await response.json();
            if (response.ok) {
                await showAlert('Success', 'Cleanup successful! ' + data.count + ' files removed.');
                location.reload();
            } else {
                await showAlert('Error', data.detail);
            }
        } catch (error) {
            await showAlert('Error', error.message);
        }
    };

    /**
     * Refresh system logs
     */
    const refreshLogs = async function () {
        const logTypeSelect = document.getElementById('log-type');
        if (!logTypeSelect) return;

        const logType = logTypeSelect.value;
        const logContent = document.getElementById('log-content');
        logContent.innerHTML = '<div class="log-line">Loading logs...</div>';

        try {
            const response = await fetch('/api/system/logs?log_type=' + logType);
            if (response.ok) {
                const lines = await response.json();
                logContent.innerHTML = lines.map(line => `<div class="log-line">${line}</div>`).join('') || '<div class="log-line empty">No logs found.</div>';
                logContent.scrollTop = logContent.scrollHeight;
            } else {
                logContent.innerHTML = '<div class="log-line error">Failed to load logs.</div>';
            }
        } catch (error) {
            logContent.innerHTML = '<div class="log-line error">Error: ' + error.message + '</div>';
        }
    };

    // ===========================
    // Backup Management
    // ===========================

    /**
     * Refresh backup list
     */
    const refreshBackups = async function () {
        const backupsList = document.getElementById('backups-list');
        backupsList.innerHTML = '<div class="loading">Loading backups...</div>';

        try {
            const response = await fetch('/api/system/backups');
            if (response.ok) {
                const backups = await response.json();
                if (backups.length === 0) {
                    backupsList.innerHTML = '<div class="empty-state">No backups found.</div>';
                } else {
                    backupsList.innerHTML = backups.map(backup => `
                        <div class="backup-item">
                            <div class="backup-info">
                                <div class="backup-filename">${backup.filename}</div>
                                <div class="backup-meta">
                                    <span class="backup-date">${formatDate(backup.created_at)}</span>
                                    <span class="backup-size">${formatSize(backup.size)}</span>
                                </div>
                            </div>
                            <div class="backup-actions">
                                <button class="btn btn-sm btn-primary" data-action="restore-backup" data-filename="${backup.filename}">Restore</button>
                                <button class="btn btn-sm btn-danger" data-action="delete-backup" data-filename="${backup.filename}">Delete</button>
                            </div>
                        </div>
                    `).join('');
                }
            } else {
                backupsList.innerHTML = '<div class="error-state">Failed to load backups.</div>';
            }
        } catch (error) {
            backupsList.innerHTML = '<div class="error-state">Error: ' + error.message + '</div>';
        }
    };

    /**
     * Restore from backup
     */
    const restoreBackup = async function (filename, btn) {
        // First confirmation
        const confirmed1 = await showConfirm(
            'Restore Backup - Warning',
            'WARNING: This will overwrite ALL current data!\n\nAre you absolutely sure you want to restore from:\n' + filename + '\n\nThis action cannot be undone!',
            'Continue',
            true,
            'Close'
        );
        if (!confirmed1) return;

        // Double confirmation for safety
        const confirmed2 = await showConfirm(
            'Final Confirmation',
            'This is your last chance!\n\nClick "Restore" to proceed, or "Close" to abort.',
            'Restore',
            true,
            'Close'
        );
        if (!confirmed2) return;

        const originalText = btn ? btn.textContent : 'Restore';
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Restoring...';
        }

        try {
            const response = await fetch('/api/system/backups/' + encodeURIComponent(filename) + '/restore', {
                method: 'POST'
            });
            const data = await response.json();
            if (response.ok) {
                await showAlert('Success', 'Backup restored successfully!\n\nThe application will reload now.');
                window.location.reload();
            } else {
                await showAlert('Error', data.detail);
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = originalText;
                }
            }
        } catch (error) {
            await showAlert('Error', error.message);
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }
    };

    /**
     * Delete backup
     */
    const deleteBackup = async function (filename, btn) {
        const confirmed = await showConfirm(
            'Delete Backup',
            'Are you sure you want to delete this backup?\n\n' + filename + '\n\nThis action cannot be undone.',
            'Delete',
            true
        );
        if (!confirmed) return;

        const originalText = btn ? btn.textContent : 'Delete';
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Deleting...';
        }

        try {
            const response = await fetch('/api/system/backups/' + encodeURIComponent(filename), {
                method: 'DELETE'
            });
            const data = await response.json();
            if (response.ok) {
                await showAlert('Success', 'Backup deleted successfully!');
                refreshBackups();
            } else {
                await showAlert('Error', data.detail);
                if (btn) {
                    btn.disabled = false;
                    btn.textContent = originalText;
                }
            }
        } catch (error) {
            await showAlert('Error', error.message);
            if (btn) {
                btn.disabled = false;
                btn.textContent = originalText;
            }
        }
    };

    // ===========================
    // Utility Functions
    // ===========================

    /**
     * Format date for display
     */
    const formatDate = function (dateStr) {
        const date = new Date(dateStr);
        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    };

    /**
     * Format file size for display
     */
    const formatSize = function (bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    };

    // ===========================
    // Initialize
    // ===========================

    function initPage() {
        // Only create modals if they don't exist
        if (!document.getElementById('confirm-modal')) {
            createModals();
        }

        // Initialize page
        const logContent = document.getElementById('log-content');
        if (logContent) {
            logContent.scrollTop = logContent.scrollHeight;
        }
        refreshBackups();

        // Event delegation for dynamic components
        document.addEventListener('click', (e) => {
            // Backup management actions
            const restoreBtn = e.target.closest('[data-action="restore-backup"]');
            if (restoreBtn) {
                restoreBackup(restoreBtn.dataset.filename, restoreBtn);
                return;
            }

            const deleteBtn = e.target.closest('[data-action="delete-backup"]');
            if (deleteBtn) {
                deleteBackup(deleteBtn.dataset.filename, deleteBtn);
                return;
            }

            // Static page actions
            const actionBtn = e.target.closest('[data-action]');
            if (!actionBtn) return;

            const action = actionBtn.dataset.action;
            switch (action) {
                case 'clear-cache':
                    clearCache(actionBtn.dataset.pattern || 'all');
                    break;
                case 'trigger-backup':
                    triggerBackup({ currentTarget: actionBtn });
                    break;
                case 'cleanup-orphaned':
                    cleanupOrphaned();
                    break;
                case 'refresh-backups':
                    refreshBackups();
                    break;
                case 'refresh-logs':
                    refreshLogs();
                    break;
            }
        });

        // Event for log type change
        const logTypeSelect = document.getElementById('log-type');
        if (logTypeSelect) {
            logTypeSelect.addEventListener('change', refreshLogs);
        }
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPage);
    } else {
        initPage();
    }

})();
