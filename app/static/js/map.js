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

    window.initGlobalMap = async function(mapTags) {
        const mapContainer = document.getElementById('map');
        if (!mapContainer) return;

        if (mapContainer._leaflet_id) return;

        const currentTheme = window.ThemeManager ? window.ThemeManager.get() : 'light';
        
        // Define world bounds to prevent horizontal repetition
        const corner1 = L.latLng(-90, -180);
        const corner2 = L.latLng(90, 180);
        const bounds = L.latLngBounds(corner1, corner2);

        const map = L.map('map', {
            scrollWheelZoom: true,
            attributionControl: true,
            minZoom: 2,
            maxBounds: bounds,
            maxBoundsViscosity: 1.0,
            worldCopyJump: false
        }).setView([20, 0], 2);

        const tileLayer = L.tileLayer(getTileUrl(currentTheme), {
            attribution: getAttribution(),
            subdomains: 'abcd',
            maxZoom: 19,
            noWrap: true,
            bounds: bounds
        }).addTo(map);

        // Load country boundaries
        let geoJsonLayer;
        try {
            const response = await fetch('/static/vendor/leaflet/countries.geojson');
            const countriesData = await response.json();
            
            // Map country names to tags for quick lookup
            const countryTags = {};
            mapTags.forEach(tag => {
                if (tag.type === 'country' || tag.type === 'city') {
                    countryTags[tag.name.toLowerCase()] = tag;
                }
            });

            geoJsonLayer = L.geoJSON(countriesData, {
                style: function(feature) {
                    const countryName = feature.properties.name.toLowerCase();
                    const tag = countryTags[countryName];
                    const isHighlighted = !!tag;
                    
                    return {
                        fillColor: isHighlighted ? 'var(--accent-primary, #3b82f6)' : 'transparent',
                        weight: isHighlighted ? 1.5 : 0,
                        opacity: isHighlighted ? 0.8 : 0,
                        color: isHighlighted ? 'white' : 'transparent',
                        fillOpacity: isHighlighted ? 0.3 : 0
                    };
                },
                onEachFeature: function(feature, layer) {
                    const countryName = feature.properties.name.toLowerCase();
                    const tag = countryTags[countryName];
                    
                    if (tag) {
                        layer.bindTooltip(`
                            <div class="tag-tooltip">
                                <strong>${tag.name}</strong><br>
                                ${tag.post_count} posts
                            </div>
                        `, { sticky: true, direction: 'auto' });

                        layer.on({
                            mouseover: function(e) {
                                const l = e.target;
                                l.setStyle({
                                    fillOpacity: 0.6,
                                    weight: 2
                                });
                            },
                            mouseout: function(e) {
                                geoJsonLayer.resetStyle(e.target);
                            },
                            click: function() {
                                if (window.loadPost && !tag.url.startsWith('http')) {
                                    window.loadPost(tag.url);
                                } else {
                                    window.location.href = tag.url;
                                }
                            }
                        });
                    }
                }
            }).addTo(map);
        } catch (e) {
            console.error("[Map] Failed to load boundaries:", e);
        }

        // Add markers for cities and other types
        const markers = [];
        mapTags.forEach(tag => {
            if (tag.lat !== null && tag.lng !== null && tag.type !== 'country') {
                const size = Math.min(30, Math.max(12, 10 + Math.sqrt(tag.post_count) * 2));
                
                // Determine if it should have a visible label (for cities)
                const isCity = tag.type === 'city';
                const labelHtml = isCity ? `<div class="marker-label">${tag.name}</div>` : '';

                const marker = L.marker([tag.lat, tag.lng], {
                    icon: L.divIcon({
                        className: 'custom-marker-wrapper',
                        html: `
                            <div class="custom-marker" title="${tag.name}: ${tag.post_count} posts" style="width: ${size}px; height: ${size}px;"></div>
                            ${labelHtml}
                        `,
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
                    if (window.loadPost && !tag.url.startsWith('http')) {
                        window.loadPost(tag.url);
                    } else {
                        window.location.href = tag.url;
                    }
                });
                
                markers.push([tag.lat, tag.lng]);
            } else if (tag.type === 'country') {
                // Still add to bounds if it's a country
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
