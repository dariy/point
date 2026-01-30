/**
 * System Page JavaScript - Photo Blog Engine
 * Handles system tools, backups, logs, and modal dialogs
 */

(function() {
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
        const confirmModal = document.createElement('div');
        confirmModal.id = 'confirm-modal';
        confirmModal.className = 'modal';
        confirmModal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3 id="confirm-title">Confirm Action</h3>
                </div>
                <div class="modal-body">
                    <p id="confirm-message"></p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-outline" onclick="closeConfirmModal(false)">Cancel</button>
                    <button class="btn btn-primary" id="confirm-btn" onclick="closeConfirmModal(true)">Confirm</button>
                </div>
            </div>
        `;
        document.body.appendChild(confirmModal);

        // Create alert modal
        const alertModal = document.createElement('div');
        alertModal.id = 'alert-modal';
        alertModal.className = 'modal';
        alertModal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3 id="alert-title">Notification</h3>
                </div>
                <div class="modal-body">
                    <p id="alert-message"></p>
                </div>
                <div class="modal-footer">
                    <button class="btn btn-primary" onclick="closeAlertModal()">OK</button>
                </div>
            </div>
        `;
        document.body.appendChild(alertModal);

        // Close modal on background click
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                if (e.target.id === 'confirm-modal') {
                    closeConfirmModal(false);
                } else if (e.target.id === 'alert-modal') {
                    closeAlertModal();
                }
            }
        });
    }

    /**
     * Show confirmation dialog
     */
    window.showConfirm = function(title, message, confirmText = 'Confirm', isDanger = false) {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirm-modal');
            document.getElementById('confirm-title').textContent = title;
            document.getElementById('confirm-message').textContent = message;
            const confirmBtn = document.getElementById('confirm-btn');
            confirmBtn.textContent = confirmText;
            confirmBtn.className = isDanger ? 'btn btn-danger' : 'btn btn-primary';
            modal.style.display = 'flex';
            confirmCallback = resolve;
        });
    };

    /**
     * Close confirmation dialog
     */
    window.closeConfirmModal = function(result) {
        document.getElementById('confirm-modal').style.display = 'none';
        if (confirmCallback) {
            confirmCallback(result);
            confirmCallback = null;
        }
    };

    /**
     * Show alert dialog
     */
    window.showAlert = function(title, message) {
        return new Promise((resolve) => {
            const modal = document.getElementById('alert-modal');
            document.getElementById('alert-title').textContent = title;
            document.getElementById('alert-message').textContent = message;
            modal.style.display = 'flex';
            alertCallback = resolve;
        });
    };

    /**
     * Close alert dialog
     */
    window.closeAlertModal = function() {
        document.getElementById('alert-modal').style.display = 'none';
        if (alertCallback) {
            alertCallback();
            alertCallback = null;
        }
    };

    // ===========================
    // System Operations
    // ===========================

    /**
     * Clear application cache
     */
    window.clearCache = async function(pattern) {
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
    window.triggerBackup = async function() {
        const btn = event.target;
        btn.disabled = true;
        btn.textContent = 'Backing up...';

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
            btn.disabled = false;
            btn.textContent = 'Backup Now';
        }
    };

    /**
     * Cleanup orphaned media files
     */
    window.cleanupOrphaned = async function() {
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
    window.refreshLogs = async function() {
        const logType = document.getElementById('log-type').value;
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
    window.refreshBackups = async function() {
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
                                <button class="btn btn-sm btn-primary" onclick="restoreBackup('${backup.filename}')">Restore</button>
                                <button class="btn btn-sm btn-danger" onclick="deleteBackup('${backup.filename}')">Delete</button>
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
    window.restoreBackup = async function(filename) {
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

        const btn = event.target;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Restoring...';

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
                btn.disabled = false;
                btn.textContent = originalText;
            }
        } catch (error) {
            await showAlert('Error', error.message);
            btn.disabled = false;
            btn.textContent = originalText;
        }
    };

    /**
     * Delete backup
     */
    window.deleteBackup = async function(filename) {
        const confirmed = await showConfirm(
            'Delete Backup',
            'Are you sure you want to delete this backup?\n\n' + filename + '\n\nThis action cannot be undone.',
            'Delete',
            true
        );
        if (!confirmed) return;

        const btn = event.target;
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Deleting...';

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
                btn.disabled = false;
                btn.textContent = originalText;
            }
        } catch (error) {
            await showAlert('Error', error.message);
            btn.disabled = false;
            btn.textContent = originalText;
        }
    };

    // ===========================
    // Utility Functions
    // ===========================

    /**
     * Format date for display
     */
    window.formatDate = function(dateStr) {
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
    window.formatSize = function(bytes) {
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
    }

    // Initialize on DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initPage);
    } else {
        initPage();
    }

})();
