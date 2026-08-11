// Hover logic for dynamic-post-list plugin

let listenersAttached = false;

export function attachHoverEffect() {
    if (listenersAttached) return;
    listenersAttached = true;
    
    document.addEventListener('mouseover', function(e) {
        var card = e.target.closest('.post-card');
        if (!card) return;
        var slot = card.closest('.post-card-slot');
        if (!slot) return;
        
        var grid = slot.closest('.posts-grid');
        if (!grid) return;
        var minTop = Infinity;
        var maxBottom = -Infinity;
        var minLeft = Infinity;
        var maxRight = -Infinity;
        
        var children = grid.children;
        for (var i = 0; i < children.length; i++) {
            var child = children[i];
            if (!child.classList.contains('post-card-slot')) continue;
            var r = child.getBoundingClientRect();
            if (r.top < minTop) minTop = r.top;
            if (r.bottom > maxBottom) maxBottom = r.bottom;
            if (r.left < minLeft) minLeft = r.left;
            if (r.right > maxRight) maxRight = r.right;
        }
        
        var stickyHeaders = document.querySelectorAll('.public-header, .timeline, #timeline-mount');
        var maxStickyBottom = 0;
        for (var j = 0; j < stickyHeaders.length; j++) {
            var headerRect = stickyHeaders[j].getBoundingClientRect();
            if (headerRect.height > 0 && headerRect.bottom > maxStickyBottom && headerRect.bottom < window.innerHeight / 2) {
                maxStickyBottom = headerRect.bottom;
            }
        }
        
        if (minTop < maxStickyBottom) minTop = maxStickyBottom;
        if (maxBottom > window.innerHeight) maxBottom = window.innerHeight;
        
        var contentWidth = maxRight - minLeft;
        var contentHeight = maxBottom - minTop;
        
        var columns = Math.round(contentWidth / slot.offsetWidth);
        var rows = Math.round(contentHeight / slot.offsetHeight);
        
        // Do not scale if 1 card per row or 1 card per col (*x1 or 1x*)
        if (columns <= 1 || rows <= 1) return; 

        
        var scaleFactor = 1.5;
        
        if (!slot.dataset.locked) {
            var rect = slot.getBoundingClientRect();
            slot.style.position = 'relative';
            slot.style.width = rect.width + 'px';
            slot.style.height = rect.height + 'px';
            slot.dataset.locked = 'true';
            
            card.style.transition = 'none';
            card.style.position = 'absolute';
            card.style.top = '0';
            card.style.left = '0';
            card.style.width = '100%';
            card.style.height = '100%';
            card.style.margin = '0';
            
            void card.offsetWidth; // Force reflow
            card.style.transition = '';
        }
        
        slot.style.zIndex = '1000';
        
        var slotWidth = parseFloat(slot.style.width);
        var slotHeight = parseFloat(slot.style.height);
        
        var targetWidth = slotWidth * scaleFactor;
        var targetHeight = slotHeight * scaleFactor;
        
        var translateX = -(targetWidth - slotWidth) / 2;
        var translateY = -(targetHeight - slotHeight) / 2;
        
        var rect = slot.getBoundingClientRect();
        
        if (rect.left - minLeft <= slotWidth * ((scaleFactor - 1) / 2) + 5) translateX = 0;
        else if (maxRight - rect.right <= slotWidth * ((scaleFactor - 1) / 2) + 5) translateX = -(targetWidth - slotWidth);
        
        if (rect.top - minTop <= slotHeight * ((scaleFactor - 1) / 2) + 5) translateY = 0;
        else if (maxBottom - rect.bottom <= slotHeight * ((scaleFactor - 1) / 2) + 5) translateY = -(targetHeight - slotHeight);
        
        card.style.width = (scaleFactor * 100) + '%';
        card.style.height = (scaleFactor * 100) + '%';
        card.style.transform = 'translate(' + translateX + 'px, ' + translateY + 'px)';
        card.style.zIndex = '1000';
        card.dataset.scaled = 'true';
    });
    
    document.addEventListener('mouseout', function(e) {
        var card = e.target.closest('.post-card');
        if (card && card.dataset.scaled === 'true' && !card.contains(e.relatedTarget)) {
            // Do not shrink if a flyout menu is open!
            if (card.classList.contains('has-flyout-open')) return;
            // Or if they moved to a flyout menu directly
            if (e.relatedTarget && e.relatedTarget.closest('.flyout, .post-card-tag-flyout, .tag-family-flyout')) return;
            
            card.style.width = '100%';
            card.style.height = '100%';
            card.style.transform = '';
            // Drop z-index slightly to 900 so it falls behind any newly hovered cards, 
            // but stays above the rest of the grid!
            card.style.zIndex = '900';
            var slot = card.closest('.post-card-slot');
            if (slot) slot.style.zIndex = '900';
        }
    });
    
    // If the flyout closes while the mouse is no longer on the card, we should shrink it.
    // We can detect this with a mutation observer on the document body or just rely on mousemove.
    document.addEventListener('mousemove', function(e) {
        // Failsafe: if a card is scaled, but mouse is far away and no flyout is open, shrink it.
        var scaledCards = document.querySelectorAll('.post-card[data-scaled="true"]');
        for (var i = 0; i < scaledCards.length; i++) {
            var c = scaledCards[i];
            if (!c.classList.contains('has-flyout-open') && !c.contains(e.target)) {
                c.style.width = '100%';
                c.style.height = '100%';
                c.style.transform = '';
                c.style.zIndex = '900';
                var s = c.closest('.post-card-slot');
                if (s) s.style.zIndex = '900';
            }
        }
    });
    
    document.addEventListener('transitionend', function(e) {
        if (e.propertyName === 'width' && e.target.classList.contains('post-card')) {
            if (e.target.style.width === '100%') {
                e.target.style.position = '';
                e.target.style.top = '';
                e.target.style.left = '';
                e.target.style.zIndex = '';
                delete e.target.dataset.scaled;
                var slot = e.target.closest('.post-card-slot');
                if (slot) {
                    slot.style.position = '';
                    slot.style.width = '';
                    slot.style.height = '';
                    slot.style.zIndex = '';
                    delete slot.dataset.locked;
                }
            }
        }
    });
}
