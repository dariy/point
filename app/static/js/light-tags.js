/**
 * Tags Management JavaScript - Photo Blog Engine
 * Handles tag creation, editing, and property toggling
 */

(function() {
    'use strict';

    const modal = document.getElementById('tag-modal');
    const form = document.getElementById('tag-form');

    if (!modal || !form) return;

    /**
     * Open modal for creating new tag
     */
    window.openNewTagModal = function() {
        document.getElementById('modal-title').textContent = 'New Tag';
        document.getElementById('tag-id').value = '';
        document.getElementById('tag-name').value = '';
        document.getElementById('tag-slug').value = '';
        document.getElementById('tag-description').value = '';
        document.getElementById('tag-important').checked = false;
        document.getElementById('tag-featured').checked = false;
        modal.classList.add('active');
    };

    /**
     * Open modal for editing existing tag
     */
    window.editTag = async function(id, name, slug, description, isImportant, isFeatured) {
        document.getElementById('modal-title').textContent = 'Edit Tag';
        document.getElementById('tag-id').value = id;
        document.getElementById('tag-name').value = name;
        document.getElementById('tag-slug').value = slug;
        document.getElementById('tag-description').value = description;
        document.getElementById('tag-important').checked = isImportant;
        document.getElementById('tag-featured').checked = isFeatured;
        modal.classList.add('active');

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
            }
        } catch (error) {
            console.warn('Failed to fetch fresh tag data:', error);
        }
    };

    /**
     * Close tag modal
     */
    window.closeTagModal = function() {
        modal.classList.remove('active');
    };

    /**
     * Toggle tag property (important/featured)
     */
    window.toggleTagProperty = async function(id, property, currentValue) {
        const newValue = !currentValue;
        const data = {};
        data[property] = newValue;

        const btnId = property === 'is_important' ? `toggle-important-${id}` : `toggle-featured-${id}`;
        const btn = document.getElementById(btnId);
        const originalHtml = btn.innerHTML;

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

                // Update button state and onclick handler
                btn.disabled = false;
                btn.style.opacity = '1';

                // Update the onclick attribute for the next toggle
                btn.onclick = () => toggleTagProperty(id, property, newValue);

                // Update SVG and titles
                const svg = btn.querySelector('svg');
                if (property === 'is_important') {
                    svg.setAttribute('fill', newValue ? 'var(--color-warning)' : 'var(--light-text-muted)');
                    svg.style.opacity = newValue ? '1' : '0.3';
                    btn.title = newValue ? 'Remove important mark' : 'Mark as important';

                    // Update the tag name link class if it exists in this row
                    const nameLink = btn.closest('tr').querySelector('td a.tag');
                    if (nameLink) {
                        if (newValue) nameLink.classList.add('tag-important');
                        else nameLink.classList.remove('tag-important');
                    }
                } else {
                    svg.setAttribute('fill', newValue ? 'var(--color-primary)' : 'var(--light-text-muted)');
                    svg.style.opacity = newValue ? '1' : '0.3';
                    btn.title = newValue ? 'Remove featured mark' : 'Mark as featured';
                }

                window.LightUtils.showToast('Updated successfully');
            } else {
                const error = await response.json();
                window.LightUtils.showToast(error.detail || 'Failed to update tag', 'error');
                btn.disabled = false;
                btn.style.opacity = '1';
            }
        } catch (error) {
            console.error('Toggle error:', error);
            window.LightUtils.showToast('An error occurred', 'error');
            btn.disabled = false;
            btn.style.opacity = '1';
        }
    };

    // Close modal on overlay click
    modal.addEventListener('click', function(e) {
        if (e.target === modal) {
            closeTagModal();
        }
    });

    // Close modal on escape
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            closeTagModal();
        }
    });

    // Form submission
    form.addEventListener('submit', async function(e) {
        e.preventDefault();

        const id = document.getElementById('tag-id').value;
        const data = {
            name: document.getElementById('tag-name').value,
            slug: document.getElementById('tag-slug').value || null,
            description: document.getElementById('tag-description').value || null,
            is_important: document.getElementById('tag-important').checked,
            is_featured: document.getElementById('tag-featured').checked
        };

        const url = id ? `/api/tags/${id}` : '/api/tags';
        const method = id ? 'PUT' : 'POST';

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
                const error = await response.json();
                window.LightUtils.showToast(error.detail || 'Failed to save tag', 'error');
            }
        } catch (error) {
            console.error('Save error:', error);
            window.LightUtils.showToast('An error occurred', 'error');
        }
    });

})();
