/**
 * Global Map initialization
 */
(function() {
    'use strict';

    function getTileUrl(theme) {
        if (theme === 'dark') {
            return 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
        } else {
            return 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
        }
    }

    function getAttribution() {
        return '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
    }

    window.initGlobalMap = function(mapTags) {
        const mapContainer = document.getElementById('map');
        if (!mapContainer) return;

        // Cleanup previous instance if exists
        if (mapContainer._leaflet_id) {
            // This is a bit hacky but Leaflet doesn't have a simple way 
            // to retrieve the map instance from the container easily 
            // without storing it somewhere.
            // We'll just return if already initialized to avoid the error.
            return;
        }

        const currentTheme = window.ThemeManager ? window.ThemeManager.get() : 'light';
        
        const map = L.map('map', {
            scrollWheelZoom: true,
            attributionControl: true
        }).setView([20, 0], 2);

        const tileLayer = L.tileLayer(getTileUrl(currentTheme), {
            attribution: getAttribution(),
            subdomains: 'abcd',
            maxZoom: 19
        }).addTo(map);

        // Add markers
        const markers = [];
        mapTags.forEach(tag => {
            if (tag.lat !== null && tag.lng !== null) {
                const size = Math.min(30, Math.max(12, 10 + Math.sqrt(tag.post_count) * 2));
                
                const marker = L.marker([tag.lat, tag.lng], {
                    icon: L.divIcon({
                        className: 'custom-marker',
                        html: `<div title="${tag.name}: ${tag.post_count} posts" style="width: ${size}px; height: ${size}px;"></div>`,
                        iconSize: [size, size],
                        iconAnchor: [size/2, size/2]
                    })
                }).addTo(map);

                marker.bindTooltip(`
                    <div class="tag-tooltip">
                        <strong>${tag.name}</strong><br>
                        ${tag.post_count} posts
                    </div>
                `, {
                    direction: 'top',
                    offset: [0, -size/2]
                });

                marker.on('click', function() {
                    // Try to use AJAX navigation if available
                    if (window.loadPost && !tag.url.startsWith('http')) {
                        window.loadPost(tag.url);
                    } else {
                        window.location.href = tag.url;
                    }
                });
                
                markers.push([tag.lat, tag.lng]);
            }
        });

        if (markers.length > 0) {
            const bounds = L.latLngBounds(markers);
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
        }

        // Handle theme changes
        const themeHandler = function(e) {
            tileLayer.setUrl(getTileUrl(e.detail.theme));
        };
        window.addEventListener('themechange', themeHandler);

        // Cleanup handler for AJAX navigation
        if (window.addCleanup) {
            window.addCleanup(() => {
                window.removeEventListener('themechange', themeHandler);
                map.remove();
            });
        }
    };
})();
