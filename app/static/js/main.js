/**
 * Public Frontend JavaScript - Photo Blog Engine
 */

(function () {
    "use strict";

    let cleanupFunctions = [];

    function registerCleanup(fn) {
        cleanupFunctions.push(fn);
    }

    function cleanupPage() {
        cleanupFunctions.forEach(fn => fn());
        cleanupFunctions = [];
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
            prevBtn.style.display = index > 0 ? "block" : "none";
            nextBtn.style.display = index < items.length - 1 ? "block" : "none";
        }

        function openLightbox(index) {
            showImage(index);
            overlay.classList.add("active");
            document.body.style.overflow = "hidden";
        }

        function closeLightbox() {
            overlay.classList.remove("active");
            document.body.style.overflow = "";
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
        const idleTime = 2000; // 4 seconds

        function showUI() {
            immersiveBody.classList.remove("ui-hidden");
            resetIdleTimer();
        }

        function hideUI() {
            immersiveBody.classList.add("ui-hidden");
        }

        function resetIdleTimer(e) {
            // Ignore arrow keys for immersive mode toggle
            if (e && e.type === "keydown") {
                if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    return;
                }
            }

            clearTimeout(idleTimer);
            if (immersiveBody.classList.contains("ui-hidden")) {
                immersiveBody.classList.remove("ui-hidden");
            }
            idleTimer = setTimeout(hideUI, idleTime);
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
                hideUI();
                clearTimeout(idleTimer);
            }
        }

        // Activity listeners
        const events = ["mousemove", "mousedown", "touchstart", "keydown"];
        events.forEach((evt) => {
            document.addEventListener(evt, resetIdleTimer, { passive: true });
        });

        // Toggle on background click
        document.addEventListener("click", handleClick);

        // Start timer
        resetIdleTimer();

        registerCleanup(() => {
            clearTimeout(idleTimer);
            events.forEach((evt) => {
                document.removeEventListener(evt, resetIdleTimer);
            });
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
                video.play().catch((e) => {});
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
        document.body.style.cursor = 'wait';

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
                        btn.addEventListener('click', function(e) {
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

                // Update document title
                if (doc.title) document.title = doc.title;

                // Update body classes (essential for immersive layout vs standard)
                if (doc.body) {
                    document.body.className = doc.body.className;
                }
                
                // Re-initialize page scripts
                console.log("[Navigation] Re-initializing page...");
                initPage();
            }

            // Update URL
            if (pushState) {
                history.pushState({}, '', url);
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
            document.body.style.cursor = '';
        }
    }

    function renderPost(data) {
        console.log("[Navigation] Rendering post from JSON data");
        cleanupPage();

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
            if (data.blog_settings.show_view_counts && post.view_count) {
                viewsEl.textContent = post.view_count + " views";
                viewsEl.style.display = 'inline';
                const divider = clone.querySelector('.post-meta-divider');
                if(divider) divider.style.display = 'inline';
            } else {
                viewsEl.style.display = 'none';
                const divider = clone.querySelector('.post-meta-divider');
                if(divider) divider.style.display = 'none';
            }
        }

        // 2. Content / Media
        if (hasText) {
             const contentEl = clone.querySelector('.post-content');
             if(contentEl) contentEl.innerHTML = post.content_html;
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
                     if(prev) prev.style.display = 'none';
                     if(next) next.style.display = 'none';
                     if(indicators) indicators.style.display = 'none';
                 }
             }

             // Render Tags for Immersive
             const tagsContainer = clone.querySelector('.immersive-tags');
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
                 a.innerHTML = '<span class="post-nav-label">Previous Post</span><span class="post-nav-title">' + data.prev_post.title + '</span>';
                 navContainer.appendChild(a);
             } else {
                 navContainer.appendChild(document.createElement('div'));
             }
             
             if (data.next_post) {
                 const a = document.createElement('a');
                 a.href = '/posts/' + data.next_post.slug;
                 a.className = 'post-nav-link next';
                 a.innerHTML = '<span class="post-nav-label">Next Post</span><span class="post-nav-title">' + data.next_post.title + '</span>';
                 navContainer.appendChild(a);
             }
        }
        
        // Inject hidden navigation data for keyboard shortcuts
        const navData = document.createElement('div');
        navData.id = 'post-nav-data';
        navData.style.display = 'none';
        if (data.prev_post) navData.dataset.prevUrl = '/posts/' + data.prev_post.slug;
        if (data.next_post) navData.dataset.nextUrl = '/posts/' + data.next_post.slug;
        
        // 5. Header
        const headerTemplateId = hasText ? 'tmpl-header-default' : 'tmpl-header-immersive';
        const headerTemplate = document.getElementById(headerTemplateId);
        const headerClone = headerTemplate.content.cloneNode(true);
        
        if (hasText) {
             const titleLink = headerClone.querySelector('.site-title');
             if(titleLink) {
                 titleLink.textContent = data.blog_title;
                 titleLink.href = '/';
             }
             const subtitle = headerClone.querySelector('.site-subtitle');
             if(subtitle) subtitle.textContent = data.blog_subtitle;
        } else {
             const title = headerClone.querySelector('.site-title');
             if(title) title.textContent = post.title;
             
             const date = headerClone.querySelector('.post-date');
             if(date) {
                 date.setAttribute('datetime', post.published_iso);
                 date.textContent = post.published_date;
             }
             
             const hViewsEl = headerClone.querySelector('.post-views');
             if (hViewsEl) {
                 if (data.blog_settings.show_view_counts && post.view_count) {
                    hViewsEl.textContent = post.view_count + " views";
                 } else {
                     hViewsEl.style.display = 'none';
                     const divider = headerClone.querySelector('.post-meta-divider');
                     if(divider) divider.style.display = 'none';
                 }
             }
        }

        // Inject Edit Button if logged in
        if (data.is_logged_in) {
            const headerRight = headerClone.querySelector('.header-right');
            if (headerRight) {
                // Adjust styles to match server-side rendering
                headerRight.style.width = 'auto'; 
                headerRight.style.display = 'flex';
                headerRight.style.justifyContent = 'flex-end';
                headerRight.style.gap = '0.5rem';
                
                const editBtn = document.createElement('a');
                editBtn.href = '/light/posts/' + post.id;
                editBtn.className = 'theme-toggle';
                editBtn.style.display = 'flex';
                editBtn.style.alignItems = 'center';
                editBtn.style.justifyContent = 'center';
                editBtn.style.textDecoration = 'none';
                editBtn.title = 'Edit Post';
                editBtn.innerHTML = `
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
                    </svg>
                `;
                
                // Insert before theme toggle
                const themeToggle = headerRight.querySelector('.theme-toggle');
                if (themeToggle) {
                    headerRight.insertBefore(editBtn, themeToggle);
                } else {
                    headerRight.appendChild(editBtn);
                }
            }
        }

        // 6. DOM Injection
        const main = document.querySelector('main.site-main');
        const container = main.querySelector('.main-container');
        if(container) {
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

        // Re-init
        initPage();
        
        // Re-bind header events
        const toggleBtns = header.querySelectorAll('.theme-toggle');
        toggleBtns.forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                if (window.ThemeManager) {
                    window.ThemeManager.toggle();
                }
            });
        });
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

            // Home or Tags list page (Left/Right)
            const listPagination = document.querySelector(
                'nav.pagination[aria-label="Posts pagination"], nav.pagination[aria-label="Tags pagination"]',
            );
            if (listPagination) {
                if (e.key === "ArrowLeft") {
                    const nextLink = listPagination.querySelector(
                        'a.pagination-link[aria-label="Next page"]',
                    );
                    if (nextLink) nextLink.click();
                } else if (e.key === "ArrowRight") {
                    const prevLink = listPagination.querySelector(
                        'a.pagination-link[aria-label="Previous page"]',
                    );
                    if (prevLink) prevLink.click();
                }
            }

            // Specific Tag page (Up/Down)
            const tagPagination = document.querySelector(
                'nav.pagination[aria-label="Tag archive pagination"]',
            );
            if (tagPagination) {
                if (e.key === "ArrowDown") {
                    const nextLink = tagPagination.querySelector(
                        'a.pagination-link[aria-label="Next page"]',
                    );
                    if (nextLink) nextLink.click();
                } else if (e.key === "ArrowUp") {
                    const prevLink = tagPagination.querySelector(
                        'a.pagination-link[aria-label="Previous page"]',
                    );
                    if (prevLink) prevLink.click();
                }
            }

            // Single Post Navigation (Up/Down)
            const postNavData = document.getElementById('post-nav-data');
            if (postNavData) {
                if (e.key === "Escape") {
                    e.preventDefault();
                    e.stopPropagation();
                    console.log("[Navigation] Escape pressed, returning to home");
                    loadPost('/');
                } else if (e.key === "ArrowDown") {
                    const prevUrl = postNavData.dataset.prevUrl;
                    if (prevUrl) {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log("[Navigation] Triggering loadPost for prevUrl:", prevUrl);
                        loadPost(prevUrl);
                    }
                } else if (e.key === "ArrowUp") {
                    const nextUrl = postNavData.dataset.nextUrl;
                    if (nextUrl) {
                        e.preventDefault();
                        e.stopPropagation();
                        console.log("[Navigation] Triggering loadPost for nextUrl:", nextUrl);
                        loadPost(nextUrl);
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
        
        // Only init lightbox on gallery page
        if (document.querySelector(".gallery-grid")) {
             initLightbox();
        }
    }

    /**
     * Initialize all components
     */
    function init() {
        // Global initializations
        initDropdowns();
        initBackToTop();
        initKeyboardNavigation();
        initPopstate();
        
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
