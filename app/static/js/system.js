/**
 * System Page JavaScript - Photo Blog Engine
 * Handles system tools, backups, logs, and modal dialogs
 */

(function () {
    'use strict';

    // ===========================
    // Modal Dialog System
    // ===========================

    let confirmCallback = null;
    let alertCallback = null;

    /**
     * Create modal dialog elements
     */
    function createModals() {
        // Create confirm modal
        const confirmOverlay = document.createElement('div');
        confirmOverlay.id = 'confirm-modal';
        confirmOverlay.className = 'modal-overlay';
        confirmOverlay.innerHTML = `
            <div class="modal">
                <div class="modal-header">
                    <h3 id="confirm-title">Confirm Action</h3>
                </div>
                <div class="modal-body">
                    <p id="confirm-message"></p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-outline" data-action="confirm-cancel">Cancel</button>
                    <button class="btn btn-primary" id="confirm-btn" data-action="confirm-ok">Confirm</button>
                </div>
            </div>
        `;
        document.body.appendChild(confirmOverlay);

        // Create alert modal
        const alertOverlay = document.createElement('div');
        alertOverlay.id = 'alert-modal';
        alertOverlay.className = 'modal-overlay';
        alertOverlay.innerHTML = `
            <div class="modal">
                <div class="modal-header">
                    <h3 id="alert-title">Notification</h3>
                </div>
                <div class="modal-body">
                    <p id="alert-message"></p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-primary" data-action="alert-ok">OK</button>
                </div>
            </div>
        `;
        document.body.appendChild(alertOverlay);

        // Event listeners for modals
        confirmOverlay.addEventListener('click', (e) => {
            if (e.target === confirmOverlay || e.target.closest('[data-action="confirm-cancel"]')) {
                closeConfirmModal(false);
            } else if (e.target.closest('[data-action="confirm-ok"]')) {
                closeConfirmModal(true);
            }
        });

        alertOverlay.addEventListener('click', (e) => {
            if (e.target === alertOverlay || e.target.closest('[data-action="alert-ok"]')) {
                closeAlertModal();
            }
        });
    }

    /**
     * Show confirmation dialog
     */
    const showConfirm = function (title, message, confirmText = 'Confirm', isDanger = false) {
        return new Promise((resolve) => {
            // Ensure modals are created
            const modalExists = !!document.getElementById('confirm-modal');
            if (!modalExists) {
                createModals();
                // Defer to allow innerHTML to be parsed
                setTimeout(() => {
                    const modal = document.getElementById('confirm-modal');
                    const titleEl = document.getElementById('confirm-title');
                    const messageEl = document.getElementById('confirm-message');
                    const confirmBtn = document.getElementById('confirm-btn');

                    if (!modal || !titleEl || !messageEl || !confirmBtn) {
                        console.error('Modal elements still not found after creation');
                        resolve(window.confirm(message));
                        return;
                    }

                    titleEl.textContent = title;
                    messageEl.textContent = message;
                    confirmBtn.textContent = confirmText;
                    confirmBtn.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';
                    modal.classList.add('active');
                    confirmCallback = resolve;
                }, 0);
                return;
            }

            const modal = document.getElementById('confirm-modal');
            const titleEl = document.getElementById('confirm-title');
            const messageEl = document.getElementById('confirm-message');
            const confirmBtn = document.getElementById('confirm-btn');

            // Safety checks - only log error if modal should exist
            if (!modal || !titleEl || !messageEl || !confirmBtn) {
                // Fallback to native confirm
                resolve(window.confirm(message));
                return;
            }

            titleEl.textContent = title;
            messageEl.textContent = message;
            confirmBtn.textContent = confirmText;
            confirmBtn.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';
            modal.classList.add('active');
            confirmCallback = resolve;
        });
    };

    /**
     * Close confirmation dialog
     */
    const closeConfirmModal = function (result) {
        const modal = document.getElementById('confirm-modal');
        if (!modal) return;

        modal.classList.add('closing');
        setTimeout(() => {
            modal.classList.remove('active');
            modal.classList.remove('closing');
            if (confirmCallback) {
                confirmCallback(result);
                confirmCallback = null;
            }
        }, 300);
    };

    /**
     * Show alert dialog
     */
    const showAlert = function (title, message) {
        return new Promise((resolve) => {
            // Ensure modals are created
            const modalExists = !!document.getElementById('alert-modal');
            if (!modalExists) {
                createModals();
                // Defer to allow innerHTML to be parsed
                setTimeout(() => {
                    const modal = document.getElementById('alert-modal');
                    const titleEl = document.getElementById('alert-title');
                    const messageEl = document.getElementById('alert-message');

                    if (!modal || !titleEl || !messageEl) {
                        console.error('Alert modal elements still not found after creation');
                        window.alert(message);
                        resolve();
                        return;
                    }

                    titleEl.textContent = title;
                    messageEl.textContent = message;
                    modal.classList.add('active');
                    alertCallback = resolve;
                }, 0);
                return;
            }

            const modal = document.getElementById('alert-modal');
            const titleEl = document.getElementById('alert-title');
            const messageEl = document.getElementById('alert-message');

            // Safety checks
            if (!modal || !titleEl || !messageEl) {
                // Fallback to native alert
                window.alert(message);
                resolve();
                return;
            }

            titleEl.textContent = title;
            messageEl.textContent = message;
            modal.classList.add('active');
            alertCallback = resolve;
        });
    };

    /**
     * Close alert dialog
     */
    const closeAlertModal = function () {
        const modal = document.getElementById('alert-modal');
        if (!modal) return;

        modal.classList.add('closing');
        setTimeout(() => {
            modal.classList.remove('active');
            modal.classList.remove('closing');
            if (alertCallback) {
                alertCallback();
                alertCallback = null;
            }
        }, 300);
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
        const btn = event ? event.currentTarget : null;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Backing up...';
        }

        try {
            const response = await fetch('/api/system/backup', { method: 'POST' });
            const data = await response.json();
            if (response.ok) {
                await showAlert('Success', 'Backup created successfully!\nPath: ' + data.path);
                location.reload();
            } else {
                await showAlert('Error', data.detail);
            }
        } catch (error) {
            await showAlert('Error', error.message);
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Backup Now';
            }
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
            true
        );
        if (!confirmed1) return;

        // Double confirmation for safety
        const confirmed2 = await showConfirm(
            'Final Confirmation',
            'This is your last chance!\n\nClick "Restore" to proceed, or "Cancel" to abort.',
            'Restore',
            true
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
