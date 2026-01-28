/**
 * Public Frontend JavaScript - Photo Blog Engine
 */

(function () {
    "use strict";

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
            anchor.addEventListener("click", function (e) {
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
            });
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
    }

    /**
     * Image Gallery Lightbox (optional enhancement)
     */
    function initLightbox() {
        const galleryItems = document.querySelectorAll(".gallery-item");

        if (galleryItems.length === 0) return;

        // Create lightbox elements
        const overlay = document.createElement("div");
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

        closeBtn.addEventListener("click", closeLightbox);
        prevBtn.addEventListener("click", showPrev);
        nextBtn.addEventListener("click", showNext);

        overlay.addEventListener("click", function (e) {
            if (e.target === overlay) {
                closeLightbox();
            }
        });

        document.addEventListener("keydown", function (e) {
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
    }

    /**
     * Copy Code Blocks
     */
    function initCodeCopy() {
        const codeBlocks = document.querySelectorAll("pre code");

        codeBlocks.forEach(function (code) {
            const pre = code.parentElement;
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

        // Activity listeners
        ["mousemove", "mousedown", "touchstart", "keydown"].forEach((evt) => {
            document.addEventListener(evt, resetIdleTimer, { passive: true });
        });

        // Toggle on background click
        document.addEventListener("click", function (e) {
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
        });

        // Start timer
        resetIdleTimer();
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
            prevBtn.addEventListener("click", (e) => {
                e.stopPropagation(); // Prevent immersive toggle
                goToSlide(currentIndex - 1);
            });
        }

        if (nextBtn) {
            nextBtn.addEventListener("click", (e) => {
                e.stopPropagation(); // Prevent immersive toggle
                goToSlide(currentIndex + 1);
            });
        }

        dots.forEach((dot, index) => {
            dot.addEventListener("click", (e) => {
                e.stopPropagation();
                goToSlide(index);
            });
        });

        // Keyboard navigation
        document.addEventListener("keydown", (e) => {
            if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
                return;

            if (e.key === "ArrowLeft") {
                goToSlide(currentIndex - 1);
            } else if (e.key === "ArrowRight") {
                goToSlide(currentIndex + 1);
            }
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

            // Home or Tags list page (Left/Right)
            // User requested: ArrowLeft -> Next, ArrowRight -> Previous
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
            // User requested: ArrowDown -> Next, ArrowUp -> Previous
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
            // User requested: ArrowDown -> Earlier (Previous Post), ArrowUp -> Later (Next Post)
            const postNavData = document.getElementById('post-nav-data');
            if (postNavData) {
                if (e.key === "ArrowDown") {
                    const prevUrl = postNavData.dataset.prevUrl;
                    if (prevUrl) {
                        e.preventDefault();
                        window.location.href = prevUrl;
                    }
                } else if (e.key === "ArrowUp") {
                    const nextUrl = postNavData.dataset.nextUrl;
                    if (nextUrl) {
                        e.preventDefault();
                        window.location.href = nextUrl;
                    }
                }
            }
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

            card.addEventListener("mouseenter", () => {
                video.play().catch((e) => {});
            });

            card.addEventListener("mouseleave", () => {
                video.pause();
                // Optionally reset to beginning
                // video.currentTime = 0;
            });
        });
    }

    /**
     * Initialize all components
     */
    function init() {
        initImmersiveMode();
        initCarousel();
        initPostCardVideos();

        initDropdowns();
        initLazyLoading();
        initSmoothScroll();
        initBackToTop();
        initReadingProgress();
        initCodeCopy();
        initKeyboardNavigation();

        // Only init lightbox on gallery page
        if (document.querySelector(".gallery-grid")) {
            // Lightbox is optional - uncomment if needed
            // initLightbox();
        }
    }

    // Run on DOM ready
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
