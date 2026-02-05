/**
 * Posts List JavaScript - Photo Blog Engine
 * Handles post filtering and list management
 */

(function () {
    'use strict';

    /**
     * Filter posts by status
     */
    const filterByStatus = function (status) {
        const url = new URL(window.location);
        if (status) {
            url.searchParams.set('status_filter', status);
        } else {
            url.searchParams.delete('status_filter');
        }
        url.searchParams.delete('page');
        window.location = url;
    };

    // Initialize
    const statusFilter = document.querySelector('[data-action="filter-status"]');
    if (statusFilter) {
        statusFilter.addEventListener('change', (e) => filterByStatus(e.target.value));
    }

})();
