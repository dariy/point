/**
 * Posts List JavaScript - Photo Blog Engine
 * Handles post filtering and list management
 */

(function () {
    'use strict';

    /**
     * Filter posts by status and search
     */
    const applyFilters = function () {
        const status = document.querySelector('[data-action="filter-status"]').value;
        const tag = document.querySelector('[data-action="filter-tag"]').value;
        const search = document.getElementById('search-posts').value;
        
        const url = new URL(window.location);
        
        if (status) {
            url.searchParams.set('status_filter', status);
        } else {
            url.searchParams.delete('status_filter');
        }

        if (tag) {
            url.searchParams.set('tag_id', tag);
        } else {
            url.searchParams.delete('tag_id');
        }
        
        if (search) {
            url.searchParams.set('search', search);
        } else {
            url.searchParams.delete('search');
        }
        
        url.searchParams.delete('page');
        window.location = url;
    };

    /**
     * Handle post status change
     */
    const handleStatusChange = async function (e) {
        const select = e.target;
        const postId = select.dataset.postId;
        const newStatus = select.value;
        const originalStatus = select.querySelector('option[selected]') ? select.querySelector('option[selected]').value : '';

        // Visual feedback - loading state
        select.disabled = true;
        const originalClass = select.className;
        select.className = 'status-select badge-loading';

        try {
            const response = await fetch(`/api/posts/${postId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ status: newStatus }),
                credentials: 'include'
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || 'Failed to update status');
            }

            // Success
            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast('Status updated successfully');
            }

            // Update UI
            select.className = `status-select badge-${newStatus}`;
            
            // Update selected attribute for future reference
            const options = select.querySelectorAll('option');
            options.forEach(opt => {
                if (opt.value === newStatus) {
                    opt.setAttribute('selected', 'selected');
                } else {
                    opt.removeAttribute('selected');
                }
            });

            // If we are on a filtered view, we might want to reload or remove the row
            const currentFilter = document.querySelector('[data-action="filter-status"]').value;
            if (currentFilter && currentFilter !== newStatus) {
                const row = select.closest('tr');
                if (row) {
                    row.classList.add('opacity-0');
                    setTimeout(() => row.remove(), 300);
                }
            }

        } catch (error) {
            console.error('Status change error:', error);
            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast(error.message, 'error');
            }
            // Revert UI
            select.value = originalStatus;
            select.className = originalClass;
        } finally {
            select.disabled = false;
        }
    };

    // Initialize
    const statusFilter = document.querySelector('[data-action="filter-status"]');
    if (statusFilter) {
        statusFilter.addEventListener('change', applyFilters);
    }

    const tagFilter = document.querySelector('[data-action="filter-tag"]');
    if (tagFilter) {
        tagFilter.addEventListener('change', applyFilters);
    }

    const searchInput = document.getElementById('search-posts');
    const searchBtn = document.getElementById('search-btn');

    if (searchBtn) {
        searchBtn.addEventListener('click', applyFilters);
    }

    if (searchInput) {
        searchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                applyFilters();
            }
        });
    }

    // Status change listener
    document.querySelectorAll('[data-action="change-status"]').forEach(select => {
        select.addEventListener('change', handleStatusChange);
    });

})();
