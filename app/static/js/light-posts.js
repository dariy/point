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
        const search = document.getElementById('search-posts').value;
        
        const url = new URL(window.location);
        
        if (status) {
            url.searchParams.set('status_filter', status);
        } else {
            url.searchParams.delete('status_filter');
        }
        
        if (search) {
            url.searchParams.set('search', search);
        } else {
            url.searchParams.delete('search');
        }
        
        url.searchParams.delete('page');
        window.location = url;
    };

    // Initialize
    const statusFilter = document.querySelector('[data-action="filter-status"]');
    if (statusFilter) {
        statusFilter.addEventListener('change', applyFilters);
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

})();
