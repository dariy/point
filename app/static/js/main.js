/**
 * Public Frontend JavaScript - Photo Blog Engine
 */

(function () {
    "use strict";

    let cleanupFunctions = [];

    function registerCleanup(fn) {
        cleanupFunctions.push(fn);
    }
    window.addCleanup = registerCleanup;

    function cleanupPage() {
        cleanupFunctions.forEach(fn => fn());
        cleanupFunctions = [];
        // Clean up immersive tags from footer
        const footerTags = document.querySelector('.footer-content .immersive-tags');
        if (footerTags) footerTags.remove();
    }

    /**
     * Dropdown Menus (for mobile)
     */
    function initDropdowns() {
        const dropdowns = document.querySelectorAll(".nav-dropdown");

        dropdowns.forEach(function (dropdown) {
            const toggle = dropdown.querySelector(".dropdown-toggle");

            if (!toggle) return;

            toggle.addEventListener("click", function (e) {
                // Only handle click on mobile
                if (window.innerWidth <= 768) {
                    e.preventDefault();
                    dropdown.classList.toggle("open");
                }
            });
        });
    }

    /**
     * Lazy Loading Images
     * Falls back to native loading="lazy" if IntersectionObserver is not available
     */
    function initLazyLoading() {
        if (!("IntersectionObserver" in window)) {
            return;
        }

        const images = document.querySelectorAll("img[data-src]");

        if (images.length === 0) return;

        const imageObserver = new IntersectionObserver(
            function (entries, observer) {
                entries.forEach(function (entry) {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.dataset.src;
                        img.removeAttribute("data-src");
                        observer.unobserve(img);
                    }
                });
            },
            {
                rootMargin: "50px 0px",
                threshold: 0.01,
            },
        );

        images.forEach(function (img) {
            imageObserver.observe(img);
        });
    }

    /**
     * Smooth Scroll for Anchor Links
     */
    function initSmoothScroll() {
        document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
            function handleClick(e) {
                const targetId = this.getAttribute("href");

                if (targetId === "#") return;

                const target = document.querySelector(targetId);

                if (target) {
                    e.preventDefault();
                    target.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                    });

                    // Update URL without jumping
                    if (history.pushState) {
                        history.pushState(null, null, targetId);
                    }
                }
            }

            anchor.addEventListener("click", handleClick);
            // No cleanup needed for element-specific listeners that are removed with the element
        });
    }

    /**
     * Back to Top Button
     */
    function initBackToTop() {
        const button = document.querySelector(".back-to-top");

        if (!button) return;

        function toggleVisibility() {
            if (window.scrollY > 300) {
                button.classList.add("visible");
            } else {
                button.classList.remove("visible");
            }
        }

        window.addEventListener("scroll", toggleVisibility, { passive: true });
        toggleVisibility();

        button.addEventListener("click", function () {
            window.scrollTo({
                top: 0,
                behavior: "smooth",
            });
        });
        // This is global, no cleanup needed as the button persists or logic is safe
    }

    /**
     * Image Gallery Lightbox (optional enhancement)
     */
    function initLightbox() {
        const galleryItems = document.querySelectorAll(".gallery-item");

        if (galleryItems.length === 0) return;

        // Create lightbox elements
        let overlay = document.querySelector(".lightbox-overlay");

        if (!overlay) {
            overlay = document.createElement("div");
            overlay.className = "lightbox-overlay";
            overlay.innerHTML = `
                <button class="lightbox-close" aria-label="Close lightbox">&times;</button>
                <button class="lightbox-prev" aria-label="Previous image">&lsaquo;</button>
                <button class="lightbox-next" aria-label="Next image">&rsaquo;</button>
                <div class="lightbox-content">
                    <img src="" alt="">
                    <div class="lightbox-caption"></div>
                </div>
            `;
            document.body.appendChild(overlay);
        }

        const lightboxImg = overlay.querySelector("img");
        const lightboxCaption = overlay.querySelector(".lightbox-caption");
        const closeBtn = overlay.querySelector(".lightbox-close");
        const prevBtn = overlay.querySelector(".lightbox-prev");
        const nextBtn = overlay.querySelector(".lightbox-next");

        let currentIndex = 0;
        const items = Array.from(galleryItems);

        function showImage(index) {
            const item = items[index];
            const img = item.querySelector("img");
            const title = item.querySelector(".gallery-item-title");

            if (img) {
                // Try to get the full-size image URL
                const fullSrc = img.src.replace("/thumbnails/", "/originals/");
                lightboxImg.src = fullSrc;
                lightboxImg.alt = img.alt;
            }

            if (title) {
                lightboxCaption.textContent = title.textContent;
            }

            currentIndex = index;

            // Update navigation visibility
            prevBtn.classList.toggle("hidden", index === 0);
            nextBtn.classList.toggle("hidden", index === items.length - 1);
        }

        function openLightbox(index) {
            showImage(index);
            overlay.classList.add("active");
            document.body.classList.add("no-overflow");
        }

        function closeLightbox() {
            overlay.classList.remove("active");
            document.body.classList.remove("no-overflow");
        }

        function showNext() {
            if (currentIndex < items.length - 1) {
                showImage(currentIndex + 1);
            }
        }

        function showPrev() {
            if (currentIndex > 0) {
                showImage(currentIndex - 1);
            }
        }

        // Event listeners
        galleryItems.forEach(function (item, index) {
            item.addEventListener("click", function (e) {
                // Only open lightbox if clicking on the image area, not the link
                if (
                    e.target.tagName === "IMG" ||
                    e.target.closest(".gallery-item-overlay")
                ) {
                    e.preventDefault();
                    openLightbox(index);
                }
            });
        });

        // Use event delegation or named functions to avoid duplication/issues
        // For simplicity, we assume these are safe to re-bind or check if bound
        // But better to clean up document listeners

        function handleKeydown(e) {
            if (!overlay.classList.contains("active")) return;

            switch (e.key) {
                case "Escape":
                    closeLightbox();
                    break;
                case "ArrowLeft":
                    showPrev();
                    break;
                case "ArrowRight":
                    showNext();
                    break;
            }
        }

        function handleOverlayClick(e) {
            if (e.target === overlay) {
                closeLightbox();
            }
        }

        closeBtn.onclick = closeLightbox;
        prevBtn.onclick = showPrev;
        nextBtn.onclick = showNext;
        overlay.onclick = handleOverlayClick;

        document.addEventListener("keydown", handleKeydown);

        registerCleanup(() => {
            document.removeEventListener("keydown", handleKeydown);
            // Remove overlay if we want full cleanup, but it's okay to keep hidden
            // Removing it ensures fresh state on navigation
            if (overlay && overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        });
    }

    /**
     * Reading Progress Indicator (for single post pages)
     */
    function initReadingProgress() {
        const article = document.querySelector(".post-content");
        const progressBar = document.querySelector(".reading-progress");

        if (!article || !progressBar) return;

        function updateProgress() {
            const articleTop = article.offsetTop;
            const articleHeight = article.offsetHeight;
            const windowHeight = window.innerHeight;
            const scrollTop = window.scrollY;

            const progress = Math.min(
                100,
                Math.max(
                    0,
                    ((scrollTop - articleTop + windowHeight) /
                        (articleHeight + windowHeight)) *
                    100,
                ),
            );

            progressBar.style.width = progress + "%";
        }

        window.addEventListener("scroll", updateProgress, { passive: true });
        updateProgress();

        registerCleanup(() => {
            window.removeEventListener("scroll", updateProgress);
        });
    }

    /**
     * Copy Code Blocks
     */
    function initCodeCopy() {
        const codeBlocks = document.querySelectorAll("pre code");

        codeBlocks.forEach(function (code) {
            const pre = code.parentElement;
            // Check if already initialized to avoid duplication on soft re-inits
            if (pre.previousElementSibling && pre.previousElementSibling.classList.contains("code-block-wrapper")) return;

            const wrapper = document.createElement("div");
            wrapper.className = "code-block-wrapper";

            const button = document.createElement("button");
            button.className = "code-copy-btn";
            button.textContent = "Copy";
            button.setAttribute("aria-label", "Copy code to clipboard");

            pre.parentNode.insertBefore(wrapper, pre);
            wrapper.appendChild(pre);
            wrapper.appendChild(button);

            button.addEventListener("click", function () {
                navigator.clipboard
                    .writeText(code.textContent)
                    .then(function () {
                        button.textContent = "Copied!";
                        button.classList.add("copied");

                        setTimeout(function () {
                            button.textContent = "Copy";
                            button.classList.remove("copied");
                        }, 2000);
                    });
            });
        });
    }

    /**
     * Immersive Mode (Full Screen Post)
     */
    function initImmersiveMode() {
        const immersiveBody = document.querySelector(".immersive-layout");
        if (!immersiveBody) return;

        let idleTimer;
        const idleTime = 5000; // Auto-hide after 5 seconds of inactivity
        let lastShowTime = 0;
        const minShowDuration = 3000; // UI stays visible for at least 3 seconds

        function showUI() {
            immersiveBody.classList.remove("ui-hidden");
            lastShowTime = Date.now();
            resetIdleTimer();
        }

        function hideUI() {
            immersiveBody.classList.add("ui-hidden");
        }

        function resetIdleTimer(e) {
            // Ignore arrow keys for immersive mode toggle - they should only navigate carousel
            if (e && e.type === "keydown") {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    return;
                }
            }

            clearTimeout(idleTimer);
            // Don't auto-show UI on touch events - let handleClick manage toggle on mobile
            // This prevents the race where touchstart shows UI then click immediately hides it
            if (e && (e.type === "touchstart" || e.type === "touchend")) {
                if (!immersiveBody.classList.contains("ui-hidden")) {
                    idleTimer = setTimeout(hideUI, idleTime);
                }
                return;
            }
            if (immersiveBody.classList.contains("ui-hidden")) {
                immersiveBody.classList.remove("ui-hidden");
                lastShowTime = Date.now();
            }
            idleTimer = setTimeout(hideUI, idleTime);
        }

        function handleKeydown(e) {
            // Space key toggles UI visibility
            if (e.key === " " || e.code === "Space") {
                e.preventDefault(); // Prevent page scroll
                if (immersiveBody.classList.contains("ui-hidden")) {
                    showUI();
                } else {
                    if (Date.now() - lastShowTime >= minShowDuration) {
                        hideUI();
                        clearTimeout(idleTimer);
                    }
                }
            }
        }

        function handleClick(e) {
            // Ignore clicks on interactive elements or the info card
            if (
                e.target.closest(
                    "a, button, input, textarea, .post-info-card, .site-header, .site-footer",
                )
            ) {
                return;
            }

            if (immersiveBody.classList.contains("ui-hidden")) {
                showUI();
            } else {
                // Only allow hiding if the UI has been visible for the minimum duration
                if (Date.now() - lastShowTime >= minShowDuration) {
                    hideUI();
                    clearTimeout(idleTimer);
                } else {
                    // User tapped again too soon - just reset the idle timer
                    resetIdleTimer();
                }
            }
        }

        // Activity listeners
        const events = ["mousemove", "mousedown", "touchstart", "keydown"];
        events.forEach((evt) => {
            document.addEventListener(evt, resetIdleTimer, { passive: true });
        });

        // Space key for explicit UI toggle
        document.addEventListener("keydown", handleKeydown);

        // Toggle on background click
        document.addEventListener("click", handleClick);

        // Start timer
        resetIdleTimer();

        registerCleanup(() => {
            clearTimeout(idleTimer);
            events.forEach((evt) => {
                document.removeEventListener(evt, resetIdleTimer);
            });
            document.removeEventListener("keydown", handleKeydown);
            document.removeEventListener("click", handleClick);
        });
    }

    /**
     * Carousel Logic
     */
    function initCarousel() {
        const container = document.querySelector(".carousel-container");
        if (!container) return;

        const slides = container.querySelectorAll(".carousel-slide");
        const dots = container.querySelectorAll(".carousel-dot");
        const prevBtn = container.querySelector(".carousel-prev");
        const nextBtn = container.querySelector(".carousel-next");

        if (slides.length < 2) return;

        let currentIndex = 0;

        function goToSlide(index) {
            if (index < 0) index = slides.length - 1;
            if (index >= slides.length) index = 0;

            // Pause current video if any
            const currentSlide = slides[currentIndex];
            const currentVideo = currentSlide.querySelector("video");
            if (currentVideo) {
                currentVideo.pause();
            }

            slides.forEach((slide) => slide.classList.remove("active"));
            dots.forEach((dot) => dot.classList.remove("active"));

            const nextSlide = slides[index];
            nextSlide.classList.add("active");
            dots[index].classList.add("active");

            // Play next video if any
            const nextVideo = nextSlide.querySelector("video");
            if (nextVideo) {
                nextVideo
                    .play()
                    .catch((e) => console.log("Autoplay blocked:", e));
            }

            currentIndex = index;
        }

        if (prevBtn) {
            prevBtn.onclick = (e) => {
                e.stopPropagation(); // Prevent immersive toggle
                goToSlide(currentIndex - 1);
            };
        }

        if (nextBtn) {
            nextBtn.onclick = (e) => {
                e.stopPropagation(); // Prevent immersive toggle
                goToSlide(currentIndex + 1);
            };
        }

        dots.forEach((dot, index) => {
            dot.onclick = (e) => {
                e.stopPropagation();
                goToSlide(index);
            };
        });

        function handleKeydown(e) {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
                return;

            if (e.key === "ArrowLeft") {
                goToSlide(currentIndex - 1);
            } else if (e.key === "ArrowRight") {
                goToSlide(currentIndex + 1);
            }
        }

        // Keyboard navigation
        document.addEventListener("keydown", handleKeydown);

        // Touch navigation
        let touchStartX = 0;
        let touchStartY = 0;

        container.addEventListener('touchstart', (e) => {
            touchStartX = e.changedTouches[0].clientX;
            touchStartY = e.changedTouches[0].clientY;
        }, { passive: true });

        container.addEventListener('touchend', (e) => {
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;

            const diffX = touchEndX - touchStartX;
            const diffY = touchEndY - touchStartY;
            const threshold = 50;

            if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > threshold) {
                if (diffX < 0) {
                    goToSlide(currentIndex + 1); // Swipe Left -> Next
                } else {
                    goToSlide(currentIndex - 1); // Swipe Right -> Prev
                }
            }
        }, { passive: true });

        registerCleanup(() => {
            document.removeEventListener("keydown", handleKeydown);
        });
    }

    /**
     * Post Card Video Previews
     */
    function initPostCardVideos() {
        const postCards = document.querySelectorAll(".post-card");

        postCards.forEach((card) => {
            const video = card.querySelector(".post-card-background video");
            if (!video) return;

            card.onmouseenter = () => {
                video.play().catch((e) => { });
            };

            card.onmouseleave = () => {
                video.pause();
            };
        });
    }

    /**
     * AJAX Navigation
     */
    let isNavigating = false;

    async function loadPost(url, pushState = true) {
        if (isNavigating) return;

        console.log("[Navigation] Starting navigation to:", url);
        isNavigating = true;
        document.body.classList.add("cursor-wait");

        try {
            // Determine if we should request JSON (only for single posts for now)
            const isPostUrl = url.includes('/posts/');
            const headers = {};
            if (isPostUrl) {
                headers['X-Requested-With'] = 'XMLHttpRequest';
            }

            const response = await fetch(url, { headers });
            console.log("[Navigation] Fetch status:", response.status);

            if (!response.ok) {
                throw new Error('Network response was not ok: ' + response.status);
            }

            const contentType = response.headers.get("content-type");
            if (isPostUrl && contentType && contentType.includes("application/json")) {
                const data = await response.json();
                renderPost(data);
            } else {
                // HTML Handling (Fallback or for non-post pages)
                const html = await response.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');

                const newMain = doc.querySelector('main.site-main');
                if (!newMain) {
                    console.error("[Navigation] Invalid page structure: missing main.site-main");
                    throw new Error('Invalid page structure');
                }

                // Cleanup existing page listeners
                console.log("[Navigation] Cleaning up previous page...");
                cleanupPage();

                // Replace content
                const currentMain = document.querySelector('main.site-main');
                if (currentMain) {
                    currentMain.replaceWith(newMain);
                } else {
                    console.error("[Navigation] Current page missing main.site-main");
                    throw new Error('Current page missing main.site-main');
                }

                // Update Header (Title, Date, Navigation)
                const newHeader = doc.querySelector('header.site-header');
                const currentHeader = document.querySelector('header.site-header');
                if (newHeader && currentHeader) {
                    console.log("[Navigation] Updating site-header...");
                    currentHeader.replaceWith(newHeader);

                    // Re-bind theme toggle for the new header
                    const toggleBtns = newHeader.querySelectorAll('.theme-toggle');
                    toggleBtns.forEach(btn => {
                        btn.addEventListener('click', function (e) {
                            e.preventDefault();
                            if (window.ThemeManager) {
                                window.ThemeManager.toggle();
                            }
                        });
                    });

                    // Re-initialize dropdowns for the new header (mobile menu)
                    const dropdowns = newHeader.querySelectorAll(".nav-dropdown");
                    dropdowns.forEach(function (dropdown) {
                        const toggle = dropdown.querySelector(".dropdown-toggle");
                        if (!toggle) return;
                        toggle.addEventListener("click", function (e) {
                            if (window.innerWidth <= 768) {
                                e.preventDefault();
                                dropdown.classList.toggle("open");
                            }
                        });
                    });
                }

                // Update Footer (pagination, tags)
                const newFooterContent = doc.querySelector('.footer-content');
                const currentFooterContent = document.querySelector('.footer-content');
                if (newFooterContent && currentFooterContent) {
                    currentFooterContent.innerHTML = newFooterContent.innerHTML;
                }

                // Update document title
                if (doc.title) document.title = doc.title;

                // Update body attributes
                if (doc.body) {
                    document.body.className = doc.body.className;
                    const newGaId = doc.body.getAttribute('data-ga-id');
                    if (newGaId) {
                        document.body.setAttribute('data-ga-id', newGaId);
                    } else {
                        document.body.removeAttribute('data-ga-id');
                    }
                }

                // Re-initialize page scripts
                console.log("[Navigation] Re-initializing page...");
                initPage();
            }

            // Update URL
            if (pushState) {
                history.pushState({}, '', url);

                // Track page view in Google Analytics
                const gaId = document.body.getAttribute('data-ga-id');
                if (gaId && window.gtag) {
                    gtag('config', gaId, {
                        'page_path': url,
                        'page_title': document.title
                    });
                }
            }

            // Scroll to top
            window.scrollTo(0, 0);
            console.log("[Navigation] Navigation complete");

        } catch (error) {
            console.error('[Navigation] Failed:', error);
            // Fallback to standard navigation
            window.location.href = url;
        } finally {
            isNavigating = false;
            document.body.classList.remove("cursor-wait");
        }
    }

    function renderPost(data) {
        console.log("[Navigation] Rendering post from JSON data");
        cleanupPage();

        // Update GA settings if provided
        if (data.blog_settings) {
            if (data.blog_settings.enable_analytics && data.blog_settings.google_analytics_id) {
                document.body.setAttribute('data-ga-id', data.blog_settings.google_analytics_id);
            } else {
                document.body.removeAttribute('data-ga-id');
            }
        }

        const hasText = data.has_text_content;
        const templateId = hasText ? 'tmpl-post-standard' : 'tmpl-post-immersive';
        const template = document.getElementById(templateId);

        if (!template) {
            console.error("Template not found:", templateId);
            window.location.reload();
            return;
        }

        const clone = template.content.cloneNode(true);
        const post = data.post;

        // 1. Update Title and Metadata
        const titleEl = clone.querySelector('.post-title') || clone.querySelector('.site-title');
        if (titleEl) titleEl.textContent = post.title;

        const dateEl = clone.querySelector('.post-date');
        if (dateEl) {
            dateEl.setAttribute('datetime', post.published_iso);
            dateEl.textContent = post.published_date;
        }

        const viewsEl = clone.querySelector('.post-views');
        if (viewsEl) {
            const divider = clone.querySelector('.post-meta-divider');
            if (data.blog_settings.show_view_counts && post.view_count) {
                viewsEl.textContent = post.view_count + " views";
                viewsEl.classList.remove('hidden');
                if (divider) divider.classList.remove('hidden');
            } else {
                viewsEl.classList.add('hidden');
                if (divider) divider.classList.add('hidden');
            }
        }

        // 2. Content / Media
        if (hasText) {
            const contentEl = clone.querySelector('.post-content');
            if (contentEl) contentEl.innerHTML = post.content_html;
        } else {
            // Render Carousel
            const container = clone.querySelector('.carousel-container');
            const indicators = clone.querySelector('.carousel-indicators');

            if (container && data.post_media && data.post_media.length > 0) {
                const prevBtn = container.querySelector('.carousel-prev');

                data.post_media.forEach((item, index) => {
                    // Slide
                    const slide = document.createElement('div');
                    slide.className = 'carousel-slide' + (index === 0 ? ' active' : '');
                    slide.dataset.type = item.type;

                    let mediaEl;
                    const url = item.url.startsWith('http') || item.url.startsWith('/') ? item.url : '/media/originals/' + item.url;

                    if (item.type === 'video') {
                        mediaEl = document.createElement('video');
                        mediaEl.src = url;
                        mediaEl.className = 'immersive-bg-image';
                        if (index === 0) mediaEl.autoplay = true;
                        mediaEl.muted = true;
                        mediaEl.loop = true;
                        mediaEl.playsInline = true;
                    } else {
                        mediaEl = document.createElement('img');
                        mediaEl.src = url;
                        mediaEl.alt = post.title + " - Media " + (index + 1);
                        mediaEl.className = 'immersive-bg-image';
                    }

                    slide.appendChild(mediaEl);
                    // Insert before buttons
                    container.insertBefore(slide, prevBtn);

                    // Dot
                    if (indicators) {
                        const dot = document.createElement('button');
                        dot.className = 'carousel-dot' + (index === 0 ? ' active' : '');
                        dot.dataset.index = index;
                        dot.ariaLabel = "Go to media " + (index + 1);
                        indicators.appendChild(dot);
                    }
                });

                // Hide controls if single item
                if (data.post_media.length <= 1) {
                    const prev = container.querySelector('.carousel-prev');
                    const next = container.querySelector('.carousel-next');
                    if (prev) prev.classList.add('hidden');
                    if (next) next.classList.add('hidden');
                    if (indicators) indicators.classList.add('hidden');
                }
            }

        }

        // 3. Tags (Standard only)
        if (hasText) {
            const tagsContainer = clone.querySelector('.post-tags');
            if (tagsContainer && post.tags) {
                post.tags.forEach(tag => {
                    const a = document.createElement('a');
                    a.href = '/tag/' + tag.slug;
                    a.className = 'post-tag';
                    a.textContent = tag.name;
                    tagsContainer.appendChild(a);
                });
            }
        }

        // 4. Navigation
        const navContainer = clone.querySelector('.post-navigation');

        if (navContainer && (data.prev_post || data.next_post)) {
            if (data.prev_post) {
                const a = document.createElement('a');
                a.href = '/posts/' + data.prev_post.slug;
                a.className = 'post-nav-link prev';
                a.innerHTML = '<span class="post-nav-title">&larr; ' + data.prev_post.title + '</span>';
                navContainer.appendChild(a);
            } else {
                navContainer.appendChild(document.createElement('div'));
            }

            if (data.next_post) {
                const a = document.createElement('a');
                a.href = '/posts/' + data.next_post.slug;
                a.className = 'post-nav-link next';
                a.innerHTML = '<span class="post-nav-title">' + data.next_post.title + ' &rarr; </span>';
                navContainer.appendChild(a);
            }
        }

        // Inject hidden navigation data
        const navData = document.createElement('div');
        navData.id = 'post-nav-data';
        navData.classList.add('hidden');
        if (data.prev_post) navData.dataset.prevUrl = '/posts/' + data.prev_post.slug;
        if (data.next_post) navData.dataset.nextUrl = '/posts/' + data.next_post.slug;

        // 5. Header
        const headerTemplateId = hasText ? 'tmpl-header-default' : 'tmpl-header-immersive';
        const headerTemplate = document.getElementById(headerTemplateId);
        const headerClone = headerTemplate.content.cloneNode(true);

        if (hasText) {
            const titleLink = headerClone.querySelector('.site-title');
            if (titleLink) {
                titleLink.textContent = data.blog_title;
                titleLink.href = '/';
            }
            const subtitle = headerClone.querySelector('.site-subtitle');
            if (subtitle) subtitle.textContent = data.blog_subtitle;

            // Show create-post and light-link buttons if logged in
            if (data.is_logged_in) {
                const createPostBtn = headerClone.querySelector('.create-post');
                if (createPostBtn) {
                    createPostBtn.classList.remove('hidden');
                    createPostBtn.classList.add('visible-flex');
                }
                const lightLink = headerClone.querySelector('.light-link');
                if (lightLink) {
                    lightLink.classList.remove('hidden');
                    lightLink.classList.add('visible-flex');
                }
                const titleLink = headerClone.querySelector('.site-title');
                if (titleLink) {
                    titleLink.classList.add('authenticated');
                }
            }
        } else {
            const title = headerClone.querySelector('.site-title');
            if (title) title.textContent = post.title;

            const date = headerClone.querySelector('.post-date');
            if (date) {
                date.setAttribute('datetime', post.published_iso);
                date.textContent = post.published_date;
            }

            const hViewsEl = headerClone.querySelector('.post-views');
            if (hViewsEl) {
                if (data.blog_settings.show_view_counts && post.view_count) {
                    hViewsEl.textContent = post.view_count + " views";
                } else {
                    hViewsEl.classList.add('hidden');
                    const divider = headerClone.querySelector('.post-meta-divider');
                    if (divider) divider.classList.add('hidden');
                }
            }
        }

        // Inject Edit Button and show Create Post button if logged in
        if (data.is_logged_in) {
            const headerRight = headerClone.querySelector('.header-right');
            if (headerRight) {
                // Check if edit button already exists to prevent duplicates
                let editBtn = headerRight.querySelector('.edit-post-btn');

                if (!editBtn) {
                    // Create new edit button only if it doesn't exist
                    editBtn = document.createElement('a');
                    editBtn.className = 'header-action-btn edit-post-btn';
                    editBtn.title = 'Edit Post';
                    editBtn.innerHTML = `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    `;

                    // Insert edit button before create-post button
                    const createPostBtn = headerRight.querySelector('.create-post');
                    if (createPostBtn) {
                        headerRight.insertBefore(editBtn, createPostBtn);
                    } else {
                        const themeToggle = headerRight.querySelector('.theme-toggle');
                        if (themeToggle) {
                            headerRight.insertBefore(editBtn, themeToggle);
                        } else {
                            headerRight.appendChild(editBtn);
                        }
                    }
                }

                // Update the href for the current post
                editBtn.href = '/light/posts/' + post.id;

                // Show create-post and light-link buttons
                const createPostBtn = headerRight.querySelector('.create-post');
                if (createPostBtn) {
                    createPostBtn.classList.remove('hidden');
                    createPostBtn.classList.add('visible-flex');
                }
                const lightLink = headerClone.querySelector('.light-link');
                if (lightLink) {
                    lightLink.classList.remove('hidden');
                    lightLink.classList.add('visible-flex');
                }
            }
        }

        // 6. DOM Injection
        const main = document.querySelector('main.site-main');
        const container = main.querySelector('.main-container');
        if (container) {
            container.innerHTML = '';
            container.appendChild(clone);
            container.appendChild(navData);
        } else {
            console.error("Main container not found, recreating");
            main.innerHTML = '<div class="main-container"></div>';
            main.querySelector('.main-container').appendChild(clone);
            main.querySelector('.main-container').appendChild(navData);
        }

        // Replace Header Content
        const header = document.querySelector('header.site-header');
        const headerContainer = header.querySelector('.header-container');
        headerContainer.innerHTML = '';
        headerContainer.appendChild(headerClone);

        // Update Body Class
        document.body.className = hasText ? 'public-layout post-single-page' : 'immersive-layout';

        // Update Title
        document.title = post.title;

        // Update footer tags for immersive posts
        const existingFooterTags = document.querySelector('.footer-content .immersive-tags');
        if (existingFooterTags) existingFooterTags.remove();

        if (!hasText && post.tags && post.tags.length > 0) {
            const footerContent = document.querySelector('.footer-content');
            if (footerContent) {
                const tagsDiv = document.createElement('div');
                tagsDiv.className = 'immersive-tags';
                post.tags.forEach(tag => {
                    const a = document.createElement('a');
                    a.href = '/tag/' + tag.slug;
                    a.className = 'post-tag';
                    a.textContent = tag.name;
                    tagsDiv.appendChild(a);
                });
                footerContent.appendChild(tagsDiv);
            }
        }

        // Re-init
        initPage();

        // Re-bind header events
        const toggleBtns = header.querySelectorAll('.theme-toggle');
        toggleBtns.forEach(btn => {
            btn.addEventListener('click', function (e) {
                e.preventDefault();
                if (window.ThemeManager) {
                    window.ThemeManager.toggle();
                }
            });
        });
    }

    /**
     * Common navigation logic for Keyboard and Touch
     * Returns true if a navigation action was triggered
     */
    function performNavigation(direction) {
        let handled = false;

        // Home or Tags list page (Left/Right)
        const listPagination = document.querySelector(
            'nav.pagination[aria-label="Posts pagination"], nav.pagination[aria-label="Tags pagination"]',
        );
        if (listPagination) {
            if (direction === "left") {
                const nextLink = listPagination.querySelector(
                    'a.pagination-link[aria-label="Next page"]',
                );
                if (nextLink) {
                    nextLink.click();
                    handled = true;
                }
            } else if (direction === "right") {
                const prevLink = listPagination.querySelector(
                    'a.pagination-link[aria-label="Previous page"]',
                );
                if (prevLink) {
                    prevLink.click();
                    handled = true;
                }
            }
        }

        // Specific Tag page (Up/Down)
        const tagPagination = document.querySelector(
            'nav.pagination[aria-label="Tag archive pagination"]',
        );
        if (tagPagination) {
            if (direction === "down") {
                const nextLink = tagPagination.querySelector(
                    'a.pagination-link[aria-label="Next page"]',
                );
                if (nextLink) {
                    nextLink.click();
                    handled = true;
                }
            } else if (direction === "up") {
                const prevLink = tagPagination.querySelector(
                    'a.pagination-link[aria-label="Previous page"]',
                );
                if (prevLink) {
                    prevLink.click();
                    handled = true;
                }
            }
        }

        // Single Post Navigation (Up/Down)
        const postNavData = document.getElementById('post-nav-data');
        if (postNavData) {
            if (direction === "escape") {
                console.log("[Navigation] Escape pressed, returning to home");
                loadPost('/');
                handled = true;
            } else if (direction === "down") {
                const prevUrl = postNavData.dataset.prevUrl;
                if (prevUrl) {
                    console.log("[Navigation] Triggering loadPost for prevUrl:", prevUrl);
                    loadPost(prevUrl);
                    handled = true;
                }
            } else if (direction === "up") {
                const nextUrl = postNavData.dataset.nextUrl;
                if (nextUrl) {
                    console.log("[Navigation] Triggering loadPost for nextUrl:", nextUrl);
                    loadPost(nextUrl);
                    handled = true;
                }
            }
        }

        return handled;
    }

    /**
     * Touch Gestures for Navigation
     */
    function initTouchNavigation() {
        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;

        document.addEventListener('touchstart', function (e) {
            touchStartX = e.changedTouches[0].clientX;
            touchStartY = e.changedTouches[0].clientY;
            touchStartTime = Date.now();
        }, { passive: true });

        document.addEventListener('touchend', function (e) {
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const elapsed = Date.now() - touchStartTime;

            handleSwipe(touchStartX, touchStartY, touchEndX, touchEndY, elapsed);
        }, { passive: true });

        function handleSwipe(startX, startY, endX, endY, elapsed) {
            const diffX = endX - startX;
            const diffY = endY - startY;
            const threshold = 50; // min distance for horizontal
            const verticalThreshold = 80; // larger threshold for vertical to avoid Chrome conflicts
            const maxSwipeTime = 800; // ignore very slow drags (likely scroll, not swipe)

            if (elapsed > maxSwipeTime) return;

            // Determine if horizontal or vertical swipe
            if (Math.abs(diffX) > Math.abs(diffY)) {
                // Horizontal
                if (Math.abs(diffX) > threshold) {
                    if (diffX < 0) {
                        performNavigation("left"); // Swipe Left -> ArrowLeft (Next)
                    } else {
                        performNavigation("right"); // Swipe Right -> ArrowRight (Prev)
                    }
                }
            } else {
                // Vertical - require stronger vertical intent to avoid browser gesture conflicts
                const verticalRatio = Math.abs(diffY) / (Math.abs(diffX) + 1);
                if (Math.abs(diffY) > verticalThreshold && verticalRatio > 2) {
                    const isAtTop = window.scrollY <= 5;
                    const isAtBottom = (window.innerHeight + window.scrollY) >= document.body.offsetHeight - 50;

                    // For swipe-down (navigate to prev): require touch start below top 60px
                    // to avoid conflict with Chrome's pull-to-refresh zone
                    if (diffY < 0 && isAtBottom) {
                        performNavigation("down"); // Swipe Up -> ArrowDown
                    } else if (diffY > 0 && isAtTop && startY > 60) {
                        performNavigation("up"); // Swipe Down -> ArrowUp
                    }
                }
            }
        }
    }

    /**
     * Keyboard Navigation for pagination
     */
    function initKeyboardNavigation() {
        document.addEventListener("keydown", function (e) {
            // Ignore if typing in an input
            if (
                e.target.tagName === "INPUT" ||
                e.target.tagName === "TEXTAREA" ||
                e.target.isContentEditable
            ) {
                return;
            }

            // Number keys (1-9) to open posts
            if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const posts = document.querySelectorAll(".post-card");
                const index = parseInt(e.key) - 1;
                if (posts[index]) {
                    const link = posts[index].querySelector("h2.post-card-title a");
                    if (link) {
                        e.preventDefault();
                        link.click();
                    }
                }
            }

            // Navigation Keys
            let direction = null;
            if (e.key === "ArrowLeft") direction = "left";
            else if (e.key === "ArrowRight") direction = "right";
            else if (e.key === "ArrowDown") direction = "down";
            else if (e.key === "ArrowUp") direction = "up";
            else if (e.key === "Escape") direction = "escape";

            if (direction) {
                if (performNavigation(direction)) {
                    // Only prevent default if we actually navigated
                    // For lists, we might not want to prevent default unless it's strictly required
                    // But existing code did preventing for Post navigation (ArrowDown/Up/Escape)
                    // Lists (ArrowLeft/Right) didn't have preventDefault in original code, but clicking a link is a navigation anyway.
                    // To match original exactly:
                    const isPostNav = document.getElementById('post-nav-data');
                    if (isPostNav || direction === 'escape') {
                        e.preventDefault();
                        e.stopPropagation();
                    }
                }
            }
        });
    }

    function initPopstate() {
        window.addEventListener('popstate', (e) => {
            console.log("[Navigation] Popstate event");
            loadPost(window.location.href, false);
        });
    }

    /**
     * Update Site Header Filters
     * Syncs active states and handles hierarchical tag name swapping.
     */
    function updateActiveSiteFilters(url, triggerElement = null) {
        const filtersContainer = document.querySelector('.site-header .tags-filters');
        if (!filtersContainer) return;

        const urlObj = new URL(url, window.location.origin);
        const pathParts = urlObj.pathname.split('/').filter(p => p);

        // Tag could be at /tag/SLUG
        let tag = null;
        if (pathParts[0] === 'tag') {
            tag = pathParts.length > 1 ? pathParts[1] : null;
        }

        const buttons = filtersContainer.querySelectorAll('.filter-btn');

        // Helper function to update button text while preserving the lock icon SVG
        function updateButtonText(btn, newText) {
            // Find the text node with actual content (not just whitespace)
            const textNode = Array.from(btn.childNodes).find(
                node => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== ''
            );

            if (textNode) {
                // Update the existing text node
                textNode.textContent = newText;
            } else {
                // No meaningful text node exists, create one
                const svg = btn.querySelector('.hidden-tag-icon');

                // Remove all existing text nodes (including whitespace)
                Array.from(btn.childNodes).forEach(node => {
                    if (node.nodeType === Node.TEXT_NODE) {
                        btn.removeChild(node);
                    }
                });

                // Create new text node and insert in correct position
                const newTextNode = document.createTextNode(newText);

                if (svg) {
                    // Insert text BEFORE the SVG icon
                    btn.insertBefore(newTextNode, svg);
                } else {
                    // No SVG, just prepend the text
                    btn.insertBefore(newTextNode, btn.firstChild);
                }
            }
        }

        // First, reset all buttons to inactive and restore original names for parent buttons
        buttons.forEach(btn => {
            btn.classList.remove('active');
            const originalName = btn.getAttribute('data-original-name');
            if (originalName) {
                updateButtonText(btn, originalName);
            }
        });

        // Identify all buttons that match the current tag
        const matchingButtons = [];
        buttons.forEach(btn => {
            const btnUrl = new URL(btn.href, window.location.origin);
            const btnPathParts = btnUrl.pathname.split('/').filter(p => p);
            const btnTag = btnPathParts.length > 1 ? btnPathParts[1] : null;
            if (tag === btnTag) {
                matchingButtons.push(btn);
            }
        });

        // If no matches by tag, handle "All"
        if (matchingButtons.length === 0 && !tag) {
            const allBtn = Array.from(buttons).find(btn => btn.dataset.role === 'all' || btn.getAttribute('href') === '/');
            if (allBtn) allBtn.classList.add('active');
        } else if (matchingButtons.length > 0) {
            // If multiple exist, pick the "best" one
            let bestMatch = null;
            if (triggerElement) {
                // If the click happened on one of these specific buttons, that's our winner
                bestMatch = matchingButtons.find(btn => btn === triggerElement);
                // If the trigger was a secondary element (like a tag in a post card), it won't be found here.
            }

            if (!bestMatch) {
                // Fresh run or external trigger: pick the one with deepest nesting
                let maxDepth = -1;
                matchingButtons.forEach(btn => {
                    let depth = 0;
                    let p = btn.parentElement;
                    while (p && p !== filtersContainer) {
                        if (p.classList.contains('tag-group')) depth++;
                        p = p.parentElement;
                    }
                    if (depth > maxDepth) {
                        maxDepth = depth;
                        bestMatch = btn;
                    }
                });
            }

            if (bestMatch) {
                bestMatch.classList.add('active');

                // Propagate active state and name swapping up the chosen hierarchy
                let currentGroup = bestMatch.closest('.tag-group');

                while (currentGroup) {
                    const headerBtn = currentGroup.querySelector('.tag-group-header .filter-btn');
                    const parentElement = currentGroup.parentElement;
                    const nextGroup = parentElement ? parentElement.closest('.tag-group') : null;

                    if (headerBtn) {
                        headerBtn.classList.add('active');
                        // Rule: The top-most group header button always swaps its text with the selected sub-tag
                        // to show the current filter status prominently.
                        // Intermediate groups keep their original names to provide hierarchical context.
                        if (!nextGroup) {
                            // Get the text content of bestMatch without the SVG icon
                            const bestMatchText = Array.from(bestMatch.childNodes)
                                .filter(node => node.nodeType === Node.TEXT_NODE)
                                .map(node => node.textContent)
                                .join('').trim();
                            updateButtonText(headerBtn, bestMatchText);
                        }
                    }
                    currentGroup = nextGroup;
                }


            }
        }

        // Trigger responsive filter update
        window.dispatchEvent(new CustomEvent('siteFiltersUpdated'));
    }

    /**
     * AJAX Navigation for Post Lists (Homepage and Tag Archives)
     */
    function initAjaxPostsNavigation() {
        const postsContainer = document.querySelector('.posts-main') || document.getElementById('tag-posts-container');
        if (!postsContainer) return;

        async function loadPosts(url, triggerElement = null) {
            try {
                postsContainer.classList.add('opacity-50');

                const response = await fetch(url, {
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    renderPosts(data, postsContainer, url);

                    window.history.pushState({}, '', url);
                    updateActiveSiteFilters(url, triggerElement);
                    attachAjaxListeners();
                    if (typeof initPostCardVideos === 'function') {
                        initPostCardVideos();
                    }
                    window.scrollTo(0, 0);
                } else {
                    window.location.href = url;
                }
            } catch (error) {
                console.error('Error loading posts:', error);
                window.location.href = url;
            } finally {
                postsContainer.classList.remove('opacity-50');
            }
        }

        function renderPosts(data, container, currentUrl) {
            if (!data.posts || data.posts.length === 0) {
                container.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
                                <path d="M8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>
                                <path d="M21 15l-5-5L5 21"/>
                            </svg>
                        </div>
                        <h2 class="empty-state-title">No posts yet</h2>
                        <p class="empty-state-text">Check back soon for new content.</p>
                    </div>`;
                return;
            }

            let html = '<div class="posts-grid">';

            data.posts.forEach((post, index) => {
                const isFirst = index === 0;
                const isPageOne = data.pagination.page === 1;
                const showFeatured = isFirst && isPageOne && post.is_featured;
                const hasImage = post.has_image;
                const isVideo = post.is_video;

                const editBtn = data.is_logged_in ? `
                    <a href="/light/posts/${post.id}" class="post-card-edit-btn" title="Edit Post">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </a>` : '';

                const featuredBadge = showFeatured ? `
                    <span class="featured-badge">
                        <svg width="16" height="16" viewBox="0 -2 24 22" fill="currentColor">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                        </svg>
                    </span>` : '';

                const postMeta = `
                    <div class="post-card-meta">
                        <time datetime="${post.published_iso}">${post.published_date}</time>
                        ${post.view_count ? `<span>&bull;</span><span>${post.view_count} views</span>` : ''}
                    </div>`;

                const postTags = post.tags && post.tags.length > 0 ? `
                    <div class="post-card-tags">
                        ${post.tags.slice(0, 3).map(tag => `<a href="/tag/${tag.slug}" class="tag-link ${tag.slug === data.tag?.slug || tag.slug === data.current_tag ? 'active' : ''}">${tag.name}</a>`).join('')}
                    </div>` : '';

                const contentHtml = hasImage ? `
                    <div class="post-card-background">
                        ${isVideo ? `
                            <video src="${post.thumbnail_path}" muted loop playsinline></video>
                            <div class="video-play-indicator">
                                <svg width="${showFeatured ? '48' : '32'}" height="${showFeatured ? '48' : '32'}" viewBox="0 0 24 24" fill="white">
                                    <path d="M8 5v14l11-7z"/>
                                </svg>
                            </div>` : `
                            <img src="${post.thumbnail_path}" alt="${post.title}" loading="lazy">`}
                    </div>
                    <div class="post-card-content overlay">
                        ${featuredBadge}${postMeta}
                        <h2 class="post-card-title"><a href="/posts/${post.slug}">${post.title}</a></h2>
                        <div class="post-card-excerpt">${post.excerpt || ''}</div>
                        ${postTags}
                    </div>` : `
                    <div class="post-card-content">
                        ${featuredBadge}${postMeta}
                        <h2 class="post-card-title"><a href="/posts/${post.slug}">${post.title}</a></h2>
                        <div class="post-card-text-preview">${post.preview_html || ''}</div>
                        ${postTags}
                    </div>`;

                if (showFeatured) {
                    html += `<div class="featured-post">
                        <article class="post-card ${hasImage ? 'has-image' : 'text-only'}" onclick="if(!event.target.closest('a')){ window.location.href='/posts/${post.slug}'; }">
                            ${editBtn}${contentHtml}
                        </article>
                    </div>`;
                } else {
                    html += `<article class="post-card ${hasImage ? 'has-image' : 'text-only'}" onclick="if(!event.target.closest('a')){ window.location.href='/posts/${post.slug}'; }">
                        ${editBtn}${contentHtml}
                    </article>`;
                }
            });

            html += '</div>';

            // Add pagination if needed
            if (data.pagination && data.pagination.total_pages > 1) {
                html += renderPagination(data.pagination, data.tag?.slug || data.current_tag, currentUrl);
            }

            container.innerHTML = html;
        }

        function renderPagination(pag, tagSlug, currentUrl) {
            // If tagSlug is not provided, try to extract it from the URL being loaded
            if (!tagSlug && currentUrl) {
                const urlObj = new URL(currentUrl, window.location.origin);
                const tagMatch = urlObj.pathname.match(/^\/tag\/([^\/]+)/);
                if (tagMatch) {
                    tagSlug = tagMatch[1];
                }
            }

            // Fallback to current window location if still not found
            if (!tagSlug) {
                const tagMatch = window.location.pathname.match(/^\/tag\/([^\/]+)/);
                if (tagMatch) {
                    tagSlug = tagMatch[1];
                }
            }

            const basePath = tagSlug ? `/tag/${tagSlug}` : '/';
            const ariaLabel = tagSlug ? 'Tag archive pagination' : 'Posts pagination';

            let html = `<nav class="pagination" aria-label="${ariaLabel}">`;

            // Previous
            if (pag.has_prev) {
                html += `<a href="${basePath}?page=${pag.prev_page}" class="pagination-link ajax-link" aria-label="Previous page">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M15 18l-6-6 6-6"/>
                    </svg>
                </a>`;
            } else {
                html += `<span class="pagination-link disabled">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M15 18l-6-6 6-6"/>
                    </svg>
                </span>`;
            }

            // Pages
            for (let p = 1; p <= pag.total_pages; p++) {
                if (p === pag.page) {
                    html += `<span class="pagination-link active">${p}</span>`;
                } else if (p === 1 || p === pag.total_pages || (p >= pag.page - 1 && p <= pag.page + 1)) {
                    html += `<a href="${basePath}?page=${p}" class="pagination-link ajax-link">${p}</a>`;
                } else if (p === pag.page - 2 || p === pag.page + 2) {
                    html += `<span class="pagination-ellipsis">&hellip;</span>`;
                }
            }

            // Next
            if (pag.has_next) {
                html += `<a href="${basePath}?page=${pag.next_page}" class="pagination-link ajax-link" aria-label="Next page">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 18l6-6-6-6"/>
                    </svg>
                </a>`;
            } else {
                html += `<span class="pagination-link disabled">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 18l6-6-6-6"/>
                    </svg>
                </span>`;
            }

            html += '</nav>';
            return html;
        }

        function attachAjaxListeners() {
            const links = document.querySelectorAll('.ajax-link');
            links.forEach(link => {
                link.removeEventListener('click', handleAjaxClick);
                link.addEventListener('click', handleAjaxClick);
            });
        }

        function handleAjaxClick(e) {
            e.preventDefault();
            const url = this.getAttribute('href');
            loadPosts(url, this);
        }

        // Initial setup
        attachAjaxListeners();

        // Handle back/forward buttons
        window.addEventListener('popstate', function () {
            loadPosts(window.location.href);
        });
    }

    /**
     * AJAX Navigation for Tags Page
     */
    function initAjaxTagsNavigation() {
        const tagsContent = document.getElementById('tags-content');
        const filtersContainer = document.getElementById('tags-filters');
        if (!tagsContent) return;

        async function loadTagsContent(url, triggerElement = null) {
            try {
                tagsContent.classList.add('opacity-50');

                const response = await fetch(url, {
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest'
                    }
                });

                if (response.ok) {
                    const data = await response.json();
                    renderTags(data);

                    window.history.pushState({}, '', url);
                    updateActiveSiteFilters(url, triggerElement);
                    attachTagsListeners();
                    initTagToggles();
                    if (typeof initPostCardVideos === 'function') {
                        initPostCardVideos();
                    }
                } else {
                    window.location.href = url;
                }
            } catch (error) {
                console.error('Error loading tags content:', error);
                window.location.href = url;
            } finally {
                tagsContent.classList.remove('opacity-50');
            }
        }

        function renderTags(data) {
            if (!data.posts || data.posts.length === 0) {
                tagsContent.innerHTML = `
                    <div class="empty-state">
                        <div class="empty-state-icon">
                            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/>
                                <path d="M8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/>
                                <path d="M21 15l-5-5L5 21"/>
                            </svg>
                        </div>
                        <h2 class="empty-state-title">No posts yet</h2>
                        <p class="empty-state-text">Try selecting a different category or check back later.</p>
                    </div>`;
                return;
            }

            let html = '<div class="posts-grid">';
            data.posts.forEach((post, index) => {
                const isFirst = index === 0;
                const isPageOne = data.pagination.page === 1;
                const showFeatured = isFirst && isPageOne && post.is_featured;
                const hasImage = post.has_image;
                const isVideo = post.is_video;

                const editBtn = data.is_logged_in ? `
                    <a href="/light/posts/${post.id}" class="post-card-edit-btn" title="Edit Post">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                        </svg>
                    </a>` : '';

                const featuredBadge = showFeatured ? `
                    <span class="featured-badge">
                        <svg width="16" height="16" viewBox="0 -2 24 22" fill="currentColor">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                        </svg>
                    </span>` : '';

                const contentHtml = hasImage ? `
                    <div class="post-card-background">
                        ${isVideo ? `
                            <video src="${post.thumbnail_path}" muted loop playsinline></video>
                            <div class="video-play-indicator">
                                <svg width="${showFeatured ? '48' : '32'}" height="${showFeatured ? '48' : '32'}" viewBox="0 0 24 24" fill="white">
                                    <path d="M8 5v14l11-7z"/>
                                </svg>
                            </div>` : `
                            <img src="${post.thumbnail_path}" alt="${post.title}" loading="lazy">`}
                    </div>
                    <div class="post-card-content overlay">` : `
                    <div class="post-card-content">`;

                const postTags = post.tags && post.tags.length > 0 ? `
                    <div class="post-card-tags">
                        ${post.tags.slice(0, 3).map(tag => `<a href="/tag/${tag.slug}" class="tag-link ${tag.slug === data.current_tag ? 'active' : ''}">${tag.name}</a>`).join('')}
                    </div>` : '';

                const articleHtml = `
                    <article class="post-card ${hasImage ? 'has-image' : 'text-only'}" onclick="if(!event.target.closest('a')){ window.location.href='/posts/${post.slug}'; }">
                        ${editBtn}${contentHtml}
                            <div class="post-card-meta">
                                ${featuredBadge}
                                <time datetime="${post.published_iso}">${post.published_date}</time>
                                ${post.view_count ? `<span>&bull;</span><span>${post.view_count} views</span>` : ''}
                            </div>
                            <h2 class="post-card-title"><a href="/posts/${post.slug}">${post.title}</a></h2>
                            ${hasImage ? `<div class="post-card-excerpt">${post.excerpt || ''}</div>` : `<div class="post-card-text-preview">${post.preview_html || ''}</div>`}
                            ${postTags}
                        </div>
                    </article>`;

                if (showFeatured) {
                    html += `<div class="featured-post">${articleHtml}</div>`;
                } else {
                    html += articleHtml;
                }
            });
            html += '</div>';

            tagsContent.innerHTML = html;
            renderTagsPagination(data.pagination, data.current_tag);
        }

        function renderTagsPagination(pag, currentTag) {
            const paginationContainer = document.querySelector('.footer-content .pagination');

            if (!paginationContainer) {
                return;
            }

            if (!pag || pag.total_pages <= 1) {
                paginationContainer.classList.add('hidden');
                return;
            }

            paginationContainer.classList.remove('hidden');
            paginationContainer.classList.add('visible-flex');
            const tagPath = currentTag ? `/${currentTag}` : '';
            let html = '';

            // Previous
            if (pag.has_prev) {
                html += `<a href="/tag${tagPath}?page=${pag.prev_page}" class="pagination-link ajax-link" aria-label="Previous page">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M15 18l-6-6 6-6"/>
                    </svg>
                </a>`;
            } else {
                html += `<span class="pagination-link disabled">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M15 18l-6-6 6-6"/>
                    </svg>
                </span>`;
            }

            // Pages
            for (let p = 1; p <= pag.total_pages; p++) {
                if (p === pag.page) {
                    html += `<span class="pagination-link active">${p}</span>`;
                } else if (p === 1 || p === pag.total_pages || (p >= pag.page - 1 && p <= pag.page + 1)) {
                    html += `<a href="/tag${tagPath}?page=${p}" class="pagination-link ajax-link">${p}</a>`;
                } else if (p === pag.page - 2 || p === pag.page + 2) {
                    html += `<span class="pagination-ellipsis">&hellip;</span>`;
                }
            }

            // Next
            if (pag.has_next) {
                html += `<a href="/tag${tagPath}?page=${pag.next_page}" class="pagination-link ajax-link" aria-label="Next page">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 18l6-6-6-6"/>
                    </svg>
                </a>`;
            } else {
                html += `<span class="pagination-link disabled">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 18l6-6-6-6"/>
                    </svg>
                </span>`;
            }

            paginationContainer.innerHTML = html;
        }



        function attachTagsListeners() {
            const links = document.querySelectorAll('.ajax-link');
            links.forEach(link => {
                link.removeEventListener('click', handleTagsClick);
                link.addEventListener('click', handleTagsClick);
            });
        }

        function handleTagsClick(e) {
            e.preventDefault();
            const url = this.getAttribute('href');
            loadTagsContent(url, this);
        }

        // Initial setup
        attachTagsListeners();

        // Handle back/forward buttons
        window.addEventListener('popstate', function () {
            loadTagsContent(window.location.href);
        });
    }

    /**
     * Responsive Tag Filters in Header
     * shows (all), (...), and all tags that fit in the rest of the space.
     * Preserves the active tag and ensures All/More are always visible.
     */
    function initResponsiveTagFilters() {
        const container = document.querySelector('.site-header .tags-filters');
        if (!container) return;

        function updateFilters() {
            // Get computed gap
            const style = window.getComputedStyle(container);
            const gap = parseFloat(style.gap) || 0;
            // Use getBoundingClientRect for more sub-pixel accuracy
            const containerWidth = container.getBoundingClientRect().width;

            const mode = container.dataset.mode || 'featured';
            const allItems = Array.from(container.children);

            // Step 0: Filter items that belong to current mode
            const items = allItems.filter(el => {
                if (el.id === 'tags-switcher') return true;
                if (mode === 'featured') return el.classList.contains('featured-tag');
                if (mode === 'categories') return el.classList.contains('category-tag');
                return false;
            });

            // Hide everything initially
            allItems.forEach(item => {
                item.classList.toggle('hidden', true);
                item.classList.toggle('visible-inline-flex', false);
            });

            // Threshold for hiding tags completely to avoid branding collision
            // If the space is too small (< 100px), hide everything.
            if (containerWidth < 100) {
                container.classList.add('is-ready');
                return;
            }

            const widths = new Map();

            // Step 1: Show relevant items temporarily to measure natural widths
            items.forEach(item => {
                item.classList.add('is-measuring');
                item.classList.toggle('visible-inline-flex', true);

                // Store the width
                widths.set(item, item.offsetWidth);

                // Reset immediately (we'll set final display later)
                item.classList.remove('is-measuring');
                item.classList.toggle('visible-inline-flex', false);
            });

            // Identify key items
            const allBtn = items.find(el => {
                const b = el.classList.contains('filter-btn') ? el : el.querySelector('.filter-btn');
                return b && (b.dataset.role === 'all' || b.getAttribute('href') === '/');
            });
            const moreBtn = document.getElementById('tags-switcher');
            const activeItem = items.find(el => {
                if (el.classList.contains('active')) return true;
                if (el.querySelector('.filter-btn.active')) return true;
                return false;
            });

            // Step 2: Priority layout (Essential items)
            // Leave a small buffer (~10px) to prevent sub-pixel rounding issues or tight spacing
            const availableWidth = containerWidth - 10;
            let currentWidth = 0;
            const essentials = [];
            if (allBtn) essentials.push(allBtn);
            if (activeItem && !essentials.includes(activeItem)) essentials.push(activeItem);
            if (moreBtn && !essentials.includes(moreBtn)) essentials.push(moreBtn);

            // Step 3: Show as many essential items as fit
            for (const item of essentials) {
                const itemWidth = widths.get(item) || 0;
                const cost = itemWidth + (currentWidth > 0 ? gap : 0);
                const fits = currentWidth + cost <= availableWidth;

                item.classList.toggle('hidden', !fits);
                item.classList.toggle('visible-inline-flex', fits);

                if (fits) {
                    currentWidth += cost;
                }
            }

            // Step 4: Fill remaining space with other tags
            const otherTags = items.filter(el => !essentials.includes(el));
            for (const tag of otherTags) {
                const itemWidth = widths.get(tag) || 0;
                const cost = itemWidth + (currentWidth > 0 ? gap : 0);
                const fits = currentWidth + cost <= availableWidth;

                tag.classList.toggle('hidden', !fits);
                tag.classList.toggle('visible-inline-flex', fits);

                if (fits) {
                    currentWidth += cost;
                }
            }

            // Mark as ready to show
            requestAnimationFrame(() => {
                container.classList.add('is-ready');
            });
        }

        // Use ResizeObserver for more accurate container-based measurement
        const observer = new ResizeObserver(() => {
            requestAnimationFrame(updateFilters);
        });

        observer.observe(container);

        // Listen for internal filter updates
        window.addEventListener('siteFiltersUpdated', () => {
            requestAnimationFrame(updateFilters);
        });

        // Initial run
        updateActiveSiteFilters(window.location.href);
        updateFilters();


        registerCleanup(() => {
            observer.disconnect();
        });
    }

    /**
     * Tag Toggles for Hierarchical Tags
     */
    function initTagToggles() {
        const groups = document.querySelectorAll(".tag-group");
        groups.forEach(group => {
            const toggle = group.querySelector(".toggle-children");
            const children = group.querySelector(".tag-children");
            if (!toggle || !children) return;

            // Helper to prevent menu overflow
            const adjustMenuPosition = () => {
                // Reset transform first to get original position
                children.style.removeProperty('transform');

                // Show temporarily to measure (if not already displayed)
                const originallyHidden = window.getComputedStyle(children).display === 'none';
                if (originallyHidden) {
                    children.classList.add('is-measuring');
                    children.classList.add('visible-flex');
                }

                const menuRect = children.getBoundingClientRect();
                const viewportWidth = window.innerWidth;
                const margin = 20; // Distance from screen edge

                let offset = 0;
                if (menuRect.left < margin) {
                    offset = margin - menuRect.left;
                } else if (menuRect.right > viewportWidth - margin) {
                    offset = (viewportWidth - margin) - menuRect.right;
                }

                // If menu is open, apply the offset.
                // We use two translateX to keep the base centering and add the correction.
                if (offset !== 0) {
                    children.style.transform = `translateX(-50%) translateX(${offset}px)`;
                } else {
                    children.style.removeProperty('transform');
                }

                if (originallyHidden) {
                    children.classList.remove('is-measuring');
                    children.classList.remove('visible-flex');
                }
            };

            toggle.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();

                const isOpen = group.classList.toggle("is-open");
                console.log('Toggle clicked, isOpen:', isOpen, 'group:', group);

                if (isOpen) {
                    adjustMenuPosition();
                    // Close other groups
                    groups.forEach(other => {
                        if (other !== group) other.classList.remove("is-open");
                    });
                }
            });

            // Handle hover repositioning
            group.addEventListener("mouseenter", adjustMenuPosition);

            // Close when clicking outside
            document.addEventListener("click", (e) => {
                if (!group.contains(e.target)) {
                    group.classList.remove("is-open");
                }
            });
        });
    }

    /**
     * Switcher between Featured Tags and Categories in Header
     */
    function initTagSwitcher() {
        const switcher = document.getElementById('tags-switcher');
        const container = document.getElementById('header-tags-filters');

        if (!switcher || !container) return;

        function updateSets(mode) {
            container.dataset.mode = mode;
            if (mode === 'categories') {
                switcher.classList.add('active');
            } else {
                switcher.classList.remove('active');
            }
            // Trigger responsive update
            if (window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('siteFiltersUpdated'));
            }
        }

        // Initialize state from localStorage
        const savedMode = localStorage.getItem('tags-filter-mode') || 'featured';
        updateSets(savedMode);

        switcher.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const currentMode = localStorage.getItem('tags-filter-mode') || 'featured';
            const newMode = currentMode === 'featured' ? 'categories' : 'featured';

            localStorage.setItem('tags-filter-mode', newMode);
            updateSets(newMode);
        });
    }

    /**
     * Initialize Map (if present)
     */
    function initMap() {
        const mapEl = document.getElementById('map');
        if (mapEl && window.initGlobalMap) {
            try {
                const mapTags = JSON.parse(mapEl.dataset.mapTags || '[]');
                window.initGlobalMap(mapTags);
            } catch (e) {
                console.error("[Map] Failed to parse map tags:", e);
            }
        }
    }

    /**
     * Initialize Page specific components
     */
    function initPage() {
        initImmersiveMode();
        initCarousel();
        initPostCardVideos();
        initLazyLoading();
        initSmoothScroll();
        initReadingProgress();
        initCodeCopy();
        initAjaxPostsNavigation();
        initAjaxTagsNavigation();
        initResponsiveTagFilters();
        initTagToggles();
        initTagSwitcher();
        initMap();

        // Only init lightbox on gallery page
        if (document.querySelector(".gallery-grid")) {
            initLightbox();
        }
    }

    /**
     * Drag-and-Drop Post Creation
     * Allows logged-in users to drop an image on any public page to create a new post
     */
    function initDragDropPostCreation() {
        // Only enable for logged-in users
        if (!document.body.hasAttribute('data-logged-in')) {
            return;
        }

        const overlay = document.getElementById('drop-zone-overlay');
        if (!overlay) return;

        const titleEl = overlay.querySelector('.drop-zone-title');
        const hintEl = overlay.querySelector('.drop-zone-hint');

        let dragCounter = 0;

        // Prevent default drag behaviors globally
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            document.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            }, false);
        });

        // Handle drag enter
        document.addEventListener('dragenter', (e) => {
            dragCounter++;

            // Check if dragging files (images)
            if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
                overlay.classList.add('active');
                document.body.classList.add('drag-over');
            }
        }, false);

        // Handle drag leave
        document.addEventListener('dragleave', (e) => {
            dragCounter--;

            if (dragCounter === 0) {
                overlay.classList.remove('active');
                document.body.classList.remove('drag-over');
            }
        }, false);

        // Handle drag over (needed to allow drop)
        document.addEventListener('dragover', (e) => {
            e.dataTransfer.dropEffect = 'copy';
        }, false);

        // Handle drop
        document.addEventListener('drop', async (e) => {
            dragCounter = 0;
            document.body.classList.remove('drag-over');

            const files = e.dataTransfer.files;
            if (!files || files.length === 0) {
                overlay.classList.remove('active');
                return;
            }

            // Get the first file
            const file = files[0];

            // Check if it's an image
            if (!file.type.startsWith('image/')) {
                overlay.classList.remove('active');
                alert('Please drop an image file (JPG, PNG, GIF, WebP)');
                return;
            }

            // Show uploading state
            overlay.classList.add('uploading');
            titleEl.textContent = 'Uploading...';
            hintEl.textContent = file.name;

            try {
                // Upload the image
                const formData = new FormData();
                formData.append('file', file);

                const response = await fetch('/api/media/upload', {
                    method: 'POST',
                    body: formData,
                    credentials: 'include'
                });

                if (!response.ok) {
                    const error = await response.json();
                    throw new Error(error.detail || 'Upload failed');
                }

                const media = await response.json();

                // Redirect to post creation with media info
                const params = new URLSearchParams({
                    media_id: media.id,
                    media_path: media.original_path
                });

                window.location.href = `/light/posts/new?${params.toString()}`;

            } catch (error) {
                console.error('Upload error:', error);
                overlay.classList.remove('active', 'uploading');
                titleEl.textContent = 'Drop image to create new post';
                hintEl.textContent = 'Release to upload and start editing';
                alert('Upload failed: ' + error.message);
            }
        }, false);
    }

    /**
     * Initialize all components
     */
    function init() {
        // Global initializations
        initDropdowns();
        initBackToTop();
        initKeyboardNavigation();
        initTouchNavigation();
        initPopstate();
        initDragDropPostCreation();

        // Page specific initializations
        initPage();
    }

    // Run on DOM ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
