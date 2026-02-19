/**
 * Navigation and Client-side Rendering - Photo Blog Engine
 */

(function () {
    "use strict";

    /**
     * Render a post card using the template
     */
    function renderPostCard(post, isLoggedIn, isFeatured) {
        const template = document.getElementById('tmpl-post-card');
        if (!template) return null;

        const clone = template.content.cloneNode(true);
        const article = clone.querySelector('.post-card');
        
        article.classList.add(post.has_image ? 'has-image' : 'text-only');
        if (isLoggedIn && post.has_hidden_posts_tag) {
            article.classList.add('hidden-post');
        }
        
        // Handle click
        article.onclick = (e) => {
            if (!e.target.closest('a')) {
                window.location.href = '/posts/' + post.slug;
            }
        };

        // Edit Button
        if (isLoggedIn) {
            const editWrapper = clone.querySelector('.post-card-edit-wrapper');
            editWrapper.innerHTML = `
                <a href="/light/posts/${post.id}" class="post-card-edit-btn" title="Edit Post">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                </a>`;
        }

        // Visuals (Image/Video/Audio)
        if (post.has_image || post.has_video || post.has_audio) {
            const visualWrapper = clone.querySelector('.post-card-visual-wrapper');
            visualWrapper.className = 'post-card-background';
            
            if (post.is_video) {
                visualWrapper.innerHTML = `
                    <video src="${post.thumbnail_path}" muted loop playsinline autoplay></video>
                    <div class="video-play-indicator">
                        <svg width="${isFeatured ? '48' : '32'}" height="${isFeatured ? '48' : '32'}" viewBox="0 0 24 24" fill="white">
                            <path d="M8 5v14l11-7z"/>
                        </svg>
                    </div>`;
            } else if (post.is_audio) {
                visualWrapper.innerHTML = `
                    <div class="audio-placeholder">
                        <svg width="${isFeatured ? '64' : '48'}" height="${isFeatured ? '64' : '48'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M9 18V5l12-2v13"></path>
                            <circle cx="6" cy="18" r="3"></circle>
                            <circle cx="18" cy="16" r="3"></circle>
                        </svg>
                    </div>`;
            } else {
                visualWrapper.innerHTML = `<img src="${post.thumbnail_path}" alt="${post.title}" loading="lazy">`;
            }
            clone.querySelector('.post-card-content').classList.add('overlay');
        }

        // Meta
        if (isFeatured) {
            clone.querySelector('.featured-badge').classList.remove('hidden');
        }
        
        const dateEl = clone.querySelector('.post-date');
        dateEl.setAttribute('datetime', post.published_iso);
        dateEl.textContent = post.published_date;

        if (post.view_count) {
            const viewCountWrapper = clone.querySelector('.view-count-wrapper');
            viewCountWrapper.innerHTML = `<span>&bull;</span> <span>${post.view_count} views</span>`;
        }

        // Title
        const titleLink = clone.querySelector('.post-card-title a');
        titleLink.href = '/posts/' + post.slug;
        titleLink.textContent = post.title;

        // Preview/Excerpt
        const previewWrapper = clone.querySelector('.post-card-preview-wrapper');
        if (post.has_image) {
            previewWrapper.className = 'post-card-excerpt';
            previewWrapper.innerHTML = post.excerpt || '';
        } else {
            previewWrapper.className = 'post-card-text-preview';
            previewWrapper.innerHTML = post.preview_html || '';
        }

        // Tags
        const tagsContainer = clone.querySelector('.post-card-tags');
        if (post.tags && post.tags.length > 0) {
            post.tags.slice(0, 3).forEach(tag => {
                const tagLink = document.createElement('a');
                tagLink.href = '/tag/' + tag.slug;
                tagLink.className = 'tag-link';
                tagLink.textContent = tag.name;
                tagsContainer.appendChild(tagLink);
            });
        }

        return clone;
    }

    /**
     * Public API for rendering post grid
     */
    window.BlogNavigation = {
        renderPostCard,
        // ... more functions will be added here
    };

})();
