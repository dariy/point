/**
 * Tags Management JavaScript - Photo Blog Engine
 * Handles tag creation, editing, and property toggling
 */

(function () {
    'use strict';

    const modal = document.getElementById('tag-modal');
    const form = document.getElementById('tag-form');

    if (!modal || !form) return;

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

        document.getElementById('tag-parents').selectedIndex = -1;
        // Show all options in parents list
        const parentsSelect = document.getElementById('tag-parents');
        Array.from(parentsSelect.options).forEach(opt => {
            opt.selected = false;
            opt.style.display = 'block';
        });

        modalInstance.open();
    };

    /**
     * Open modal for editing existing tag
     */
    const editTag = async function (id, name, slug, description, isImportant, isFeatured, parentIds) {
        document.getElementById('modal-title').textContent = 'Edit Tag';
        document.getElementById('tag-id').value = id;
        document.getElementById('tag-name').value = name;
        document.getElementById('tag-slug').value = slug;
        document.getElementById('tag-description').value = description || '';
        document.getElementById('tag-important').checked = !!isImportant;
        document.getElementById('tag-featured').checked = !!isFeatured;

        const parentsSelect = document.getElementById('tag-parents');
        if (parentsSelect) {
            let ids = [];
            try {
                ids = typeof parentIds === 'string' ? JSON.parse(parentIds) : (parentIds || []);
            } catch (e) {
                console.warn('Failed to parse parentIds:', e);
            }

            Array.from(parentsSelect.options).forEach(opt => {
                opt.selected = ids.includes(parseInt(opt.value));
                // Hide self from selection to prevent circular/self reference
                opt.style.display = opt.value === id ? 'none' : 'block';
                if (opt.value === id) opt.selected = false;
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

                if (parentsSelect) {
                    const ids = tag.parents ? tag.parents.map(p => p.id) : [];
                    Array.from(parentsSelect.options).forEach(opt => {
                        opt.selected = ids.includes(parseInt(opt.value));
                        opt.style.display = opt.value == tag.id ? 'none' : 'block';
                        if (opt.value == tag.id) opt.selected = false;
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

        const btnId = property === 'is_important' ? `toggle-important-${id}` : `toggle-featured-${id}`;
        const btn = document.getElementById(btnId);

        if (!btn) return;

        // Optimistic UI update or loading state
        btn.style.opacity = '0.5';
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
                btn.style.opacity = '1';

                // Update data attribute for next toggle
                btn.dataset.value = newValue ? 'true' : 'false';

                // Update SVG and titles
                const svg = btn.querySelector('svg');
                if (property === 'is_important') {
                    svg.setAttribute('fill', newValue ? 'var(--color-warning)' : 'var(--light-text-muted)');
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
                } else {
                    svg.setAttribute('fill', newValue ? 'var(--color-primary)' : 'var(--light-text-muted)');
                    svg.style.opacity = newValue ? '1' : '0.3';
                    btn.title = newValue ? 'Remove featured mark' : 'Mark as featured';
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
                btn.style.opacity = '1';
            }
        } catch (error) {
            console.error('Toggle error:', error);
            if (window.LightUtils && window.LightUtils.showToast) {
                window.LightUtils.showToast('An error occurred', 'error');
            }
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    };

    // Event Delegation
    document.addEventListener('click', function (e) {
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
            const parentIds = editBtn.dataset.tagParents || '[]';
            editTag(id, name, slug, description, isImportant, isFeatured, parentIds);
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
            parent_ids: Array.from(document.getElementById('tag-parents').selectedOptions).map(opt => parseInt(opt.value))
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
