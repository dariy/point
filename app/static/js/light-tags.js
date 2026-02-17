/**
 * Tags Management JavaScript - Photo Blog Engine
 * Handles tag creation, editing, and property toggling
 */

(function () {
    'use strict';

    const modal = document.getElementById('tag-modal');
    const form = document.getElementById('tag-form');
    const locationsContainer = document.getElementById('tag-locations-container');
    const addLocationBtn = document.getElementById('add-location-btn');

    if (!modal || !form) return;

    /**
     * Create location input row
     */
    const createLocationRow = function (lat = '', lng = '') {
        const row = document.createElement('div');
        row.className = 'flex gap-2 items-center mb-2';
        row.innerHTML = `
            <input type="number" step="any" class="form-input flex-1 location-lat" placeholder="Latitude" value="${lat}">
            <input type="number" step="any" class="form-input flex-1 location-lng" placeholder="Longitude" value="${lng}">
            <button type="button" class="btn btn-sm btn-danger remove-location-btn" title="Remove location">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
                    <path d="M19 13H5v-2h14v2z" />
                </svg>
            </button>
        `;
        
        row.querySelector('.remove-location-btn').addEventListener('click', () => {
            row.remove();
        });
        
        return row;
    };

    if (addLocationBtn) {
        addLocationBtn.addEventListener('click', () => {
            locationsContainer.appendChild(createLocationRow());
        });
    }

    // Use LightUtils.Modal if available
    const modalInstance = (window.LightUtils && window.LightUtils.Modal)
        ? new window.LightUtils.Modal(modal)
        : {
            open: () => modal.classList.add('active'),
            close: () => {
                modal.classList.add('closing');
                setTimeout(() => {
                    modal.classList.remove('active');
                    modal.classList.remove('closing');
                }, 300);
            }
        };

    /**
     * Open modal for creating new tag
     */
    const openNewTagModal = function () {
        document.getElementById('modal-title').textContent = 'New Tag';
        document.getElementById('tag-id').value = '';
        document.getElementById('tag-name').value = '';
        document.getElementById('tag-slug').value = '';
        document.getElementById('tag-description').value = '';
        document.getElementById('tag-important').checked = false;
        document.getElementById('tag-featured').checked = false;
        document.getElementById('tag-hidden').checked = false;
        document.getElementById('tag-hidden-posts').checked = false;
        document.getElementById('tag-show-related').checked = false;
        locationsContainer.innerHTML = '';

        // Clear chip checkboxes in parents picker
        const parentChips = document.querySelectorAll('#tag-parents-picker input[type="checkbox"]');
        parentChips.forEach(chip => {
            chip.checked = false;
            const container = chip.closest('.category-chip');
            if (container) {
                container.classList.remove('hidden');
                container.classList.add('visible-block');
            }
        });

        // Clear chip checkboxes in children picker
        const childChips = document.querySelectorAll('#tag-children-picker input[type="checkbox"]');
        childChips.forEach(chip => {
            chip.checked = false;
            const container = chip.closest('.category-chip');
            if (container) {
                container.classList.remove('hidden');
                container.classList.add('visible-block');
            }
        });

        modalInstance.open();
    };

    /**
     * Open modal for editing existing tag
     */
    const editTag = async function (id, name, slug, description, isImportant, isFeatured, isHidden, isHiddenPosts, isShowRelated, locations, parentIds, childIds) {
        document.getElementById('modal-title').textContent = 'Edit Tag';
        document.getElementById('tag-id').value = id;
        document.getElementById('tag-name').value = name;
        document.getElementById('tag-slug').value = slug;
        document.getElementById('tag-description').value = description || '';
        document.getElementById('tag-important').checked = !!isImportant;
        document.getElementById('tag-featured').checked = !!isFeatured;
        document.getElementById('tag-hidden').checked = !!isHidden;
        document.getElementById('tag-hidden-posts').checked = !!isHiddenPosts;
        document.getElementById('tag-show-related').checked = !!isShowRelated;
        
        locationsContainer.innerHTML = '';
        let locs = [];
        try {
            locs = typeof locations === 'string' ? JSON.parse(locations) : (locations || []);
        } catch (e) {
            console.warn('Failed to parse locations:', e);
        }
        locs.forEach(loc => {
            locationsContainer.appendChild(createLocationRow(loc.latitude, loc.longitude));
        });

        const parentChips = document.querySelectorAll('#tag-parents-picker input[type="checkbox"]');
        if (parentChips.length) {
            let ids = [];
            try {
                ids = typeof parentIds === 'string' ? JSON.parse(parentIds) : (parentIds || []);
                ids = ids.map(id => parseInt(id));
            } catch (e) {
                console.warn('Failed to parse parentIds:', e);
            }

            parentChips.forEach(chip => {
                const chipValue = parseInt(chip.value);
                chip.checked = ids.includes(chipValue);
                // Hide self from selection to prevent circular/self reference
                const container = chip.closest('.category-chip');
                if (container) {
                    const isHidden = chipValue == id;
                    container.classList.toggle('hidden', isHidden);
                    container.classList.toggle('visible-block', !isHidden);
                }
                if (chipValue == id) chip.checked = false;
            });
        }

        const childChips = document.querySelectorAll('#tag-children-picker input[type="checkbox"]');
        if (childChips.length) {
            let ids = [];
            try {
                ids = typeof childIds === 'string' ? JSON.parse(childIds) : (childIds || []);
                ids = ids.map(id => parseInt(id));
            } catch (e) {
                console.warn('Failed to parse childIds:', e);
            }

            childChips.forEach(chip => {
                const chipValue = parseInt(chip.value);
                chip.checked = ids.includes(chipValue);
                // Hide self from selection to prevent circular/self reference
                const container = chip.closest('.category-chip');
                if (container) {
                    const isHidden = chipValue == id;
                    container.classList.toggle('hidden', isHidden);
                    container.classList.toggle('visible-block', !isHidden);
                }
                if (chipValue == id) chip.checked = false;
            });
        }

        modalInstance.open();

        // Try to fetch fresh data
        try {
            const response = await fetch(`/api/tags/${id}`, { credentials: 'include' });
            if (response.ok) {
                const tag = await response.json();
                document.getElementById('tag-name').value = tag.name;
                document.getElementById('tag-slug').value = tag.slug;
                document.getElementById('tag-description').value = tag.description || '';
                document.getElementById('tag-important').checked = tag.is_important;
                document.getElementById('tag-featured').checked = tag.is_featured;
                document.getElementById('tag-hidden').checked = tag.is_hidden;
                document.getElementById('tag-hidden-posts').checked = tag.is_hidden_posts;
                document.getElementById('tag-show-related').checked = tag.show_related_tags_as_children;
                
                locationsContainer.innerHTML = '';
                if (tag.locations) {
                    tag.locations.forEach(loc => {
                        locationsContainer.appendChild(createLocationRow(loc.latitude, loc.longitude));
                    });
                }

                if (parentChips.length) {
                    const ids = tag.parents ? tag.parents.map(p => parseInt(p.id)) : [];
                    parentChips.forEach(chip => {
                        const chipValue = parseInt(chip.value);
                        chip.checked = ids.includes(chipValue);
                        const container = chip.closest('.category-chip');
                        if (container) {
                            const isHidden = chipValue == tag.id;
                            container.classList.toggle('hidden', isHidden);
                            container.classList.toggle('visible-block', !isHidden);
                        }
                        if (chipValue == tag.id) chip.checked = false;
                    });
                }

                if (childChips.length) {
                    const ids = tag.children ? tag.children.map(p => parseInt(p.id)) : [];
                    childChips.forEach(chip => {
                        const chipValue = parseInt(chip.value);
                        chip.checked = ids.includes(chipValue);
                        const container = chip.closest('.category-chip');
                        if (container) {
                            const isHidden = chipValue == tag.id;
                            container.classList.toggle('hidden', isHidden);
                            container.classList.toggle('visible-block', !isHidden);
                        }
                        if (chipValue == tag.id) chip.checked = false;
                    });
                }
            }
        } catch (error) {
            console.warn('Failed to fetch fresh tag data:', error);
        }
    };

    /**
     * Close tag modal
     */
    const closeTagModal = function () {
        modalInstance.close();
    };

    /**
     * Toggle tag property (important/featured)
     */
    const toggleTagProperty = async function (id, property, currentValue) {
        const newValue = !currentValue;
        const data = {};
        data[property] = newValue;

        // Determine button ID based on property
        let btnId;
        if (property === 'is_important') {
            btnId = `toggle-important-${id}`;
        } else if (property === 'is_featured') {
            btnId = `toggle-featured-${id}`;
        } else if (property === 'is_hidden') {
            btnId = `toggle-hidden-${id}`;
        } else if (property === 'is_hidden_posts') {
            btnId = `toggle-hidden-posts-${id}`;
        }

        const btn = document.getElementById(btnId);

        if (!btn) return;

        // Optimistic UI update or loading state
        btn.classList.add('opacity-50');
        btn.disabled = true;

        try {
            const response = await fetch(`/api/tags/${id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data),
                credentials: 'include'
            });

            if (response.ok) {
                const tag = await response.json();

                // Update button state 
                btn.disabled = false;
                btn.classList.remove('opacity-50');
                btn.classList.add('opacity-100');

                // Update data attribute for next toggle
                btn.dataset.value = newValue ? 'true' : 'false';

                // Update SVG and titles
                const svg = btn.querySelector('svg');
                if (property === 'is_important') {
                    svg.setAttribute('fill', newValue ? 'var(--color-warning)' : 'var(--text-muted)');
                    svg.style.opacity = newValue ? '1' : '0.3';
                    btn.title = newValue ? 'Remove important mark' : 'Mark as important';

                    // Update the tag name link class if it exists in this row
                    const nameLink = btn.closest('tr').querySelector('td a.tag');
                    if (nameLink) {
                        if (newValue) {
                            nameLink.classList.add('tag-important');
                            nameLink.dataset.tagImportant = 'true';
                        } else {
                            nameLink.classList.remove('tag-important');
                            nameLink.dataset.tagImportant = 'false';
                        }
                    }
                } else if (property === 'is_featured') {
                    svg.setAttribute('fill', newValue ? 'var(--color-primary)' : 'var(--text-muted)');
                    svg.style.opacity = newValue ? '1' : '0.3';
                    btn.title = newValue ? 'Remove featured mark' : 'Mark as featured';
                } else if (property === 'is_hidden') {
                    svg.setAttribute('fill', newValue ? 'var(--color-danger)' : 'var(--text-muted)');
                    svg.style.opacity = newValue ? '1' : '0.3';
                    btn.title = newValue ? 'Unhide tag' : 'Hide tag';
                    // Update data attribute of edit buttons in the same row
                    const editBtns = btn.closest('tr').querySelectorAll('[data-action="edit-tag"]');
                    editBtns.forEach(eb => eb.dataset.tagHidden = newValue ? 'true' : 'false');
                } else if (property === 'is_hidden_posts') {
                    svg.setAttribute('fill', newValue ? 'var(--color-danger)' : 'var(--text-muted)');
                    svg.style.opacity = newValue ? '1' : '0.3';
                    btn.title = newValue ? 'Show posts' : 'Hide posts';
                    // Update data attribute of edit buttons in the same row
                    const editBtns = btn.closest('tr').querySelectorAll('[data-action="edit-tag"]');
                    editBtns.forEach(eb => eb.dataset.tagHiddenPosts = newValue ? 'true' : 'false');
                }

                if (window.LightUtils && window.LightUtils.showToast) {
                    window.LightUtils.showToast('Updated successfully');
                }
            } else {
                const errorData = await response.json().catch(() => ({}));
                const msg = errorData.detail || 'Failed to update tag';
                if (window.LightUtils && window.LightUtils.showToast) {
                    window.LightUtils.showToast(msg, 'error');
                }
                btn.disabled = false;
                btn.classList.remove('opacity-50');
                btn.classList.add('opacity-100');
            }
        } catch (error) {
            console.error('Toggle error:', error);
            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast('An error occurred', 'error');
            }
            btn.disabled = false;
            btn.classList.remove('opacity-50');
            btn.classList.add('opacity-100');
        }
    };

    /**
     * Initialize drag and drop for tree view
     */
    const initDragAndDrop = function () {
        const treeView = document.querySelector('.tree-view');
        if (!treeView) return;

        let draggedTagId = null;

        treeView.addEventListener('dragstart', function (e) {
            const row = e.target.closest('.tree-row');
            if (!row) return;

            draggedTagId = row.dataset.tagId;
            row.classList.add('dragging');
            e.dataTransfer.setData('text/plain', draggedTagId);
            e.dataTransfer.effectAllowed = 'move';
        });

        treeView.addEventListener('dragend', function (e) {
            const row = e.target.closest('.tree-row');
            if (row) row.classList.remove('dragging');
            
            // Remove all drag-over classes
            document.querySelectorAll('.tree-row.drag-over').forEach(el => el.classList.remove('drag-over'));
            document.querySelectorAll('.tree-view.drag-over').forEach(el => el.classList.remove('drag-over'));
        });

        treeView.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            
            // Remove existing drag-overs
            document.querySelectorAll('.tree-row.drag-over').forEach(el => el.classList.remove('drag-over'));
            treeView.classList.remove('drag-over');

            const row = e.target.closest('.tree-row');
            if (row) {
                const targetId = row.dataset.tagId;
                
                // Prevent dropping on self
                if (targetId === draggedTagId) return;

                // Prevent dropping on descendants
                const draggedRow = document.getElementById(`tree-tag-${draggedTagId}`);
                const draggedNode = draggedRow ? draggedRow.closest('.tree-node') : null;
                if (draggedNode && draggedNode.contains(row)) return;

                row.classList.add('drag-over');
            } else if (e.target.closest('.tree-view')) {
                treeView.classList.add('drag-over');
            }
        });

        treeView.addEventListener('dragleave', function (e) {
            const row = e.target.closest('.tree-row');
            if (row) {
                const relatedTarget = e.relatedTarget;
                if (!relatedTarget || !row.contains(relatedTarget)) {
                    row.classList.remove('drag-over');
                }
            }
            
            if (e.target === treeView) {
                const relatedTarget = e.relatedTarget;
                if (!relatedTarget || !treeView.contains(relatedTarget)) {
                    treeView.classList.remove('drag-over');
                }
            }
        });

        treeView.addEventListener('drop', async function (e) {
            e.preventDefault();
            const targetRow = e.target.closest('.tree-row');
            const targetTreeView = e.target.closest('.tree-view');
            
            const sourceId = e.dataTransfer.getData('text/plain');
            let targetId = targetRow ? targetRow.dataset.tagId : null;

            if (sourceId === targetId) return;

            // If dropped on tree view but not on a row, it means move to root
            // But we need to be sure it's not dropped inside a row's children
            if (!targetRow && targetTreeView) {
                targetId = null;
            }

            const confirmed = window.LightUtils && window.LightUtils.confirm
                ? await window.LightUtils.confirm(`Move this tag under ${targetRow ? 'the selected tag' : 'root'}?`, { okVariant: 'primary' })
                : confirm(`Move this tag under ${targetRow ? 'the selected tag' : 'root'}?`);

            if (confirmed) {
                await moveTag(sourceId, targetId);
            }
        });
    };

    /**
     * Move tag to a new parent
     */
    const moveTag = async function (tagId, newParentId) {
        try {
            const parentIds = newParentId ? [parseInt(newParentId)] : [];
            
            const response = await fetch(`/api/tags/${tagId}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    parent_ids: parentIds
                }),
                credentials: 'include'
            });

            if (response.ok) {
                // Instead of full reload, fetch the updated tree HTML
                const refreshResponse = await fetch(window.location.href);
                if (refreshResponse.ok) {
                    const html = await refreshResponse.text();
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');
                    
                    // Update tree view
                    const newTreeView = doc.querySelector('.tree-view');
                    const currentTreeView = document.querySelector('.tree-view');
                    if (newTreeView && currentTreeView) {
                        currentTreeView.innerHTML = newTreeView.innerHTML;
                        // Re-initialize drag and drop for the new content if needed
                        // (Actually we use event delegation on treeView so it should work)
                    }

                    // Also update list view table if it exists
                    const newListTable = doc.querySelector('#list-view .table');
                    const currentListTable = document.querySelector('#list-view .table');
                    if (newListTable && currentListTable) {
                        currentListTable.innerHTML = newListTable.innerHTML;
                    }

                    if (window.LightUtils && window.LightUtils.showToast) {
                        window.LightUtils.showToast('Moved successfully');
                    }
                } else {
                    window.location.reload();
                }
            } else {
                const errorData = await response.json().catch(() => ({}));
                const msg = errorData.detail || 'Failed to move tag';
                if (window.LightUtils && window.LightUtils.showToast) {
                    window.LightUtils.showToast(msg, 'error');
                }
            }
        } catch (error) {
            console.error('Move error:', error);
            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast('An error occurred', 'error');
            }
        }
    };

    // Event Delegation
    document.addEventListener('click', function (e) {
        // Tab switching
        const tabLink = e.target.closest('.tab-link');
        if (tabLink) {
            const tabName = tabLink.dataset.tab;
            
            // Update active tab link
            document.querySelectorAll('.tab-link').forEach(link => link.classList.remove('active'));
            tabLink.classList.add('active');
            
            // Update active tab content
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            document.getElementById(`${tabName}-view`).classList.add('active');
            
            // Store preference
            localStorage.setItem('tags-view-preference', tabName);
            return;
        }

        // Tree node toggling
        const treeToggle = e.target.closest('[data-action="toggle-tree-node"]');
        if (treeToggle) {
            const node = treeToggle.closest('.tree-node');
            const children = node.querySelector('.tree-children');
            if (children) {
                const isExpanded = children.classList.toggle('expanded');
                treeToggle.classList.toggle('expanded', isExpanded);
            }
            return;
        }

        // New Tag
        if (e.target.closest('[data-action="new-tag"]')) {
            e.preventDefault();
            openNewTagModal();
            return;
        }

        // Close Modal
        if (e.target.closest('[data-action="close-tag-modal"]')) {
            e.preventDefault();
            closeTagModal();
            return;
        }

        // Edit Tag
        const editBtn = e.target.closest('[data-action="edit-tag"]');
        if (editBtn) {
            e.preventDefault();
            const id = editBtn.dataset.tagId;
            const name = editBtn.dataset.tagName;
            const slug = editBtn.dataset.tagSlug;
            const description = editBtn.dataset.tagDescription;
            const isImportant = editBtn.dataset.tagImportant === 'true';
            const isFeatured = editBtn.dataset.tagFeatured === 'true';
            const isHidden = editBtn.dataset.tagHidden === 'true';
            const isHiddenPosts = editBtn.dataset.tagHiddenPosts === 'true';
            const isShowRelated = editBtn.dataset.tagShowRelated === 'true';
            const locations = editBtn.dataset.tagLocations || '[]';
            const parentIds = editBtn.dataset.tagParents || '[]';
            const childIds = editBtn.dataset.tagChildren || '[]';
            editTag(id, name, slug, description, isImportant, isFeatured, isHidden, isHiddenPosts, isShowRelated, locations, parentIds, childIds);
            return;
        }

        // Toggle Property
        const toggleBtn = e.target.closest('[data-action="toggle-tag-property"]');
        if (toggleBtn) {
            e.preventDefault();
            const id = toggleBtn.dataset.tagId;
            const property = toggleBtn.dataset.property;
            const value = toggleBtn.dataset.value === 'true';
            toggleTagProperty(id, property, value);
            return;
        }
    });

    // Form submission
    form.addEventListener('submit', async function (e) {
        e.preventDefault();

        const id = document.getElementById('tag-id').value;
        const data = {
            name: document.getElementById('tag-name').value,
            slug: document.getElementById('tag-slug').value || null,
            description: document.getElementById('tag-description').value || null,
            is_important: document.getElementById('tag-important').checked,
            is_featured: document.getElementById('tag-featured').checked,
            is_hidden: document.getElementById('tag-hidden').checked,
            is_hidden_posts: document.getElementById('tag-hidden-posts').checked,
            show_related_tags_as_children: document.getElementById('tag-show-related').checked,
            locations: Array.from(locationsContainer.querySelectorAll('.flex')).map(row => ({
                latitude: parseFloat(row.querySelector('.location-lat').value),
                longitude: parseFloat(row.querySelector('.location-lng').value)
            })).filter(loc => !isNaN(loc.latitude) && !isNaN(loc.longitude)),
            parent_ids: Array.from(document.querySelectorAll('#tag-parents-picker input:checked')).map(cb => parseInt(cb.value)),
            child_ids: Array.from(document.querySelectorAll('#tag-children-picker input:checked')).map(cb => parseInt(cb.value))
        };

        const url = id ? `/api/tags/${id}` : '/api/tags';
        const method = id ? 'PUT' : 'POST';

        // Disable submit button
        const submitBtn = form.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn ? submitBtn.textContent : 'Save';
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Saving...';
        }

        try {
            const response = await fetch(url, {
                method: method,
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data),
                credentials: 'include'
            });

            if (response.ok) {
                window.location.reload();
            } else {
                const errorData = await response.json().catch(() => ({}));
                const msg = errorData.detail || 'Failed to save tag';
                if (window.LightUtils && window.LightUtils.showToast) {
                    window.LightUtils.showToast(msg, 'error');
                }
                if (submitBtn) {
                    submitBtn.disabled = false;
                    submitBtn.textContent = originalBtnText;
                }
            }
        } catch (error) {
            console.error('Save error:', error);
            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast('An error occurred', 'error');
            }
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = originalBtnText;
            }
        }
    });

    // Initialize drag and drop
    initDragAndDrop();

    // Restore view preference
    const savedView = localStorage.getItem('tags-view-preference');
    if (savedView && savedView !== 'list') {
        const tabLink = document.querySelector(`.tab-link[data-tab="${savedView}"]`);
        if (tabLink) tabLink.click();
    }

})();
