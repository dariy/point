/**
 * Tags Management JavaScript - Photo Blog Engine
 * Handles tag creation, editing, and property toggling
 */

(function () {
    'use strict';

    const modal = document.getElementById('tag-modal');
    const form = document.getElementById('tag-form');

    if (!modal || !form) return;

    // Restore view preference
    const savedView = localStorage.getItem('tags-view-preference');
    if (savedView && savedView !== 'list') {
        const tabLink = document.querySelector(`.tab-link[data-tab="${savedView}"]`);
        if (tabLink) tabLink.click();
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
    const editTag = async function (id, name, slug, description, isImportant, isFeatured, isHidden, isHiddenPosts, isShowRelated, parentIds, childIds) {
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
            const parentIds = editBtn.dataset.tagParents || '[]';
            const childIds = editBtn.dataset.tagChildren || '[]';
            editTag(id, name, slug, description, isImportant, isFeatured, isHidden, isHiddenPosts, isShowRelated, parentIds, childIds);
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

})();
